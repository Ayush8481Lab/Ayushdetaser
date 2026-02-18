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

        // A. Extract Current Song Details
        // Regex looks for the Main Title and the Main Image at the top
        const mainImageMatch = text.match(/!\[Image \d+:.*?\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)/);
        const mainTitleMatch = text.match(/Title: (.*?)(\n|$)/);
        
        // Extract Artists (Finding lines like [Name](link))
        const artistPattern = /\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/artist\/[^)]+)\)/g;
        const allLinks = [...text.matchAll(artistPattern)];
        
        // We assume the first few artists mentioned after the title are the main artists
        // This is a heuristic, we take unique artists from the start
        let currentArtists = [];
        const seenArtists = new Set();
        
        for (let i = 0; i < 5; i++) { // Check first 5 matches usually main artists
            if (allLinks[i]) {
                const name = allLinks[i][1];
                const url = allLinks[i][2];
                if (!seenArtists.has(name) && !name.includes("Spotify") && !name.includes("Log in")) {
                    seenArtists.add(name);
                    currentArtists.push({ name, url });
                }
            }
        }

        const currentSong = {
            title: mainTitleMatch ? mainTitleMatch[1].replace(' - song and lyrics by', '').split(' (From')[0].trim() : "Unknown",
            full_title: mainTitleMatch ? mainTitleMatch[1] : "",
            banner: mainImageMatch ? mainImageMatch[1] : "",
            artists: currentArtists,
            spotify_link: link
        };

        // B. Extract Recommendations
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

            // Extract artists from the raw text block
            const recArtistMatches = [...rawRecArtists.matchAll(/\[([^\]]+)\]/g)];
            const recArtistNames = recArtistMatches.map(m => m[1]).join(", ");

            recommendations.push({
                title: recTitle,
                artist_names: recArtistNames,
                banner: recBanner,
                spotify_link: recLink
            });
        }

        // 2. Fetch Stream Links (Parallel Processing for Speed)
        // We define a helper function to call the external API
        const fetchStream = async (songName, artistName) => {
            try {
                const query = `${songName} ${artistName}`;
                const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(query)}`;
                const resp = await fetch(apiUrl);
                const data = await resp.json();

                if (data.success && data.data.results.length > 0) {
                    // Return the first match's download URLs
                    return data.data.results[0].downloadUrl;
                }
                return null;
            } catch (e) {
                return null;
            }
        };

        // Get Stream for Current Song
        const currentStreamData = await fetchStream(currentSong.title, currentSong.artists.map(a => a.name).join(" "));
        currentSong.stream_links = currentStreamData || "Not Found";

        // Get Streams for Recommendations (Limit to first 10 to be safe)
        const recsToProcess = recommendations.slice(0, 10);
        
        // Use Promise.all to fetch them all at the same time (fast)
        const recsWithStreams = await Promise.all(recsToProcess.map(async (rec) => {
            const streams = await fetchStream(rec.title, rec.artist_names);
            return {
                ...rec,
                stream_links: streams || "Not Found"
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
