import { recordAnalyticsEvent } from "./analytics.js";

const QUOTA_COOLDOWN_MS = 1000 * 60 * 60 * 6;
const MAX_QUERY_LENGTH = 180;
const RATE_LIMIT_WINDOW_MS = 1000 * 60;
const RATE_LIMIT_MAX_REQUESTS = 30;
const YOUTUBE_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const YOUTUBE_MISS_TTL_MS = 1000 * 60 * 5;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const MAX_PREVIEW_CANDIDATES = 5;
const RATE_BACKOFF_BASE_MS = 5000;
const RATE_BACKOFF_MAX_MS = 60000;
const RETRY_AFTER_MAX_MS = 300000;
const SEARCH_STAGES = [
    { suffix: "", category: null },
    { suffix: "official audio", category: "music" },
    { suffix: "official video", category: null },
    { suffix: "lyric video", category: null }
];

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
    "instrumental",
    "cover",
    "remix",
    "sped up",
    "slowed",
    "nightcore"
];

const LIVE_KEYWORDS = [
    "live",
    "concert",
    "performance",
    "session",
    "sessions",
    "alive from"
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

function normalizeIdentity(value) {
    return String(value)
        .replace(/&(?:amp|quot|apos|#39|#x27|#34);/gi, entity => ({
            "&amp;": "&", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&#x27;": "'", "&#34;": '"'
        })[entity.toLowerCase()])
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/ı/g, "i")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function containsPhrase(text, phrase) {
    return (` ${text} `).includes(` ${phrase} `);
}

function artistNamedChannel(channel, artist) {
    const compact = normalizeIdentity(channel).replace(/\s/g, "")
        .replace(/(?:official|vevo|topic|music|channel)+$/g, "");
    const primary = artist.split(/\s+(?:feat|ft|featuring)\s+/)[0];
    return Boolean(compact) && [artist, primary].some(name => compact === name.replace(/\s/g, ""));
}

function matchesSong(title, song, artist) {
    const primaryArtist = artist.split(/\s+(?:feat|ft|featuring)\s+/)[0];
    function withoutArtist(value) {
        for (const name of [artist, primaryArtist]) {
            if (value.startsWith(name + " ")) value = value.slice(name.length).trim();
            if (value.endsWith(" " + name)) value = value.slice(0, -name.length).trim();
        }
        return value;
    }
    if (withoutArtist(normalizeIdentity(title)) === song) return true;
    const presentation = /\s*[([][^\])]*(?:official|audio|video|lyrics?|visualizer|live|sessions?|remaster|\bfrom\b|\bfeat\b|\bft\b|\bfeaturing\b)[^\])]*[)\]]/gi;
    let clean = withoutArtist(normalizeIdentity(title.replace(presentation, "")));
    // Uploads commonly use either artist-title or title-artist, with or without punctuation.
    clean = clean.replace(/\s+(?:(?:official\s+)?(?:music\s+)?(?:audio|video|lyrics?|visualizer)|hd|hq|4k)(?:\s+.*)?$/, "");
    clean = clean.replace(/\s+(?:live|concert|performance|sessions?)(?:\s+.*)?$/, "");
    return withoutArtist(clean) === song;
}

