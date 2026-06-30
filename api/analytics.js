const ALLOWED_EVENTS = new Set([
    "home_page_loaded",
    "playlist_generated",
    "continue_playlist",
    "song_preview_opened",
    "youtube_search_opened",
    "song_saved",
    "song_liked",
    "song_disliked",
    "playlist_deleted",
    "philosophy_opened",
    "upgrade_dialog_viewed",
    "upgrade_completed",
    "support_form_submitted",
    "playlist_generation_failure",
    "youtube_preview_failure",
    "rate_limit_event"
]);

const EMPTY_COUNTS = Object.fromEntries(
    Array.from(ALLOWED_EVENTS).map(eventName => [eventName, 0])
);

function getAnalyticsStore() {
    global.tune4meAnalytics = global.tune4meAnalytics || {
        startedAt: new Date().toISOString(),
        counts: { ...EMPTY_COUNTS }
    };

    return global.tune4meAnalytics;
}

export function recordAnalyticsEvent(eventName) {
    if (!ALLOWED_EVENTS.has(eventName)) return false;

    const store = getAnalyticsStore();
    store.counts[eventName] = (store.counts[eventName] || 0) + 1;
    store.updatedAt = new Date().toISOString();

    return true;
}

function percent(numerator, denominator) {
    if (!denominator) return 0;
    return Number(((numerator / denominator) * 100).toFixed(1));
}

function average(numerator, denominator) {
    if (!denominator) return 0;
    return Number((numerator / denominator).toFixed(2));
}

function buildSummary() {
    const store = getAnalyticsStore();
    const counts = { ...EMPTY_COUNTS, ...store.counts };
    const visitors = counts.home_page_loaded;
    const playlists = counts.playlist_generated;
    const upgradesViewed = counts.upgrade_dialog_viewed;

    return {
        startedAt: store.startedAt,
        updatedAt: store.updatedAt || store.startedAt,
        counts,
        metrics: {
            visitors,
            playlistGenerationRate: percent(playlists, visitors),
            averagePreviewOpensPerPlaylist: average(counts.song_preview_opened, playlists),
            saveRate: percent(counts.song_saved, playlists),
            songSavedTotal: counts.song_saved,
            songLikedTotal: counts.song_liked,
            songDislikedTotal: counts.song_disliked,
            continuePlaylistUsage: counts.continue_playlist,
            upgradeConversion: percent(counts.upgrade_completed, upgradesViewed),
            playlistGenerationFailures: counts.playlist_generation_failure,
            youtubePreviewFailures: counts.youtube_preview_failure,
            rateLimitEvents: counts.rate_limit_event
        }
    };
}

function isAuthorized(req) {
    const token = process.env.ANALYTICS_ADMIN_TOKEN;
    if (!token) return false;

    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : "";

    return bearerToken === token || req.query?.token === token;
}

export default async function handler(req, res) {
    if (req.method === "POST") {
        let body;

        try {
            body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        } catch {
            return res.status(400).json({ error: "Invalid JSON body" });
        }

        const accepted = recordAnalyticsEvent(String(body?.event || ""));

        return res.status(accepted ? 202 : 400).json({
            ok: accepted
        });
    }

    if (req.method === "GET") {
        if (!isAuthorized(req)) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        return res.status(200).json(buildSummary());
    }

    return res.status(405).json({ error: "Method not allowed" });
}
