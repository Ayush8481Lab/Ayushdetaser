export default async function handler(req, res) {
    const { link } = req.query;

    if (!link) {
        return res.status(400).json({ error: "Please provide a Spotify track link using ?link=..." });
    }

    try {
        // 1. Fetch the Page as Text via Jina
        const jinaUrl = `https://r.jina.ai/${link}`;
        const jinaResponse = await fetch(jinaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await jinaResponse.text();

        // --- HELPER FUNCTIONS ---

        // A. Extract all images first to map Artist Names to their Images
        const artistImageMap = {};
        const imageRegex = /!\[Image \d+: (.*?)\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/g;
        let imgMatch;
        while ((imgMatch = imageRegex.exec(text)) !== null) {
            // Map "Amitabh Bhattacharya" -> "https://..."
            artistImageMap[imgMatch[1].trim()] = imgMatch[2];
        }

        // B. Function to clean text
        const cleanText = (str) => str.replace(/\[|\]/g, '').trim();

        // --- PARSING CURRENT SONG ---

        // 1. Title
        const titleMatch = text.match(/Title: (.*?)(\n|$)/);
        let rawTitle = titleMatch ? titleMatch[1] : "Unknown";
        // Clean title (remove " - song and lyrics by...")
        const songTitle = rawTitle.split(' - song')[0].split(' (From')[0].trim();
        const fullTitle = rawTitle.split(' - song')[0].trim();

        // 2. Main Banner
        // Usually the first image in the document or specific Main content image
        const bannerMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const songBanner = bannerMatch ? bannerMatch[1] : "";

        // 3. Current Artists
        // We look for links that are labeled as "Artist" or appear before recommendations
        const contentBeforeRecs = text.split("Recommended Based on this song")[0];
        // Regex to find [Name](SpotifyLink)
        const artistLinkRegex = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        
        let artistMatches;
        const currentArtists = [];
        const seenArtists = new Set();

        while ((artistMatches = artistLinkRegex.exec(contentBeforeRecs)) !== null) {
            const name = artistMatches[1];
            const url = artistMatches[2];

            // Filter out generic links
            if (!name.includes("Spotify") && !name.includes("Log in") && !seenArtists.has(name)) {
                seenArtists.add(name);
                currentArtists.push({
                    name: name,
                    spotify_url: url,
                    image: artistImageMap[name] || null // Look up image we found earlier
                });
            }
        }

        // --- PARSING RECOMMENDATIONS ---

        const recSection = text.split("Recommended Based on this song")[1] || "";
        // Pattern: Image -> Title -> Link -> Artists
        const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;

        let recParams;
        const recommendations = [];

        while ((recParams = recPattern.exec(recSection)) !== null) {
            const rBanner = recParams[1];
            const rTitle = recParams[2];
            const rLink = recParams[3];
            const rRawArtists = recParams[4];

            // Extract artist names from the raw block
            const rArtistMatches = [...rRawArtists.matchAll(/\[([^\]]+)\]/g)];
            const rArtistNames = rArtistMatches.map(m => m[1]).join(", ");

            recommendations.push({
                title: rTitle,
                artist_names: rArtistNames,
                banner: rBanner,
                spotify_link: rLink
            });
        }

        // --- FETCHING STREAM LINKS (THE IMPORTANT PART) ---

        // Helper function to call external API
        const getStreamData = async (queryTitle, queryArtists) => {
            try {
                // Construct query: "SongName ArtistName"
                const searchQ = `${queryTitle} ${queryArtists || ""}`;
                const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQ)}`;
                
                const response = await fetch(apiUrl);
                const data = await response.json();

                if (data.success && data.data.results.length > 0) {
                    // We take the first result as the best match
                    return data.data.results[0].downloadUrl; // This is the array [12kbps, 320kbps, etc]
                }
                return null;
            } catch (e) {
                return null;
            }
        };

        // 1. Get Stream for CURRENT SONG
        // We use Promise.all to fetch current song and recommendations in parallel (faster)
        const currentStreamPromise = getStreamData(songTitle, currentArtists.map(a => a.name).join(" "));
        
        // 2. Get Streams for RECOMMENDATIONS (Limit to 10)
        const recsPromises = recommendations.slice(0, 10).map(async (rec) => {
            const streams = await getStreamData(rec.title, rec.artist_names);
            return { ...rec, stream_urls: streams };
        });

        // Wait for everything to finish
        const [currentStreams, ...recsWithStreams] = await Promise.all([
            currentStreamPromise,
            ...recsPromises
        ]);

        // --- FINAL RESPONSE ---

        return res.status(200).json({
            status: "success",
            source_link: link,
            current_song: {
                title: fullTitle,
                search_title: songTitle, // The cleaned title used for search
                banner: songBanner,
                artists: currentArtists,
                spotify_link: link,
                stream_urls: currentStreams || [] // HERE IS YOUR STREAM DATA
            },
            recommendations: recsWithStreams
        });

    } catch (error) {
        return res.status(500).json({ error: "Failed to process", details: error.message });
    }
            }
