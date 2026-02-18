export default async function handler(req, res) {
    const { link } = req.query;

    if (!link) {
        return res.status(400).json({ error: "Please provide a Spotify track link using ?link=..." });
    }

    try {
        // 1. Scrape Spotify Data via Jina
        const jinaUrl = `https://r.jina.ai/${link}`;
        const jinaResponse = await fetch(jinaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const text = await jinaResponse.text();

        // --- PARSING LOGIC ---

        // A. Helper to find Artist Images
        // Scans the text for ![Image 91: Artist Name](Image URL)
        const extractArtistImage = (artistName) => {
            const regex = new RegExp(`!\\[Image \\d+: ${escapeRegExp(artistName)}\\]\\((https:\\/\\/i\\.scdn\\.co\\/image\\/[^)]+)\\)`);
            const match = text.match(regex);
            return match ? match[1] : null;
        };

        function escapeRegExp(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        // B. Extract Current Song Details
        const mainImageMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const mainTitleMatch = text.match(/Title: (.*?)(\n|$)/);
        
        // Find lines that look like: Artist[Name](Link)
        // This is safer than the previous method because it looks for the "Artist" tag
        const artistSectionRegex = /Artist\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        let artistMatch;
        const currentArtists = [];
        const seenArtists = new Set();

        while ((artistMatch = artistSectionRegex.exec(text)) !== null) {
            const name = artistMatch[1];
            const url = artistMatch[2];

            if (!seenArtists.has(name)) {
                seenArtists.add(name);
                currentArtists.push({
                    name: name,
                    spotify_url: url,
                    image_url: extractArtistImage(name) // Get the image we found earlier
                });
            }
        }

        // Fallback: If "Artist[Name]" pattern fails, try generic links near the top
        if (currentArtists.length === 0) {
            const fallbackRegex = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
            let fallbackMatch;
            let count = 0;
            while ((fallbackMatch = fallbackRegex.exec(text)) !== null && count < 3) {
                const name = fallbackMatch[1];
                if (!name.includes("Spotify") && !seenArtists.has(name)) {
                    seenArtists.add(name);
                    currentArtists.push({
                        name: name,
                        spotify_url: fallbackMatch[2],
                        image_url: extractArtistImage(name)
                    });
                    count++;
                }
            }
        }

        const currentSong = {
            title: mainTitleMatch ? mainTitleMatch[1].replace(' - song and lyrics by', '').split(' (From')[0].trim() : "Unknown",
            full_title: mainTitleMatch ? mainTitleMatch[1] : "",
            banner: mainImageMatch ? mainImageMatch[1] : "",
            artists: currentArtists, // Now contains image_url
            spotify_link: link
        };

        // C. Extract Recommendations
        // We look for the section "Recommended Based on this song"
        const recSection = text.split("Recommended Based on this song")[1] || "";
        const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;

        let recMatches;
        let recommendations = [];

        while ((recMatches = recPattern.exec(recSection)) !== null) {
            const recBanner = recMatches[1];
            const recTitle = recMatches[2];
            const recLink = recMatches[3];
            const rawRecArtists = recMatches[4];

            // Extract artists names from the block
            const recArtistMatches = [...rawRecArtists.matchAll(/\[([^\]]+)\]/g)];
            const recArtistNames = recArtistMatches.map(m => m[1]).join(", ");

            recommendations.push({
                title: recTitle,
                artist_names: recArtistNames,
                banner: recBanner,
                spotify_link: recLink
            });
        }

        // 2. Fetch Stream Links (External API)
        const fetchStream = async (songName, artistName) => {
            try {
                // Remove special chars for better search matching
                const cleanSong = songName.replace(/[()]/g, '');
                const query = `${cleanSong} ${artistName}`;
                
                const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(query)}`;
                const resp = await fetch(apiUrl);
                const data = await resp.json();

                if (data.success && data.data.results.length > 0) {
                    // Try to find an exact match first, otherwise return the first result
                    const exactMatch = data.data.results.find(r => 
                        r.name.toLowerCase().includes(songName.toLowerCase().split(' (')[0])
                    );
                    
                    const bestResult = exactMatch || data.data.results[0];

                    return {
                        found: true,
                        match_name: bestResult.name,
                        quality: bestResult.downloadUrl // Returns array of 12kbps to 320kbps
                    };
                }
                return { found: false, error: "Not found" };
            } catch (e) {
                return { found: false, error: "API Error" };
            }
        };

        // Get Stream for Current Song
        const currentStreamData = await fetchStream(currentSong.title, currentSong.artists.map(a => a.name).join(" "));
        currentSong.stream_info = currentStreamData;

        // Get Streams for Recommendations (Limit to first 8 for speed)
        const recsToProcess = recommendations.slice(0, 8);
        
        const recsWithStreams = await Promise.all(recsToProcess.map(async (rec) => {
            const streamData = await fetchStream(rec.title, rec.artist_names);
            return {
                ...rec,
                stream_info: streamData
            };
        }));

        // 3. Return Final JSON
        return res.status(200).json({
            status: "success",
            source_link: link,
            current_song: currentSong,
            recommendations: recsWithStreams
        });

    } catch (error) {
        return res.status(500).json({ error: "Something went wrong", details: error.message });
    }
                                     }
