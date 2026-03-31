export default async function handler(req, res) {
    // Parameters:
    // link: The Spotify URL
    // mode: 'rec_meta' | 'single' | 'full' (default)
    const { link, mode = 'full' } = req.query;

    if (!link) {
        return res.status(400).json({ 
            error: "Missing link", 
            usage: "?link=SPOTIFY_URL&mode=single (or rec_meta, full)" 
        });
    }

    // --- ENHANCED TITLE CLEANING FOR BETTER MATCHING ---
    const cleanSongTitle = (title) => {
        if (!title) return "";
        let clean = title.split(/\s*[-–—]\s*/)[0]; // Removes "- From...", "- Zee Music", etc.
        clean = clean.replace(/\s*\(.*?\)/g, '');  // Removes text in parentheses e.g. (feat. XYZ)
        clean = clean.replace(/\s*\[.*?\]/g, '');  // Removes text in brackets
        clean = clean.split(/\s+by\s+/i)[0];       // Removes "by Artist" from title
        return clean.trim();
    };

    try {
        // 1. Scrape Metadata via Jina
        const jinaUrl = `https://r.jina.ai/${link}`;
        const jinaResponse = await fetch(jinaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await jinaResponse.text();

        // --- PARSING LOGIC ---

        // Map Image URLs
        const artistImageMap = {};
        const imageRegex = /!\[Image \d+: (.*?)\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/g;
        let imgMatch;
        while ((imgMatch = imageRegex.exec(text)) !== null) {
            artistImageMap[imgMatch[1].trim()] = imgMatch[2];
        }

        // Parse Current Song
        const titleMatch = text.match(/Title: (.*?)(\n|$)/);
        let rawTitle = titleMatch ? titleMatch[1] : "Unknown";
        const cleanTitle = cleanSongTitle(rawTitle); 
        const displayTitle = rawTitle.split(' - song')[0].trim();

        // Parse Banner
        const bannerMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const songBanner = bannerMatch ? bannerMatch[1] : "";

        // Parse Artists
        const contentBeforeRecs = text.split("Recommended Based on this song")[0];
        const artistLinkRegex = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        const currentArtists =[];
        const seenArtists = new Set();
        let artistMatches;

        while ((artistMatches = artistLinkRegex.exec(contentBeforeRecs)) !== null) {
            const name = artistMatches[1];
            const url = artistMatches[2];
            if (!name.includes("Spotify") && !name.includes("Log in") && !seenArtists.has(name)) {
                seenArtists.add(name);
                currentArtists.push({
                    name: name,
                    spotify_url: url,
                    image: artistImageMap[name] || null 
                });
            }
        }

        // Prepare Recommendation Object
        let recommendations =[];
        if (mode === 'rec_meta' || mode === 'full') {
            const recSection = text.split("Recommended Based on this song")[1] || "";
            const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;
            let recParams;
            
            while ((recParams = recPattern.exec(recSection)) !== null) {
                const rRawArtists = recParams[4];
                
                // 1st Attempt: Try to get artists from markdown links
                let rArtistMatches = [...rRawArtists.matchAll(/\[([^\]]+)\]\([^)]+\)/g)];
                let artistNames = rArtistMatches
                    .map(m => m[1])
                    .filter(n => !n.includes("Spotify") && !n.includes("Log in"))
                    .join(", ");
                
                // 2nd Attempt: If no links found, extract plain text directly (Fixes empty artist bug)
                if (!artistNames) {
                    const plainText = rRawArtists.replace(/https?:\/\/[^\s]+/g, '').replace(/[\[\]()]/g, '').trim();
                    artistNames = plainText.split('\n').filter(Boolean)[0]?.trim() || "Unknown";
                }

                recommendations.push({
                    title: recParams[2],
                    artist_names: artistNames,
                    banner: recParams[1],
                    spotify_link: recParams[3],
                    _clean_title: cleanSongTitle(recParams[2]) // Internal use for accurate searching
                });
            }
        }

        // --- STREAM FETCHING WITH DEEP MATCHING ---
        const fetchStreamWithRetry = async (songTitle, artistName, retries = 3) => {
            // Pick a robust single search keyword for the artist, ignoring "Unknown"
            let primaryArtist = "";
            if (artistName && artistName !== "Unknown") {
                primaryArtist = artistName.split(',')[0].trim().split(' ')[0]; 
            }
            
            const searchQuery = `${songTitle} ${primaryArtist}`.trim();
            const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQuery)}`;

            for (let i = 0; i < retries; i++) {
                try {
                    const res = await fetch(apiUrl);
                    if (!res.ok) throw new Error("API Fail");
                    const data = await res.json();
                    
                    if (data.success && data.data.results && data.data.results.length > 0) {
                        
                        // --- SMART MATCHING LOGIC ---
                        const lowerSearchTitle = songTitle.toLowerCase();
                        
                        // Look for a close string match to filter out wrong Search API results
                        let bestMatch = data.data.results.find(track => {
                            const tName = track.name.toLowerCase();
                            return tName === lowerSearchTitle || 
                                   tName.includes(lowerSearchTitle) || 
                                   lowerSearchTitle.includes(tName);
                        });

                        // Fallback to top result if fuzzy match failed but API thought it was relevant
                        if (!bestMatch) bestMatch = data.data.results[0];

                        return {
                            jiosaavn_link: bestMatch.url || null,
                            stream_urls: bestMatch.downloadUrl ||[]
                        };
                    }
                } catch (e) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            return { jiosaavn_link: null, stream_urls:[] }; // Failed
        };

        // --- HANDLE MODES ---

        if (mode === 'rec_meta') {
            return res.status(200).json({
                status: "success",
                mode: "rec_meta",
                current_song: { title: displayTitle, banner: songBanner, artists: currentArtists },
                recommendations: recommendations.map(({ _clean_title, ...rest }) => rest)
            });
        }

        if (mode === 'single') {
            const currentAudioData = await fetchStreamWithRetry(cleanTitle, currentArtists.map(a => a.name).join(", "));
            return res.status(200).json({
                status: "success",
                mode: "single",
                current_song: {
                    title: displayTitle,
                    banner: songBanner,
                    artists: currentArtists,
                    jiosaavn_link: currentAudioData.jiosaavn_link,
                    stream_urls: currentAudioData.stream_urls
                }
            });
        }

        // FULL MODE (Current + 10 Recommendations with URLs)
        const currentStreamPromise = fetchStreamWithRetry(cleanTitle, currentArtists.map(a => a.name).join(", "));
        
        const recStreamPromises = recommendations.slice(0, 10).map(async (rec) => {
            const searchRes = await fetchStreamWithRetry(rec._clean_title, rec.artist_names);
            
            // Remove the internal `_clean_title` before mapping the response
            const { _clean_title, ...rest } = rec;
            
            return { 
                ...rest, 
                jiosaavn_link: searchRes.jiosaavn_link,
                stream_urls: searchRes.stream_urls 
            };
        });

        const [currentAudioData, ...recsWithStreams] = await Promise.all([
            currentStreamPromise,
            ...recStreamPromises
        ]);

        return res.status(200).json({
            status: "success",
            mode: "full",
            current_song: {
                title: displayTitle,
                banner: songBanner,
                artists: currentArtists,
                jiosaavn_link: currentAudioData.jiosaavn_link,
                stream_urls: currentAudioData.stream_urls
            },
            recommendations: recsWithStreams
        });

    } catch (error) {
        return res.status(500).json({ error: "Server Error", details: error.message });
    }
}
