export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    let body;

    try {
        body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = body?.query;

    const cacheKey = "yt_" + query.toLowerCase();

    global.videoCache = global.videoCache || {};

    if (global.videoCache[cacheKey]) {

        console.log("CACHE HIT:", query);

        return res.status(200).json({
            videoId: global.videoCache[cacheKey],
            cached: true
        });
    }

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        const searches = [
            `"${query}" official audio`,
            `"${query}" song`,
            `"${query}" music`,
            query + " official audio"
        ];

        for (const searchTerm of searches) {

            const response = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video`
            );

            const data = await response.json();

            console.log("YOUTUBE SEARCH TERM:", searchTerm);
            console.log("YOUTUBE RESPONSE:", data);

            if (data.error) {
                return res.status(200).json({
                    error: "YouTube API error",
                    details: data.error
                });
            }

            if (data.items && data.items.length > 0) {

                const validVideo = data.items.find(item =>
                    item.id?.videoId &&
                    !item.snippet.channelTitle.toLowerCase().includes("vevo") &&
                    !item.snippet.title.toLowerCase().includes("live") &&
                    !item.snippet.title.toLowerCase().includes("shorts") &&
                    !item.snippet.title.toLowerCase().includes("reaction")
                );

                if (validVideo) {

                    global.videoCache[cacheKey] = validVideo.id.videoId;

                    console.log("CACHE STORE:", query);

                    return res.status(200).json({
                        videoId: validVideo.id.videoId,
                        duration: null,
                        cached: false
                    });
                }
            }
        }

        return res.status(200).json({
            error: "No video found"
        });

    } catch (error) {

        return res.status(500).json({
            error: "Server error",
            details: error.message
        });
    }
}