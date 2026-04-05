// Helper for fetching with an aggressive timeout to prevent latency spikes
const fetchWithTimeout = async (url, options = {}, timeoutMs = 4000) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
};

export default async function handler(req, res) {
    // --- CORS CONFIGURATION ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle CORS Preflight request instantly
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

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
        let clean = title.split(/\s*[-–—]\s*/)[0]; 
        clean = clean.replace(/\s*\(.*?\)/g, '');  
        clean = clean.replace(/\s*\[.*?\]/g, '');  
        clean = clean.split(/\s+by\s+/i)[0];       
        return clean.trim();
    };

    const getWords = (str) => {
        return str.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '') 
            .split(/\s+/)
            .filter(w => w.length > 2);  
    };

    // --- 2. DEEP MATCHING ALGORITHM ---
    const isConfidentMatch = (spotifyTitle, spotifyArtists, jioTrack) => {
        const cleanSpTitle = cleanSongTitle(spotifyTitle);
        const cleanJioTitle = cleanSongTitle(jioTrack.name);

        const spWords = getWords(cleanSpTitle);
        const jioWords = getWords(cleanJioTitle);

        const matchedTitleWords = spWords.filter(w => jioWords.some(jw => jw.includes(w) || w.includes(jw)));
        const titleMatchRatio = spWords.length > 0 ? (matchedTitleWords.length / spWords.length) : 0;
        
        const exactTitleMatch = cleanSpTitle.toLowerCase() === cleanJioTitle.toLowerCase() || 
                                cleanSpTitle.toLowerCase().includes(cleanJioTitle.toLowerCase()) || 
                                cleanJioTitle.toLowerCase().includes(cleanSpTitle.toLowerCase());

        const isTitleValid = exactTitleMatch || titleMatchRatio >= 0.5; 

        const spArtistsArr = spotifyArtists.split(',').map(a => a.toLowerCase().trim());
        const jioArtistsArr = jioTrack.artists.all.map(a => a.name.toLowerCase().trim());

        let isArtistValid = false;
        for (const spArtist of spArtistsArr) {
            if (jioArtistsArr.some(ja => ja.includes(spArtist) || spArtist.includes(ja))) {
                isArtistValid = true;
                break;
            }
        }

        return isTitleValid && isArtistValid;
    };

    try {
        // --- 3. SCRAPE SPOTIFY VIA JINA (With 8s Timeout) ---
        const jinaUrl = `https://r.jina.ai/${link}`;
        
        // Added Timeout: Don't let Jina hang your server indefinitely
        const jinaResponse = await fetchWithTimeout(jinaUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        }, 8000); 
        
        const text = await jinaResponse.text();

        // Extract Recommendation Section Only
        const recSection = text.split("Recommended Based on this song")[1] || "";
        const recPattern = /!\[Image \d+\]\((https:\/\/i\.scdn\.co\/image\/[^)]+)\)\s*\n\s*\[([^\]]+)\]\((https:\/\/open\.spotify\.com\/track\/[^)]+)\)((?:.|\n)*?)(?=\n\n|\n!\[)/g;
        
        let rawRecommendations = [];
        let recParams;
        
        // Extract up to exactly 10 to save CPU regex cycles
        while ((recParams = recPattern.exec(recSection)) !== null && rawRecommendations.length < 10) {
            const rRawArtists = recParams[4];
            
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
                _clean_title: cleanSongTitle(recParams[2]) 
            });
        }

        // --- 4. FAST FETCH STREAMS & FILTER MISMATCHES ---
        // Changed retries to 2 to prioritize latency over exhaustive fetching
        const fetchStreamWithRetry = async (rec, retries = 2) => {
            const primaryArtist = rec.artist !== "Unknown" ? rec.artist.split(',')[0].trim().split(' ')[0] : "";
            const searchQuery = `${rec._clean_title} ${primaryArtist}`.trim();
            const apiUrl = `https://ayushm-psi.vercel.app/api/search/songs?query=${encodeURIComponent(searchQuery)}`;

            for (let i = 0; i < retries; i++) {
                try {
                    // Added 3.5s Timeout per track. Prevents single stuck API call from freezing Promise.all
                    const res = await fetchWithTimeout(apiUrl, {}, 3500);
                    if (!res.ok) throw new Error("API Fail");
                    
                    const data = await res.json();
                    
                    if (data.success && data.data.results && data.data.results.length > 0) {
                        let verifiedTrack = null;
                        for (const track of data.data.results) {
                            if (isConfidentMatch(rec.title, rec.artist, track)) {
                                verifiedTrack = track;
                                break;
                            }
                        }

                        if (!verifiedTrack) return null;

                        const highQualityStream = verifiedTrack.downloadUrl.find(q => q.quality === '320kbps');
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
                    // Lowered wait time between retries to 150ms to speed up recovery
                    if (i < retries - 1) {
                        await new Promise(r => setTimeout(r, 150)); 
                    }
                }
            }
            return null; 
        };

        // Fetch streams concurrently (Already optimal for latency)
        const recStreamPromises = rawRecommendations.map(rec => fetchStreamWithRetry(rec));
        const processedRecommendations = await Promise.all(recStreamPromises);

        const finalRecommendations = processedRecommendations.filter(rec => rec !== null);

        // --- 5. FINAL CLEAN RESPONSE ---
        return res.status(200).json({
            status: "success",
            recommendations: finalRecommendations
        });

    } catch (error) {
        // Specifically handle Timeout Aborts
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: "Upstream API timed out while fetching data." });
        }
        return res.status(500).json({ error: "Server Error", details: error.message });
    }
}
