export default async function handler(req, res) {
    const { link } = req.query;

    if (!link) {
        return res.status(400).json({ 
            error: "Missing link", 
            usage: "?link=SPOTIFY_URL" 
        });
    }

    // --- 1. ENHANCED STRING NORMALIZATION & CLEANING ---
    const cleanSongTitle = (title) => {
        if (!title) return "";
        let clean = title.split(/\s*[-–—]\s*/)[0]; // Removes "- From...", "- Zee Music", etc.
        clean = clean.replace(/\s*\(.*?\)/g, '');  // Removes text in parentheses e.g. (feat. XYZ)
        clean = clean.replace(/\s*\[.*?\]/g, '');  // Removes text in brackets
        clean = clean.split(/\s+by\s+/i)[0];       // Removes "by Artist" from title
        return clean.trim();
    };

    const getWords = (str) => {
        return str.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '') // Remove special characters
            .split(/\s+/)
            .filter(w => w.length > 2);  // Keep words longer than 2 letters (ignores a, in, is, etc.)
    };

    // --- 2. DEEP MATCHING ALGORITHM ---
    const isConfidentMatch = (spotifyTitle, spotifyArtists, jioTrack) => {
        const cleanSpTitle = cleanSongTitle(spotifyTitle);
        const cleanJioTitle = cleanSongTitle(jioTrack.name);

        const spWords = getWords(cleanSpTitle);
        const jioWords = getWords(cleanJioTitle);

        // Check 1: Word Intersection for Title (Handles Choti vs Chhoti spelling differences)
        const matchedTitleWords = spWords.filter(w => jioWords.some(jw => jw.includes(w) || w.includes(jw)));
        const titleMatchRatio = spWords.length > 0 ? (matchedTitleWords.length / spWords.length) : 0;
        
        // If titles are identical strings, automatic title pass
        const exactTitleMatch = cleanSpTitle.toLowerCase() === cleanJioTitle.toLowerCase() || 
                                cleanSpTitle.toLowerCase().includes(cleanJioTitle.toLowerCase()) || 
                                cleanJioTitle.toLowerCase().includes(cleanSpTitle.toLowerCase());

        const isTitleValid = exactTitleMatch || titleMatchRatio >= 0.5; // At least 50% core words match

        // Check 2: Artist Matching
        const spArtistsArr = spotifyArtists.split(',').map(a => a.toLowerCase().trim());
        const jioArtistsArr = jioTrack.artists.all.map(a => a.name.toLowerCase().trim());

        let isArtistValid = false;
        for (const spArtist of spArtistsArr) {
            // Check if any Spotify artist shares a significant name with a JioSaavn artist
            if (jioArtistsArr.some(ja => ja.includes(spArtist) || spArtist.includes(ja))) {
                isArtistValid = true;
                break;
            }
        }

        // Must pass BOTH title and artist checks to prevent mismatches
        return isTitleValid && isArtistValid;
    };

    try {
        // --- 3. SCRAPE SPOTIFY VIA JINA ---
        const jinaUrl = `https://r.jina.ai/${link}`;
        const jinaResponse = await fetch(jinaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await jinaResponse.text();

        // Extract Recommendation Section Only
        const recSection = text.split("Recommended Based on this song")[1] || "";
        const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;
        
        let rawRecommendations = [];
        let recParams;
        
        while ((recParams = recPattern.exec(recSection)) !== null) {
            const rRawArtists = recParams[4];
            
            // Extract Artists gracefully
            let rArtistMatches =[...rRawArtists.matchAll(/\[([^\]]+)\]\([^)]+\)/g)];
            let artistNames = rArtistMatches
                .map(m => m[1])
                .filter(n => !n.includes("Spotify") && !n.includes("Log in"))
                .join(", ");
            
            if (!artistNames) {
                const plainText = rRawArtists.replace(/https?:\/\/[^\s]+/g, '').replace(/[\[\]()]/g, '').trim();
                artistNames = plainText.split('\n').filter(Boolean)[0]?.trim() || "Unknown";
            }

            rawRecommendations.push({
                title: recParams[2],
                artist: artistNames,
                banner_link: recParams[1],
                spotify_link: recParams[3],
                _clean_title: cleanSongTitle(recParams[2]) // Used for JioSaavn API Query
            });
        }

        // --- 4. FETCH STREAMS & FILTER MISMATCHES ---
        const fetchStreamWithRetry = async (rec, retries = 3) => {
            const primaryArtist = rec.artist !== "Unknown" ? rec.artist.split(',')[0].trim().split(' ')[0] : "";
            const searchQuery = `${rec._clean_title} ${primaryArtist}`.trim();
            const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQuery)}`;

            for (let i = 0; i < retries; i++) {
                try {
                    const res = await fetch(apiUrl);
                    if (!res.ok) throw new Error("API Fail");
                    const data = await res.json();
                    
                    if (data.success && data.data.results && data.data.results.length > 0) {
                        
                        // Look for a strict match in the search results
                        let verifiedTrack = null;
                        for (const track of data.data.results) {
                            if (isConfidentMatch(rec.title, rec.artist, track)) {
                                verifiedTrack = track;
                                break;
                            }
                        }

                        // If no confident match is found, reject this recommendation
                        if (!verifiedTrack) return null;

                        // Extract exclusively the 320kbps stream URL
                        const highQualityStream = verifiedTrack.downloadUrl.find(q => q.quality === '320kbps');
                        
                        // Fallback to highest available if 320kbps doesn't explicitly exist (extremely rare but safe)
                        const streamUrl = highQualityStream ? highQualityStream.url : verifiedTrack.downloadUrl[verifiedTrack.downloadUrl.length - 1]?.url;

                        return {
                            title: rec.title,
                            artist: rec.artist,
                            banner_link: rec.banner_link,
                            spotify_link: rec.spotify_link,
                            jiosaavn_link: verifiedTrack.url,
                            stream_url: streamUrl
                        };
                    }
                } catch (e) {
                    await new Promise(r => setTimeout(r, 500)); // Delay between retries
                }
            }
            return null; // Failed or completely mismatched
        };

        // Fetch streams concurrently for top 10 recommendations
        const recStreamPromises = rawRecommendations.slice(0, 10).map(rec => fetchStreamWithRetry(rec));
        const processedRecommendations = await Promise.all(recStreamPromises);

        // Filter out the nulls (mismatched or failed tracks)
        const finalRecommendations = processedRecommendations.filter(rec => rec !== null);

        // --- 5. FINAL CLEAN RESPONSE ---
        return res.status(200).json({
            status: "success",
            recommendations: finalRecommendations
        });

    } catch (error) {
        return res.status(500).json({ error: "Server Error", details: error.message });
    }
}