function scoreVideo(item, identity, allowLive) {
    const title = item.snippet?.title?.toLowerCase() || "";
    const channel = item.snippet?.channelTitle?.toLowerCase() || "";
    const combined = `${title} ${channel}`;

    if (!VIDEO_ID_PATTERN.test(item.id?.videoId || "")) return null;
    if (includesAny(combined, HARD_AVOID_KEYWORDS)) return null;
    const featureMarker = /\b(?:feat|ft|featuring)\b/;
    if (featureMarker.test(normalizeIdentity(title)) && !featureMarker.test(identity.query)) return null;

    if (CONDITIONAL_AVOID_KEYWORDS.some(keyword =>
        includesKeyword(combined, keyword) && !includesKeyword(identity.query, keyword))) {
        return null;
    }

    const isLive = includesAny(title, LIVE_KEYWORDS) &&
        !includesAny(identity.song || "", LIVE_KEYWORDS);

    if (isLive && !allowLive) {
        return null;
    }

    const normalizedTitle = normalizeIdentity(title);
    const normalizedChannel = normalizeIdentity(channel);
    const normalizedCombined = `${normalizedTitle} ${normalizedChannel}`;
    let score = 0;

    if (identity.song && identity.artist) {
        const compactChannel = normalizedChannel.replace(/\s/g, "").replace(/(?:official|vevo|topic|music|channel)+$/g, "");
        const artistWords = identity.artist.split(" ").filter(word => !["feat", "ft", "featuring"].includes(word));
        const artistMatches = containsPhrase(normalizedCombined, identity.artist) ||
            (artistWords.length > 0 && artistWords.every(word => containsPhrase(normalizedCombined, word))) ||
            compactChannel === identity.artist.replace(/\s/g, "");
        if (!artistMatches || !matchesSong(title, identity.song, identity.artist)) return null;
        score = 200;
    } else {
        // Legacy query-only callers still need all identity words, not just upload-quality labels.
        const queryTokens = identity.query.split(" ").filter(token => token && token !== "by");
        if (!queryTokens.length || !queryTokens.every(token => containsPhrase(normalizedCombined, token))) return null;
        score = 100;
    }

    if (PREFERRED_TITLE_KEYWORDS.some(keyword => title.includes(keyword))) score += 40;
    // A channel merely containing "music" or "VEVO" is not stronger evidence than an artist-named source.
    if (identity.artist && artistNamedChannel(channel, identity.artist)) score += 200;
    if (channel.includes("topic")) score += 35;
    if (channel.includes("vevo")) score += 30;
    if (channel.includes("official")) score += 25;
    if (channel.includes("music")) score += 10;
    if (title.includes("provided to youtube")) score += 20;
    if (isLive) score -= 30;

    if (score <= 0) return null;

    return {
        item,
        score
    };
}

function isQuotaError(data) {
    return (data.error?.errors || []).some(error =>
        ["quotaExceeded", "dailyLimitExceeded"].includes(error.reason)
    );
}

async function requestYouTube(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (response.ok && data && !data.error && Array.isArray(data.items)) return data;

    const quotaLimited = data && isQuotaError(data);
    const rateLimited = response.status === 429 || (data?.error?.errors || []).some(error =>
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(error.reason));
    if (quotaLimited) global.youtubeCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
    const error = new Error("YouTube API request failed");
    error.previewReason = quotaLimited ? "quota_limited" : rateLimited ? "rate_limited" :
        response.status === 403 ? "access_denied" : "upstream_error";
    error.previewStatus = quotaLimited || rateLimited ? 429 : 502;
    // Never expose upstream messages, request URLs, headers, or credentials.
    const safeReasons = ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded",
        "forbidden", "accessNotConfigured", "ipRefererBlocked", "keyInvalid", "backendError"];
    error.diagnostics = {
        source: "youtube",
        upstreamStatus: response.status,
        upstreamReason: (data?.error?.errors || []).map(item => item.reason).find(reason => safeReasons.includes(reason)) || null,
        operation: new URL(url).pathname.endsWith("/videos") ? "videos" : "search"
    };
    if (quotaLimited) {
        global.youtubeQuotaDiagnostics = error.diagnostics;
        error.retryAfterSeconds = QUOTA_COOLDOWN_MS / 1000;
    } else if (rateLimited) {
        const previous = global.youtubeRateBackoff;
        const attempt = previous && Date.now() < previous.until + RETRY_AFTER_MAX_MS ? Math.min(previous.attempt + 1, 5) : 1;
        const retryHeader = response.headers?.get?.("retry-after");
        const retryMs = retryHeader == null ? 0 : /^\d+(?:\.\d+)?$/.test(retryHeader)
            ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now();
        const delay = Math.max(Math.min(RATE_BACKOFF_BASE_MS * 2 ** (attempt - 1), RATE_BACKOFF_MAX_MS),
            Number.isFinite(retryMs) ? Math.min(Math.max(retryMs, 0), RETRY_AFTER_MAX_MS) : 0);
        global.youtubeRateBackoff = { until: Date.now() + delay, attempt, diagnostics: error.diagnostics };
        error.retryAfterSeconds = Math.ceil(delay / 1000);
    }
    throw error;
}

