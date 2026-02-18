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
        // Clean Title: "Aayi Nai (From "Stree 2")" -> "Aayi Nai"
        const cleanTitle = rawTitle.split(' - song')[0].split(' (From')[0].split(' (feat')[0].trim(); 
        const displayTitle = rawTitle.split(' - song')[0].trim();

        // Parse Banner
        const bannerMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const songBanner = bannerMatch ? bannerMatch[1] : "";

        // Parse Artists
        const contentBeforeRecs = text.split("Recommended Based on this song")[0];
        const artistLinkRegex = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        const currentArtists = [];
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

        // Prepare Recommendation Object (We only fill this if needed)
        let recommendations = [];
        if (mode === 'rec_meta' || mode === 'full') {
            const recSection = text.split("Recommended Based on this song")[1] || "";
            const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;
            let recParams;
            while ((recParams = recPattern.exec(recSection)) !== null) {
                const rRawArtists = recParams[4];
                const rArtistMatches = [...rRawArtists.matchAll(/\[([^\]]+)\]/g)];
                
                recommendations.push({
                    title: recParams[2],
                    artist_names: rArtistMatches.map(m => m[1]).join(", "),
                    banner: recParams[1],
                    spotify_link: recParams[3]
                });
            }
        }

        // --- STREAM FETCHING WITH RETRY & MATCHING ---

        const fetchStreamWithRetry = async (songName, artistName, retries = 3) => {
            const primaryArtist = artistName.split(',')[0].split(' ')[0]; // First word of first artist for better search
            const searchQuery = `${songName} ${primaryArtist}`;
            const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQuery)}`;

            for (let i = 0; i < retries; i++) {
                try {
                    const res = await fetch(apiUrl);
                    if (!res.ok) throw new Error("API Fail");
                    const data = await res.json();
                    
                    if (data.success && data.data.results.length > 0) {
                        // --- SMART MATCHING LOGIC ---
                        // 1. Filter results to find one that matches the title closely
                        const lowerTitle = songName.toLowerCase();
                        
                        // Try to find exact match
                        const bestMatch = data.data.results.find(track => {
                            const tName = track.name.toLowerCase();
                            return tName.includes(lowerTitle) || lowerTitle.includes(tName);
                        });

                        // Return best match or the first result if fuzzy match failed
                        return (bestMatch || data.data.results[0]).downloadUrl;
                    }
                } catch (e) {
                    // Wait 500ms before retrying
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            return null; // Failed after 3 retries
        };

        // --- HANDLE MODES ---

        // MODE 1: Recommendation Metadata Only (No Streams)
        if (mode === 'rec_meta') {
            return res.status(200).json({
                status: "success",
                mode: "rec_meta",
                current_song: {
                    title: displayTitle,
                    banner: songBanner,
                    artists: currentArtists
                },
                recommendations: recommendations // Just metadata
            });
        }

        // MODE 2: Single Song Stream (No Recs)
        if (mode === 'single') {
            const streamLinks = await fetchStreamWithRetry(cleanTitle, currentArtists.map(a => a.name).join(", "));
            return res.status(200).json({
                status: "success",
                mode: "single",
                current_song: {
                    title: displayTitle,
                    banner: songBanner,
                    artists: currentArtists,
                    stream_urls: streamLinks || []
                }
            });
        }

        // MODE 3: Full (Everything)
        // Fetch current song stream
        const currentStreamPromise = fetchStreamWithRetry(cleanTitle, currentArtists.map(a => a.name).join(", "));
        
        // Fetch Rec streams (Limit 10)
        const recStreamPromises = recommendations.slice(0, 10).map(async (rec) => {
            const streams = await fetchStreamWithRetry(rec.title, rec.artist_names);
            return { ...rec, stream_urls: streams || [] };
        });

        const [currentStreams, ...recsWithStreams] = await Promise.all([
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
                stream_urls: currentStreams || []
            },
            recommendations: recsWithStreams
        });

    } catch (error) {
        return res.status(500).json({ error: "Server Error", details: error.message });
    }
        }
