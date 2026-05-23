export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    let body;

    try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: "Invalid JSON body" });
    }

    const query = body?.query;

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    const normalizedQuery = query
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const cacheKey = "yt_" + normalizedQuery;

    global.videoCache = global.videoCache || {};
    global.videoMissCache = global.videoMissCache || {};
    global.youtubeCooldownUntil = global.youtubeCooldownUntil || 0;

    if (global.videoCache[cacheKey]) {
        console.log("CACHE HIT:", query);

        return res.status(200).json({
            videoId: global.videoCache[cacheKey],
            cached: true
        });
    }

    if (global.videoMissCache[cacheKey]) {
        console.log("MISS CACHE HIT:", query);

        return res.status(200).json({
            error: "Preview unavailable",
            cachedMiss: true
        });
    }

    if (Date.now() < global.youtubeCooldownUntil) {
        console.log("YOUTUBE COOLDOWN ACTIVE");

        return res.status(200).json({
            error: "YouTube preview temporarily limited",
            cooldown: true
        });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        const searchTerm = `"${query}" official audio`;

        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video`
        );

        const data = await response.json();

        console.log("YOUTUBE SEARCH TERM:", searchTerm);
        console.log("YOUTUBE RESPONSE:", data);

        if (data.error) {
            const reason = data.error?.errors?.[0]?.reason || data.error?.status || "unknown";

            if (
                reason === "quotaExceeded" ||
                reason === "dailyLimitExceeded" ||
                reason === "forbidden" ||
                data.error.code === 403
            ) {
                global.youtubeCooldownUntil = Date.now() + 1000 * 60 * 30;
            }

            return res.status(200).json({
                error: "YouTube preview temporarily unavailable",
                reason
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

        global.videoMissCache[cacheKey] = true;

        return res.status(200).json({
            error: "No video found"
        });

    } catch (error) {
        console.error("YOUTUBE SERVER ERROR:", error);

        return res.status(200).json({
            error: "Preview unavailable",
            details: error.message
        });
    }
}