function sendPreview(res, result, cacheSource) {
    if (result.body.retryAfterSeconds) res.setHeader?.("Retry-After", String(result.body.retryAfterSeconds));
    return res.status(result.status).json({ ...result.body,
        cacheSource: cacheSource === "inflight" ? cacheSource : result.body.cacheSource || cacheSource });
}

function isPlayable(video, regionCode) {
    const status = video.status;
    const details = video.contentDetails;
    if (!status?.embeddable || !["public", "unlisted"].includes(status.privacyStatus) ||
        status.uploadStatus !== "processed" || !details ||
        details.contentRating?.ytRating === "ytAgeRestricted") return false;
    const restrictions = details.regionRestriction;
    if (restrictions?.allowed && (!restrictions.allowed.length ||
        (regionCode && !restrictions.allowed.includes(regionCode)))) return false;
    return !(regionCode && restrictions?.blocked?.includes(regionCode));
}

function getClientKey(req) {
    const forwardedFor = req.headers["x-forwarded-for"];
    const ip = Array.isArray(forwardedFor)
        ? forwardedFor[0]
        : String(forwardedFor || req.socket?.remoteAddress || "unknown").split(",")[0].trim();

    return ip || "unknown";
}

function isRateLimited(req) {
    const now = Date.now();
    const key = getClientKey(req);

    global.youtubeRateLimit = global.youtubeRateLimit || {};

    const record = global.youtubeRateLimit[key] || {
        count: 0,
        resetAt: now + RATE_LIMIT_WINDOW_MS
    };

    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }

    record.count += 1;
    global.youtubeRateLimit[key] = record;

    return record.count > RATE_LIMIT_MAX_REQUESTS;
}

