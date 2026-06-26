export default async function handler(req, res) {
    const startedAt = Date.now();
    const QUOTA_COOLDOWN_MS = 1000 * 60 * 60 * 6;

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
        console.log("YOUTUBE PREVIEW CACHE HIT:", {
            durationMs: Date.now() - startedAt,
            resultFound: true
        });

        return res.status(200).json({
            videoId: global.videoCache[cacheKey],
            reason: null,
            cached: true
        });
    }

    if (global.videoMissCache[cacheKey]) {
        console.log("YOUTUBE PREVIEW MISS CACHE HIT:", {
            durationMs: Date.now() - startedAt,
            resultFound: false
        });

        return res.status(404).json({
            error: "Preview unavailable",
            reason: "no_result",
            cachedMiss: true
        });
    }

    if (Date.now() < global.youtubeCooldownUntil) {
        console.log("YOUTUBE PREVIEW LIMITED:", {
            durationMs: Date.now() - startedAt,
            errorCategory: "cooldown"
        });

        return res.status(429).json({
            error: "YouTube preview temporarily limited",
            reason: "quota_limited",
            cooldown: true
        });
    }

    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        if (!YOUTUBE_API_KEY) {
            console.error("YOUTUBE CONFIG ERROR:", {
                durationMs: Date.now() - startedAt,
                errorCategory: "missing_key"
            });

            return res.status(500).json({
                error: "YouTube preview unavailable",
                reason: "missing_key"
            });
        }

        const searchTerm = `"${query}" official audio`;

        const response = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=3&type=video`
        );

        let data;

        try {
            data = await response.json();
        } catch {
            console.error("YOUTUBE PREVIEW NON_JSON_RESPONSE:", {
                status: response.status,
                durationMs: Date.now() - startedAt,
                errorCategory: "upstream_error"
            });

            return res.status(502).json({
                error: "YouTube preview unavailable",
                reason: "upstream_error"
            });
        }

        if (!response.ok && !data.error) {
            console.log("YOUTUBE PREVIEW UPSTREAM ERROR:", {
                status: response.status,
                durationMs: Date.now() - startedAt,
                errorCategory: "upstream_error"
            });

            return res.status(502).json({
                error: "YouTube preview unavailable",
                reason: "upstream_error"
            });
        }

        if (data.error) {
            const upstreamReason = data.error?.errors?.[0]?.reason || data.error?.status || "unknown";

            if (
                upstreamReason === "quotaExceeded" ||
                upstreamReason === "dailyLimitExceeded" ||
                upstreamReason === "forbidden" ||
                data.error.code === 403
            ) {
                global.youtubeCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
            }

            const safeReason = (
                upstreamReason === "quotaExceeded" ||
                upstreamReason === "dailyLimitExceeded" ||
                upstreamReason === "forbidden" ||
                data.error.code === 403
            )
                ? "quota_limited"
                : "upstream_error";

            console.log("YOUTUBE PREVIEW API ERROR:", {
                status: response.status,
                durationMs: Date.now() - startedAt,
                errorCategory: safeReason
            });

            return res.status(safeReason === "quota_limited" ? 429 : 502).json({
                error: "YouTube preview temporarily unavailable",
                reason: safeReason
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

                console.log("YOUTUBE PREVIEW FOUND:", {
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    resultFound: true
                });

                return res.status(200).json({
                    videoId: validVideo.id.videoId,
                    duration: null,
                    reason: null,
                    cached: false
                });
            }
        }

        global.videoMissCache[cacheKey] = true;

        console.log("YOUTUBE PREVIEW NOT FOUND:", {
            status: response.status,
            durationMs: Date.now() - startedAt,
            resultFound: false
        });

        return res.status(404).json({
            error: "No video found",
            reason: "no_result"
        });

    } catch (error) {
        console.error("YOUTUBE SERVER ERROR:", {
            durationMs: Date.now() - startedAt,
            errorCategory: error.name || "server_error"
        });

        return res.status(502).json({
            error: "Preview unavailable",
            reason: "upstream_error"
        });
    }
}
