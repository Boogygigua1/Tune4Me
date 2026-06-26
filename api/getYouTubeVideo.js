const QUOTA_COOLDOWN_MS = 1000 * 60 * 60 * 6;

const HARD_AVOID_KEYWORDS = [
    "interview",
    "reaction",
    "review",
    "podcast",
    "tutorial",
    "explained",
    "analysis",
    "commentary",
    "behind the scenes",
    "documentary",
    "news",
    "shorts",
    "#shorts",
    "fan edit",
    "fan-made",
    "fanmade"
];

const CONDITIONAL_AVOID_KEYWORDS = [
    "karaoke",
    "instrumental"
];

const LIVE_KEYWORDS = [
    "live",
    "concert",
    "performance",
    "session"
];

const PREFERRED_TITLE_KEYWORDS = [
    "official audio",
    "official video",
    "lyric video",
    "lyrics",
    "audio"
];

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesKeyword(value, keyword) {
    if (keyword.startsWith("#")) {
        return value.includes(keyword);
    }

    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}([^a-z0-9]|$)`).test(value);
}

function includesAny(value, keywords) {
    return keywords.some(keyword => includesKeyword(value, keyword));
}

function scoreVideo(item, normalizedQuery, allowLive) {
    const title = item.snippet?.title?.toLowerCase() || "";
    const channel = item.snippet?.channelTitle?.toLowerCase() || "";
    const combined = `${title} ${channel}`;

    if (!item.id?.videoId) return null;
    if (includesAny(combined, HARD_AVOID_KEYWORDS)) return null;

    const queryRequestsConditionalVersion = CONDITIONAL_AVOID_KEYWORDS.some(keyword =>
        normalizedQuery.includes(keyword)
    );

    if (!queryRequestsConditionalVersion && includesAny(combined, CONDITIONAL_AVOID_KEYWORDS)) {
        return null;
    }

    const isLive = includesAny(combined, LIVE_KEYWORDS);

    if (isLive && !allowLive) {
        return null;
    }

    let score = 0;
    const queryTokens = normalizedQuery
        .split(" ")
        .filter(token => token.length > 2);
    const overlapCount = queryTokens.filter(token => combined.includes(token)).length;

    if (PREFERRED_TITLE_KEYWORDS.some(keyword => title.includes(keyword))) score += 40;
    if (channel.includes("topic")) score += 35;
    if (channel.includes("vevo")) score += 30;
    if (channel.includes("official")) score += 25;
    if (channel.includes("music")) score += 10;
    if (title.includes("provided to youtube")) score += 20;
    if (overlapCount >= 2) score += Math.min(overlapCount, 5) * 3;
    if (isLive) score -= 30;

    if (score <= 0) return null;

    return {
        item,
        score
    };
}

function pickBestVideo(items, normalizedQuery, allowLive = false) {
    return (items || [])
        .map(item => scoreVideo(item, normalizedQuery, allowLive))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)[0]?.item || null;
}

function isQuotaError(data) {
    const upstreamReason = data.error?.errors?.[0]?.reason || data.error?.status || "unknown";

    return (
        upstreamReason === "quotaExceeded" ||
        upstreamReason === "dailyLimitExceeded" ||
        upstreamReason === "forbidden" ||
        data.error?.code === 403
    );
}

export default async function handler(req, res) {
    const startedAt = Date.now();

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

        const searchStages = [
            { suffix: "official audio", category: "music" },
            { suffix: "official video", category: "music" },
            { suffix: "lyric video", category: "music" },
            { suffix: "official audio", category: null },
            { suffix: "official video", category: null },
            { suffix: "lyric video", category: null }
        ];

        let fallbackLiveVideo = null;
        let lastStatus = 200;

        for (const [stageIndex, stage] of searchStages.entries()) {
            const searchTerm = `"${query}" ${stage.suffix}`;
            const categoryParam = stage.category === "music"
                ? "&videoCategoryId=10"
                : "";

            const response = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video${categoryParam}`
            );

            lastStatus = response.status;

            let data;

            try {
                data = await response.json();
            } catch {
                console.error("YOUTUBE PREVIEW NON_JSON_RESPONSE:", {
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    errorCategory: "upstream_error",
                    stageIndex
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
                    errorCategory: "upstream_error",
                    stageIndex
                });

                return res.status(502).json({
                    error: "YouTube preview unavailable",
                    reason: "upstream_error"
                });
            }

            if (data.error) {
                const quotaLimited = isQuotaError(data);

                if (quotaLimited) {
                    global.youtubeCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
                }

                const safeReason = quotaLimited
                    ? "quota_limited"
                    : "upstream_error";

                console.log("YOUTUBE PREVIEW API ERROR:", {
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    errorCategory: safeReason,
                    stageIndex
                });

                return res.status(safeReason === "quota_limited" ? 429 : 502).json({
                    error: "YouTube preview temporarily unavailable",
                    reason: safeReason
                });
            }

            const validVideo = pickBestVideo(data.items, normalizedQuery, false);

            if (validVideo) {
                global.videoCache[cacheKey] = validVideo.id.videoId;

                console.log("YOUTUBE PREVIEW FOUND:", {
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    resultFound: true,
                    stageIndex
                });

                return res.status(200).json({
                    videoId: validVideo.id.videoId,
                    duration: null,
                    reason: null,
                    cached: false
                });
            }

            fallbackLiveVideo = fallbackLiveVideo ||
                pickBestVideo(data.items, normalizedQuery, true);
        }

        if (fallbackLiveVideo) {
            global.videoCache[cacheKey] = fallbackLiveVideo.id.videoId;

            console.log("YOUTUBE PREVIEW FOUND:", {
                status: lastStatus,
                durationMs: Date.now() - startedAt,
                resultFound: true,
                usedLiveFallback: true
            });

            return res.status(200).json({
                videoId: fallbackLiveVideo.id.videoId,
                duration: null,
                reason: null,
                cached: false
            });
        }

        global.videoMissCache[cacheKey] = true;

        console.log("YOUTUBE PREVIEW NOT FOUND:", {
            status: lastStatus,
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