function getFreshCacheEntry(cache, key, ttl = YOUTUBE_CACHE_TTL_MS) {
    const entry = cache[key];

    if (!entry || typeof entry !== "object" || !entry.cachedAt) {
        delete cache[key];
        return null;
    }

    if (Date.now() - entry.cachedAt > ttl) {
        delete cache[key];
        return null;
    }

    return entry;
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

    const song = String(body?.song || "").trim();
    const artist = String(body?.artist || "").trim();
    if (Boolean(song) !== Boolean(artist)) {
        return res.status(400).json({ error: "Both song and artist are required" });
    }
    const query = song && artist ? `${artist} ${song}` : String(body?.query || "").trim();

    if (!query) {
        return res.status(400).json({ error: "Missing query" });
    }

    if (query.length > MAX_QUERY_LENGTH) {
        return res.status(413).json({
            error: "Query is too long",
            reason: "query_too_long",
            maxLength: MAX_QUERY_LENGTH
        });
    }

    const identity = { song: normalizeIdentity(song), artist: normalizeIdentity(artist), query: normalizeIdentity(query) };
    if (!identity.query || (song && (!identity.song || !identity.artist))) {
        return res.status(400).json({ error: "Missing searchable identity" });
    }
    // Version the cache so old loosely ranked results cannot bypass identity validation.
    const regionValue = String(body?.regionCode || req.headers["x-vercel-ip-country"] || "").toUpperCase();
    const regionCode = /^[A-Z]{2}$/.test(regionValue) && regionValue !== "XX" ? regionValue : null;
    const excludedIds = new Set((Array.isArray(body?.excludeVideoIds) ? body.excludeVideoIds : [])
        .slice(0, 5).filter(id => typeof id === "string" && VIDEO_ID_PATTERN.test(id)));
    const includeAlternatives = body?.includeAlternatives === true;
    const requestedStage = body?.startSearchStage ?? 0;
    if (!Number.isInteger(requestedStage) || requestedStage < 0 || requestedStage >= SEARCH_STAGES.length) {
        return res.status(400).json({ error: "Invalid search stage", reason: "invalid_search_stage" });
    }
    const cacheKey = "yt_v4_" + JSON.stringify([song ? [identity.song, identity.artist] : [identity.query], regionCode]);

    global.videoCache = global.videoCache || {};
    global.videoMissCache = global.videoMissCache || {};
    global.youtubeCooldownUntil = global.youtubeCooldownUntil || 0;
    global.youtubeLookups = global.youtubeLookups || new Map();

    const cachedVideo = getFreshCacheEntry(global.videoCache, cacheKey);

    const cachedCandidates = cachedVideo?.candidates?.filter(item => !excludedIds.has(item.videoId));
    if (cachedCandidates?.length) {
        console.log("YOUTUBE PREVIEW CACHE HIT:", {
            durationMs: Date.now() - startedAt,
            resultFound: true
        });

        const limitUntil = cachedVideo.warning === "quota_limited" ? global.youtubeCooldownUntil
            : cachedVideo.retryUntil || global.youtubeRateBackoff?.until || 0;
        const warning = ["rate_limited", "quota_limited"].includes(cachedVideo.warning) && Date.now() >= limitUntil
            ? null : cachedVideo.warning || null;
        return res.status(200).json({
            videoId: cachedCandidates[0].videoId,
            reason: null,
            cached: true,
            cacheSource: "server_cache",
            video: cachedCandidates[0].video,
            candidates: cachedCandidates,
            nextSearchStage: Math.max(requestedStage, cachedVideo.nextSearchStage ?? SEARCH_STAGES.length),
            warning,
            diagnostics: cachedVideo.diagnostics || null,
            retryAfterSeconds: warning && limitUntil > Date.now() ? Math.ceil((limitUntil - Date.now()) / 1000) : undefined
        });
    }

    const cachedMiss = getFreshCacheEntry(global.videoMissCache, cacheKey, YOUTUBE_MISS_TTL_MS);

    if (cachedMiss && !excludedIds.size) {
        console.log("YOUTUBE PREVIEW MISS CACHE HIT:", {
            durationMs: Date.now() - startedAt,
            resultFound: false
        });

        return res.status(404).json({
            error: "Preview unavailable",
            reason: "no_result",
            cachedMiss: true,
            cacheSource: "server_miss"
        });
    }

    // Continue only after the caller has exhausted the available verified candidates.
    const startSearchStage = Math.max(requestedStage,
        cachedVideo && excludedIds.size ? cachedVideo.nextSearchStage ?? 0 : 0);
    if (startSearchStage >= SEARCH_STAGES.length) {
        return res.status(404).json({ error: "No remaining matching preview", reason: "unplayable",
            nextSearchStage: SEARCH_STAGES.length, cacheSource: "server_cache" });
    }
    const flightKey = JSON.stringify([cacheKey, includeAlternatives, [...excludedIds].sort(), startSearchStage]);
    const pending = global.youtubeLookups.get(flightKey);
    if (pending) return sendPreview(res, await pending, "inflight");

    if (Date.now() < global.youtubeCooldownUntil) {
        console.log("YOUTUBE PREVIEW LIMITED:", {
            durationMs: Date.now() - startedAt,
            errorCategory: "cooldown"
        });

        return sendPreview(res, { status: 429, body: {
            error: "YouTube preview temporarily limited",
            reason: "quota_limited",
            cooldown: true,
            diagnostics: { ...global.youtubeQuotaDiagnostics, source: "quota_cooldown" },
            retryAfterSeconds: Math.ceil((global.youtubeCooldownUntil - Date.now()) / 1000)
        } }, "none");
    }

    if (Date.now() < global.youtubeRateBackoff?.until) {
        return sendPreview(res, { status: 429, body: {
            error: "YouTube preview temporarily limited", reason: "rate_limited",
            diagnostics: { ...global.youtubeRateBackoff.diagnostics, source: "backoff" },
            retryAfterSeconds: Math.ceil((global.youtubeRateBackoff.until - Date.now()) / 1000)
        } }, "none");
    }
    // Cache hits, shared lookups and backoff responses consume no local lookup allowance.
    if (isRateLimited(req)) {
        recordAnalyticsEvent("rate_limit_event");
        return sendPreview(res, { status: 429, body: {
            error: "Too many preview requests", reason: "rate_limited",
            diagnostics: { source: "local_guard" },
            retryAfterSeconds: Math.max(1, Math.ceil((global.youtubeRateLimit[getClientKey(req)].resetAt - Date.now()) / 1000))
        } }, "none");
    }

    const task = lookupVideo({ query, identity, regionCode, excludedIds, includeAlternatives, cacheKey, startedAt, startSearchStage });
    global.youtubeLookups.set(flightKey, task);
    try {
        return sendPreview(res, await task, "upstream");
    } finally {
        global.youtubeLookups.delete(flightKey);
    }
}

