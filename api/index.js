export default async function handler(req, res) {
    // Check which parameter is used
    const { link, Dlink } = req.query;
    const targetUrl = link || Dlink; // Use whichever is provided
    const isSingleMode = !!Dlink;    // True if user used ?Dlink=

    if (!targetUrl) {
        return res.status(400).json({ error: "Please provide ?link= (Full Mode) or ?Dlink= (Metadata Only)" });
    }

    try {
        // 1. Fetch Jina Text (We always need this to get metadata)
        const jinaUrl = `https://r.jina.ai/${targetUrl}`;
        const jinaResponse = await fetch(jinaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await jinaResponse.text();

        // --- PARSING HELPERS ---

        // Map Image URLs: "Amitabh Bhattacharya" -> "https://..."
        const artistImageMap = {};
        const imageRegex = /!\[Image \d+: (.*?)\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/g;
        let imgMatch;
        while ((imgMatch = imageRegex.exec(text)) !== null) {
            // Clean up name to ensure good matching
            const name = imgMatch[1].trim();
            artistImageMap[name] = imgMatch[2];
        }

        // --- CURRENT SONG PARSING ---

        // Title Extraction
        const titleMatch = text.match(/Title: (.*?)(\n|$)/);
        let rawTitle = titleMatch ? titleMatch[1] : "Unknown";
        
        // "Aayi Nai" (Clean title for search)
        const songTitle = rawTitle.split(' - song')[0].split(' (From')[0].trim(); 
        // "Aayi Nai (From "Stree 2")" (Full title for display)
        const fullTitle = rawTitle.split(' - song')[0].trim(); 

        // Banner Extraction
        const bannerMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const songBanner = bannerMatch ? bannerMatch[1] : "";

        // Artists Extraction
        const contentBeforeRecs = text.split("Recommended Based on this song")[0];
        const artistLinkRegex = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        
        const currentArtists = [];
        const seenArtists = new Set();
        let artistMatches;

        while ((artistMatches = artistLinkRegex.exec(contentBeforeRecs)) !== null) {
            const name = artistMatches[1];
            const url = artistMatches[2];

            // Filter out junk links like "Log in" or "Spotify"
            if (!name.includes("Spotify") && !name.includes("Log in") && !seenArtists.has(name)) {
                seenArtists.add(name);
                currentArtists.push({
                    name: name,
                    spotify_url: url,
                    image: artistImageMap[name] || null 
                });
            }
        }

        // Construct the Basic Data Object
        const currentSongData = {
            title: fullTitle,
            search_title: songTitle,
            banner: songBanner,
            artists: currentArtists
        };

        // --- STOP HERE IF Dlink (Metadata Only) ---
        if (isSingleMode) {
            return res.status(200).json({
                status: "success",
                source_link: targetUrl,
                current_song: currentSongData
            });
        }

        // --- FULL MODE ONLY BELOW THIS LINE ---
        
        // Helper to fetch streams (Only defined and used in Full Mode)
        const getStreamData = async (queryTitle, queryArtists) => {
            try {
                const searchQ = `${queryTitle} ${queryArtists || ""}`;
                const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQ)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.success && data.data.results.length > 0) {
                    return data.data.results[0].downloadUrl;
                }
                return null;
            } catch (e) { return null; }
        };

        // 1. Fetch Stream for Current Song
        const currentStreams = await getStreamData(songTitle, currentArtists.map(a => a.name).join(" "));
        currentSongData.stream_urls = currentStreams || [];

        // 2. Parse Recommendations
        const recSection = text.split("Recommended Based on this song")[1] || "";
        const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;

        let recParams;
        const recommendations = [];

        while ((recParams = recPattern.exec(recSection)) !== null) {
            const rBanner = recParams[1];
            const rTitle = recParams[2];
            const rLink = recParams[3];
            const rRawArtists = recParams[4];
            
            // Extract artist names
            const rArtistMatches = [...rRawArtists.matchAll(/\[([^\]]+)\]/g)];
            const rArtistNames = rArtistMatches.map(m => m[1]).join(", ");

            recommendations.push({
                title: rTitle,
                artist_names: rArtistNames,
                banner: rBanner,
                spotify_link: rLink
            });
        }

        // 3. Fetch Streams for Recommendations
        const recsWithStreams = await Promise.all(recommendations.slice(0, 10).map(async (rec) => {
            const streams = await getStreamData(rec.title, rec.artist_names);
            return { ...rec, stream_urls: streams };
        }));

        // Return Full Response
        return res.status(200).json({
            status: "success",
            source_link: targetUrl,
            current_song: currentSongData,
            recommendations: recsWithStreams
        });

    } catch (error) {
        return res.status(500).json({ error: "Failed to process", details: error.message });
    }
}