async function lookupVideo({ query, identity, regionCode, excludedIds, includeAlternatives, cacheKey, startedAt, startSearchStage }) {
    try {
        const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

        if (!YOUTUBE_API_KEY) {
            console.error("YOUTUBE CONFIG ERROR:", {
                durationMs: Date.now() - startedAt,
                errorCategory: "missing_key"
            });

            return { status: 500, body: {
                error: "YouTube preview unavailable",
                reason: "missing_key"
            } };
        }

        let unavailableCount = 0;
        const checkedVideos = new Map();
        const candidatePool = new Map();
        const liveRequested = includesAny(identity.query, LIVE_KEYWORDS);
        let searchWarning = null;
        let searchDiagnostics = null;
        let retryAfterSeconds;
        let nextSearchStage = startSearchStage;

        for (let stageIndex = startSearchStage; stageIndex < SEARCH_STAGES.length; stageIndex++) {
            const stage = SEARCH_STAGES[stageIndex];
            try {
                const searchTerm = `${query} ${stage.suffix}`.trim();
                const categoryParam = stage.category === "music"
                    ? "&videoCategoryId=10"
                    : "";

                const data = await requestYouTube(
                    `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchTerm)}&key=${YOUTUBE_API_KEY}&maxResults=25&type=video&videoEmbeddable=true&videoSyndicated=true${categoryParam}${regionCode ? "&regionCode=" + regionCode : ""}`
                );

                const matching = data.items.filter(item => !excludedIds.has(item.id?.videoId) && scoreVideo(item, identity, true));
                const uncheckedIds = [...new Set(matching.map(item => item.id.videoId))].filter(id => !checkedVideos.has(id));
                if (uncheckedIds.length) {
                    const details = await requestYouTube(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails&id=${uncheckedIds.join(",")}&key=${YOUTUBE_API_KEY}`);
                    for (const id of uncheckedIds) checkedVideos.set(id, null);
                    for (const item of details.items) checkedVideos.set(item.id, item);
                }
                const playable = matching.filter(item => {
                    const details = checkedVideos.get(item.id.videoId);
                    if (!details || !isPlayable(details, regionCode)) {
                        unavailableCount++;
                        return false;
                    }
                    return true;
                }).map(item => ({ ...item, snippet: checkedVideos.get(item.id.videoId).snippet || item.snippet }));
                for (const item of playable) {
                    const scored = scoreVideo(item, identity, true);
                    if (scored) candidatePool.set(item.id.videoId, {
                        ...scored, studio: Boolean(scoreVideo(item, identity, false))
                    });
                }
                const studioCount = [...candidatePool.values()].filter(item => item.studio || liveRequested).length;
                const artistSourceFound = [...candidatePool.values()].some(({ item, studio }) =>
                    (studio || liveRequested) && identity.artist && artistNamedChannel(item.snippet.channelTitle, identity.artist));
                nextSearchStage = stageIndex + 1;
                // One strong verified source is sufficient; retain all alternatives found in that response.
                // Broaden only for missing/weak sources or when playback exhausts this pool later.
                if (studioCount && (!includeAlternatives || !identity.artist || artistSourceFound)) break;
            } catch (error) {
                if (!candidatePool.size) throw error;
                // Stop on a service error, preserving candidates already checked against videos.list.
                searchWarning = error.previewReason || "upstream_error";
                searchDiagnostics = error.diagnostics || null;
                retryAfterSeconds = error.retryAfterSeconds;
                break;
            }
        }

        if (!searchWarning) global.youtubeRateBackoff = null;
        const ranked = [...candidatePool.values()]
            .sort((a, b) => (liveRequested ? 0 : Number(b.studio) - Number(a.studio)) || b.score - a.score);
        const selected = ranked.slice(0, MAX_PREVIEW_CANDIDATES);
        const artistLive = ranked.find(({ item, studio }) => !studio && identity.artist &&
            artistNamedChannel(item.snippet.channelTitle, identity.artist));
        // Keep a clearly labelled same-artist performance as a last resort, rather than five lyric reuploads.
        if (includeAlternatives && !liveRequested && artistLive && !selected.includes(artistLive)) {
            selected[MAX_PREVIEW_CANDIDATES - 1] = artistLive;
        }
        const candidates = selected
            .map(({ item, studio }) => ({
                videoId: item.id.videoId,
                video: { title: item.snippet.title, channelTitle: item.snippet.channelTitle,
                    embeddable: true, regionChecked: regionCode, version: studio ? "studio" : "live" }
            }));
        // Keep progress even when a continuation finds no new candidates. Browser-specific
        // failures do not erase a previously verified pool for other callers.
        if (global.videoCache[cacheKey]) global.videoCache[cacheKey].nextSearchStage = nextSearchStage;
        if (candidates.length) {
            global.videoCache[cacheKey] = { candidates, nextSearchStage,
                warning: searchWarning, diagnostics: searchDiagnostics,
                retryUntil: retryAfterSeconds ? Date.now() + retryAfterSeconds * 1000 : 0, cachedAt: Date.now() };
            console.log("YOUTUBE PREVIEW FOUND:", {
                durationMs: Date.now() - startedAt, resultFound: true, candidateCount: candidates.length
            });
            return { status: 200, body: {
                ...candidates[0], duration: null, reason: null, cached: false, candidates, nextSearchStage, warning: searchWarning,
                diagnostics: searchDiagnostics, retryAfterSeconds
            } };
        }

        if (!startSearchStage && !excludedIds.size && !unavailableCount) {
            global.videoMissCache[cacheKey] = { cachedAt: Date.now() };
        }

        console.log("YOUTUBE PREVIEW NOT FOUND:", {
            status: 200,
            durationMs: Date.now() - startedAt,
            resultFound: false
        });

        return { status: 404, body: {
            error: "No video found",
            reason: unavailableCount || excludedIds.size ? "unplayable" : "no_result", nextSearchStage
        } };

    } catch (error) {
        console.error("YOUTUBE SERVER ERROR:", {
            durationMs: Date.now() - startedAt,
            errorCategory: error.previewReason || "upstream_error",
            diagnostics: error.diagnostics || null,
            retryAfterSeconds: error.retryAfterSeconds
        });

        return { status: error.previewStatus || 502, body: {
            error: "Preview unavailable",
            reason: error.previewReason || "upstream_error",
            diagnostics: error.diagnostics || null,
            retryAfterSeconds: error.retryAfterSeconds
        } };
    }
}
