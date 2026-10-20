import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, mock, test } from "node:test";
import getPlaylist from "../api/getPlaylist.js";
import getYouTubeVideo from "../api/getYouTubeVideo.js";

const anchor = { song: "Lose Control", artist: "Teddy Swims" };
const other = { song: "Someone Like You", artist: "Adele" };
const originalKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY };
let fetchImpl;
let requests;
let detailRequests;
let detailsImpl;
let upstreamVideos;

beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-only";
    process.env.YOUTUBE_API_KEY = "test-only";
    for (const key of ["playlistRateLimit", "youtubeRateLimit", "videoCache", "videoMissCache", "youtubeCooldownUntil",
        "youtubeQuotaDiagnostics", "youtubeRateBackoff", "youtubeLookups", "tune4meAnalytics"]) delete global[key];
    requests = [];
    detailRequests = [];
    upstreamVideos = new Map();
    detailsImpl = async url => response({ items: new URL(url).searchParams.get("id").split(",").map(id => ({
        id, snippet: upstreamVideos.get(id)?.snippet,
        status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed" },
        contentDetails: {}
    })) });
    fetchImpl = () => { throw new Error("Unexpected upstream request: live network is disabled in tests"); };
    mock.method(globalThis, "fetch", async (...args) => {
        if (String(args[0]).includes("/youtube/v3/videos?")) {
            detailRequests.push(args);
            return detailsImpl(...args);
        }
        requests.push(args);
        const reply = await fetchImpl(...args);
        if (String(args[0]).includes("/youtube/v3/search?")) {
            try {
                const data = await reply.json();
                if (Array.isArray(data.items)) for (const item of data.items) upstreamVideos.set(item.id?.videoId, item);
            } catch { /* The handler must classify malformed upstream JSON. */ }
        }
        return reply;
    });
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
    mock.method(console, "warn", () => {});
});

afterEach(() => {
    mock.restoreAll();
    for (const [key, value] of Object.entries(originalKeys)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function invoke(handler, body, method = "POST") {
    const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body, headers: { "x-forwarded-for": "regression-test" } }, res);
    return { status: res.code, body: res.body, headers: res.headers };
}

function playlistFixture(overrides = {}) {
    return {
        intro: "You can miss someone and still feel relieved that it ended.",
        requestedSongs: [],
        songs: [anchor, other],
        explanation: "These songs leave room for longing and relief without pushing you toward a fresh start.",
        ...overrides
    };
}

function aiReply(playlist = playlistFixture(), overrides = {}) {
    fetchImpl = async () => response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(playlist) }, ...overrides }] });
}

function video(id, title, channelTitle = "Teddy Swims") {
    return { id: { videoId: idFor(id) }, snippet: { title, channelTitle } };
}

function idFor(label) { return label.padEnd(11, "_").slice(0, 11); }

const exactVideo = video("correct____", "Teddy Swims - Lose Control (Official Audio)");
const genericExactVideo = { ...exactVideo, snippet: { ...exactVideo.snippet, channelTitle: "Lyric Channel" } };

for (const mood of [
    "I feel abandoned after our breakup.",
    "I feel judged by everyone, but I don't want to be cheered up.",
    "My group of friends moved away. I'm proud of them and lonely at the same time.",
    "I miss my ex and feel relieved it ended. Please let me sit with both feelings."
]) {
    test(`emotional request reaches the same curator intact: ${mood}`, async () => {
        aiReply();
        const result = await invoke(getPlaylist, { mood, length: 2 });
        assert.equal(result.status, 200);
        assert.equal(requests.length, 1);
        const sent = JSON.parse(requests[0][1].body);
        assert.equal(sent.model, "gpt-4o-mini");
        assert.equal(sent.messages[0].role, "system");
        assert.match(sent.messages[0].content, /mixed or conflicting feelings/);
        assert.match(sent.messages[0].content, /without overriding emotional understanding/);
        assert.match(sent.messages[0].content, /Do not automatically turn sadness into empowerment/);
        assert.doesNotMatch(sent.messages[0].content, /Musical identity comes BEFORE|The playlist must follow/);
        assert.deepEqual(JSON.parse(sent.messages[1].content), { mood, length: 2, existingSongs: [], avoidSongs: [], likedSongs: [] });
        assert.equal(result.body.playlist.intro, playlistFixture().intro);
        assert.equal(result.body.playlist.explanation, playlistFixture().explanation);
    });
}

test("mixed soul/era preference and conflicting emotions are preserved together", async () => {
    aiReply(playlistFixture({ songs: [other, { song: "Stay With Me", artist: "Sam Smith" }] }));
    const mood = "I want 70s soul. I feel guilty and relieved after leaving, but don't want empowerment songs. Something gentle, not a festival vibe.";
    assert.equal((await invoke(getPlaylist, { mood, length: 2, likedSongs: [other], avoidSongs: [anchor] })).status, 200);
    const sent = JSON.parse(requests[0][1].body);
    const context = JSON.parse(sent.messages[1].content);
    assert.equal(context.mood, mood);
    assert.deepEqual(context.likedSongs, [other]);
    assert.deepEqual(context.avoidSongs, [anchor]);
});

for (const mood of [
    '"Lose Control" by Teddy Swims',
    "Please find Lose Control by Teddy Swims",
    "Lose Control by Teddy Swims because I miss my ex"
]) {
    test(`exact song reference uses canonical fields, not surrounding prose: ${mood}`, async () => {
        // Model semantics are a live evaluation; this fixture tests downstream enforcement.
        aiReply(playlistFixture({ requestedSongs: [anchor], songs: [other, { song: "Stay With Me", artist: "Sam Smith" }] }));
        const result = await invoke(getPlaylist, { mood, length: 2 });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs[0], anchor);
        assert.equal(result.body.playlist.songs.length, 2);
        assert.match(result.body.choices[0].message.content, /- Lose Control - Teddy Swims/);
        assert.doesNotMatch(result.body.choices[0].message.content, /- Please find Lose Control|Teddy Swims because/);
    });
}

test("continuation does not reinsert an anchor already in the playlist", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: [other, { song: "Stay With Me", artist: "Sam Smith" }] }));
    const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims", length: 2, existingSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.songs.some(item => item.song === anchor.song), false);
});

test("excluded anchors do not override rejection feedback", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: [other, { song: "Stay With Me", artist: "Sam Smith" }] }));
    const result = await invoke(getPlaylist, { mood: "Something like Lose Control, but don't include it", length: 2, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.songs.some(item => item.song === anchor.song), false);
});

test("detailed descriptions over the former 500-character limit reach the curator", async () => {
    aiReply();
    const mood = "I am grieving and relieved, and want company rather than a hopeful ending. ".repeat(12);
    assert.ok(mood.length > 500 && mood.length < 2000);
    assert.equal((await invoke(getPlaylist, { mood, length: 2 })).status, 200);
    assert.equal(JSON.parse(JSON.parse(requests[0][1].body).messages[1].content).mood, mood.trim());
    assert.equal((await invoke(getPlaylist, { mood: "x".repeat(2001) })).status, 413);
    assert.equal(requests.length, 1);
});

for (const [label, playlist, overrides] of [
    ["malformed JSON", null, { message: { content: "not json" } }],
    ["refusal", null, { message: { content: null, refusal: "refused" } }],
    ["truncation", playlistFixture(), { finish_reason: "length" }],
    ["duplicate songs", playlistFixture({ songs: [anchor, anchor] }), {}],
    ["empty artist", playlistFixture({ songs: [anchor, { song: "Unknown", artist: "" }] }), {}],
    ["missing songs", playlistFixture({ songs: [] }), {}]
]) {
    test(`invalid model result is an explicit error, never a generic fallback: ${label}`, async () => {
        aiReply(playlist, overrides);
        const result = await invoke(getPlaylist, { mood: "I feel isolated", length: 2 });
        assert.equal(result.status, 502);
        assert.equal(result.body.reason, "invalid_playlist_response");
        assert.equal(result.body.playlist, undefined);
    });
}

test("upstream generation errors preserve their failure category", async () => {
    fetchImpl = async () => response({ error: { type: "insufficient_quota" } }, 429);
    const result = await invoke(getPlaylist, { mood: "I feel isolated" });
    assert.equal(result.status, 429);
    assert.equal(result.body.reason, "insufficient_quota");
});

test("Lose Control preview ranks the correct identity above unrelated official uploads", async () => {
    fetchImpl = async () => response({ items: [
        video("unrelated", "Completely Different Song (Official Audio)", "UnrelatedVEVO"),
        video("wrong-artist", "Lose Control (Official Audio)", "Another Artist - Topic"),
        video("wrong-title", "Teddy Swims - Lose Control Again (Official Audio)"),
        exactVideo
    ] });
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 200);
    assert.equal(result.body.videoId, "correct____");
    const url = new URL(requests[0][0]);
    assert.equal(url.searchParams.get("q"), "Teddy Swims Lose Control");
    assert.equal(url.searchParams.get("videoEmbeddable"), "true");
    assert.equal(url.searchParams.get("videoSyndicated"), "true");
});

test("wrong artist, wrong title, and unrelated official results never become a match", async () => {
    fetchImpl = async () => response({ items: [
        video("wrong-artist", "Lose Control (Official Audio)", "Another Artist - Topic"),
        video("wrong-title", "Teddy Swims - Lose Control Again (Official Audio)"),
        video("unrelated", "Official Audio", "MusicVEVO")
    ] });
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 404);
    assert.equal(result.body.reason, "no_result");
});

test("the first search uses unquoted bare identity without a category constraint", async () => {
    fetchImpl = async url => {
        const params = new URL(url).searchParams;
        return response({ items: params.get("q") === "Teddy Swims Lose Control" ? [exactVideo] : [] });
    };
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.body.videoId, "correct____");
    assert.equal(requests.length, 1);
    assert.ok(requests.every(([url]) => !new URL(url).searchParams.get("q").includes('"')));
    assert.equal(new URL(requests.at(-1)[0]).searchParams.has("videoCategoryId"), false);
});

test("legacy query-only callers still find the exact song and reject unrelated labels", async () => {
    fetchImpl = async () => response({ items: [video("wrong", "Official Audio", "UnrelatedVEVO"), exactVideo] });
    const result = await invoke(getYouTubeVideo, { query: "Lose Control Teddy Swims" });
    assert.equal(result.body.videoId, "correct____");
});

for (const [label, song, artist, candidate] of [
    ["topic channel", "Lose Control", "Teddy Swims", video("topic", "Lose Control", "Teddy Swims - Topic")],
    ["compact official channel", "Lose Control", "Teddy Swims", video("compact", "Lose Control (Official Video)", "TeddySwimsVEVO")],
    ["punctuation and HTML entities", "Everybody's Talkin'", "Harry Nilsson", video("punctuation", "Harry Nilsson - Everybody&#39;s Talkin&#39; (Official Audio)", "Harry Nilsson")],
    ["non-English identity", "Şımarık", "Tarkan", video("unicode", "Tarkan - Simarik (Official Video)", "Tarkan")],
    ["hyphenated artist", "Take On Me", "a-ha", video("hyphen", "a-ha - Take On Me (Official Video)", "a-ha")]
]) {
    test(`identity handling preserves ${label}`, async () => {
        fetchImpl = async () => response({ items: [candidate] });
        const result = await invoke(getYouTubeVideo, { song, artist });
        assert.equal(result.status, 200);
        assert.equal(result.body.videoId, candidate.id.videoId);
    });
}

test("studio previews are preferred, with live performances retained as a last resort", async () => {
    const live = video("live", "Teddy Swims - Lose Control (The Village Sessions)");
    let stage = 0;
    fetchImpl = async () => response({ items: stage++ === 0 ? [live] : [exactVideo] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, "correct____");
    assert.equal(requests.length, 2);
    global.videoCache = {};
    fetchImpl = async () => response({ items: [live] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, idFor("live"));
});

test("remixes and covers are not substituted for an unqualified exact request", async () => {
    fetchImpl = async () => response({ items: [
        video("remix", "Teddy Swims - Lose Control (Official Remix)", "Teddy Swims VEVO"),
        video("cover", "Teddy Swims - Lose Control (Official Cover Audio)", "Cover Music"),
        exactVideo
    ] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, "correct____");
});

test("explicitly named live and remix versions remain searchable", async () => {
    for (const version of ["Live", "Remix"]) {
        const song = `Lose Control (${version})`;
        fetchImpl = async () => response({ items: [video(version, `Teddy Swims - ${song}`)] });
        assert.equal((await invoke(getYouTubeVideo, { song, artist: anchor.artist })).body.videoId, idFor(version));
    }
});

test("karaoke and commentary are rejected before official-label scoring", async () => {
    fetchImpl = async () => response({ items: [
        video("karaoke", "Teddy Swims - Lose Control (Official Karaoke Audio)"),
        video("commentary", "Teddy Swims - Lose Control (Official Video Reaction)")
    ] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).status, 404);
});

test("failed searches expire after five minutes rather than seven days", async () => {
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    fetchImpl = async () => response({ items: [] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).status, 404);
    const searches = requests.length;
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.cachedMiss, true);
    assert.equal(requests.length, searches);
    now += 5 * 60 * 1000 + 1;
    fetchImpl = async () => response({ items: [exactVideo] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, "correct____");
    assert.equal(requests.length, searches + 1);
});

test("successful lookups remain cached while old loosely ranked cache entries are bypassed", async () => {
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    global.videoCache = { "yt_lose control teddy swims": { videoId: "wrong-old-result", cachedAt: Date.now() } };
    fetchImpl = async () => response({ items: [exactVideo] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, "correct____");
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.cached, true);
    assert.equal(requests.length, 1);
    now += 7 * 24 * 60 * 60 * 1000 + 1;
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.cached, false);
    assert.equal(requests.length, 2);
});

for (const reason of ["forbidden", "accessNotConfigured", "ipRefererBlocked"]) {
    test(`non-quota 403 does not start a six-hour cooldown: ${reason}`, async () => {
        fetchImpl = async () => response({ error: { code: 403, errors: [{ reason }] } }, 403);
        const result = await invoke(getYouTubeVideo, anchor);
        assert.equal(result.status, 502);
        assert.equal(result.body.reason, "access_denied");
        assert.equal(global.youtubeCooldownUntil, 0);
        fetchImpl = async () => response({ items: [exactVideo] });
        assert.equal((await invoke(getYouTubeVideo, anchor)).body.videoId, "correct____");
    });
}

for (const reason of ["quotaExceeded", "dailyLimitExceeded"]) {
    test(`actual quota exhaustion starts the existing cooldown: ${reason}`, async () => {
        fetchImpl = async () => response({ error: { code: 403, errors: [{ reason }] } }, 403);
        assert.equal((await invoke(getYouTubeVideo, anchor)).body.reason, "quota_limited");
        assert.equal((await invoke(getYouTubeVideo, { query: "Different song" })).body.cooldown, true);
        assert.equal(requests.length, 1);
    });
}

test("short upstream rate limiting has no quota cooldown or negative song cache", async () => {
    fetchImpl = async () => response({ error: { code: 429, errors: [{ reason: "rateLimitExceeded" }] } }, 429);
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 429);
    assert.equal(result.body.reason, "rate_limited");
    assert.equal(global.youtubeCooldownUntil, 0);
    assert.equal(Object.keys(global.videoMissCache).length, 0);
});

test("invalid upstream JSON is not cached as a missing song", async () => {
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } });
    assert.equal((await invoke(getYouTubeVideo, anchor)).status, 502);
    assert.equal(Object.keys(global.videoMissCache).length, 0);
});

test("method, identity, configuration, and local rate-limit guards remain active", async () => {
    assert.equal((await invoke(getPlaylist, {}, "GET")).status, 405);
    assert.equal((await invoke(getYouTubeVideo, {}, "GET")).status, 405);
    assert.equal((await invoke(getYouTubeVideo, { song: "Lose Control" })).status, 400);
    assert.equal((await invoke(getYouTubeVideo, { query: "x".repeat(181) })).status, 413);
    delete process.env.OPENAI_API_KEY;
    assert.equal((await invoke(getPlaylist, { mood: "lonely" })).status, 500);
    delete process.env.YOUTUBE_API_KEY;
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.reason, "missing_key");
    global.youtubeRateLimit = { "regression-test": { count: 30, resetAt: Date.now() + 60000 } };
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.reason, "rate_limited");
    assert.equal(requests.length, 0);
});

// Run the actual inline frontend functions with a small DOM stub; no browser or dependencies required.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
function functionSource(start, end) {
    return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
}
class Element {
    constructor() { this.style = {}; this.children = []; this.attributes = {}; this.events = {}; this.isConnected = false; this.textContent = ""; this.innerText = ""; }
    appendChild(element) { this.children.push(element); element.isConnected = true; return element; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
    focus() {} scrollIntoView() {} remove() { this.isConnected = false; }
    set innerHTML(value) { this.markup = value; this.children = []; }
    get innerHTML() { return this.markup || ""; }
}
function textOf(element) { return [element.textContent, element.innerText, ...element.children.map(textOf)].join(" "); }
function frontend() {
    const elements = Object.fromEntries(["moodInput", "result", "continueBtn", "lastMood"].map(id => [id, new Element()]));
    const storage = new Map();
    const events = [];
    const context = vm.createContext({
        window: { location: { origin: "http://127.0.0.1:3000" } }, setTimeout: () => 0, clearTimeout() {},
        console, document: { getElementById: id => elements[id] || null, createElement: () => new Element(), createTextNode: text => Object.assign(new Element(), { textContent: text }) },
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
        currentPlaylist: [], continueCount: 0, isPlayingAll: false, MAX_SAVE_LIMIT: 100, YOUTUBE_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
        showMoodError() {}, clearMoodError() {}, clearStatusMessage() {}, stopPlayback() {}, loadSavedSongs() {}, showUpgradeBox() {}, showStatusMessage() {},
        preferredScrollBehavior: () => "auto", trackTune4Me: event => events.push(event), fetch: async () => { throw new Error("Unexpected frontend request"); }
    });
    vm.runInContext(functionSource("async function showMood(button)", "async function continuePlaylist()"), context);
    vm.runInContext(functionSource("async function continuePlaylist()", "// $$$$"), context);
    vm.runInContext(functionSource("function getVideoCacheKey(", "function closeYouTubePreview("), context);
    vm.runInContext(functionSource("function closeYouTubePreview(", "// PLAYBACK ENG"), context);
    vm.runInContext(functionSource("function saveSong(song, artist)", "function saveSongWithVideo("), context);
    return { context, elements, storage, events };
}

test("exact request survives generation, frontend rendering, and identity-based preview lookup", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor] }));
    const ui = frontend();
    ui.elements.moodInput.value = 'Please find "Lose Control" by Teddy Swims because I miss my ex';
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getPlaylist");
        const result = await invoke(getPlaylist, { ...JSON.parse(options.body), length: 2 });
        return response(result.body, result.status);
    };
    await ui.context.showMood();
    const rendered = JSON.parse(JSON.stringify(ui.context.currentPlaylist));
    assert.deepEqual(rendered[0], anchor);
    assert.ok(textOf(ui.elements.result).includes(playlistFixture().explanation));
    assert.ok(ui.events.includes("playlist_generated"));
    fetchImpl = async () => response({ items: [video("wrong", "Lose Control (Official Audio)", "OtherVEVO"), exactVideo] });
    assert.equal((await invoke(getYouTubeVideo, rendered[0])).body.videoId, "correct____");
});

test("structured titles and artists containing separators survive both frontend renderers", async () => {
    const song = { song: "A Title - With a Subtitle", artist: "Artist - With a Suffix" };
    aiReply(playlistFixture({ songs: [song, other] }));
    const result = await invoke(getPlaylist, { mood: "I miss home", length: 2 });
    const ui = frontend();
    ui.elements.moodInput.value = "I miss home";
    ui.context.fetch = async () => response(result.body);
    await ui.context.showMood();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.context.currentPlaylist[0])), song);
    ui.context.currentPlaylist = [];
    await ui.context.continuePlaylist();
    assert.ok(JSON.parse(JSON.stringify(ui.context.currentPlaylist)).some(item => item.song === song.song && item.artist === song.artist));
});

test("preview sends separate title and artist fields to the existing endpoint", async () => {
    const ui = frontend();
    vm.runInContext(functionSource("async function playSong(song, artist, playBtn)", "// PLAYBACK ENG"), ui.context);
    const slot = Object.assign(new Element(), { querySelectorAll: () => [] });
    ui.context.document.querySelectorAll = () => [];
    ui.context.setTimeout = () => {};
    ui.context.createYouTubePreviewWrapper = () => ({ wrapper: new Element(), closeBtn: new Element() });
    let sent;
    ui.context.fetch = async (url, options) => { sent = [url, JSON.parse(options.body)]; return response({ videoId: "correct____" }); };
    const button = { disabled: false, closest: () => ({ querySelector: () => slot }) };
    await ui.context.playSong(anchor.song, anchor.artist, button);
    assert.equal(sent[0], "/api/getYouTubeVideo");
    assert.equal(sent[1].song, anchor.song);
    assert.equal(sent[1].artist, anchor.artist);
});

test("browser cache bypasses old preview results without touching saved songs", () => {
    const ui = frontend();
    ui.storage.set("yt_lose control teddy swims", JSON.stringify({ videoId: "old-wrong", cachedAt: Date.now() }));
    ui.storage.set("savedSongs", JSON.stringify([anchor]));
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    ui.context.saveCachedVideo(anchor.song, anchor.artist, "correct____");
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), "correct____");
    assert.deepEqual(JSON.parse(ui.storage.get("savedSongs")), [anchor]);
});

test("saved-list capacity remains 100, including the 99-to-100 boundary", () => {
    const ui = frontend();
    ui.storage.set("saveLimit", "100");
    ui.storage.set("savedSongs", JSON.stringify(Array.from({ length: 99 }, (_, i) => ({ song: `Saved ${i}`, artist: "Artist" }))));
    ui.context.saveSong(anchor.song, anchor.artist);
    assert.equal(JSON.parse(ui.storage.get("savedSongs")).length, 100);
    ui.context.saveSong(other.song, other.artist);
    assert.equal(JSON.parse(ui.storage.get("savedSongs")).length, 100);
});

test("all inline scripts still parse", () => {
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});

for (const [song, artist, title] of [
    ["Shallow", "Lady Gaga & Bradley Cooper", "Lady Gaga, Bradley Cooper - Shallow (from A Star Is Born) (Official Music Video)"],
    ["Somebody That I Used to Know", "Gotye feat. Kimbra", "Gotye - Somebody That I Used To Know (feat. Kimbra) [Official Music Video]"],
    ["Big Black Car", "Gregory Alan Isakov", "Big Black Car"],
    ["Youth", "Daughter", "Daughter - Youth (Lyrics)"],
    ["The Night We Met", "Lord Huron", "Lord Huron - The Night We Met (Lyrics)"]
]) {
    test(`canonical identity tolerates legitimate upload formatting: ${song}`, async () => {
        fetchImpl = async () => response({ items: [video("formatted", title, artist + " - Topic")] });
        const result = await invoke(getYouTubeVideo, { song, artist });
        assert.equal(result.status, 200);
        assert.equal(result.body.videoId, idFor("formatted"));
        assert.equal(result.body.video.embeddable, true);
        assert.equal(detailRequests.length, 1);
    });
}

function verifiedVideo(item, overrides = {}) {
    return { id: item.id.videoId, snippet: item.snippet,
        status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed" },
        contentDetails: {}, ...overrides };
}

for (const [label, overrides] of [
    ["embedding prohibited", { status: { embeddable: false, privacyStatus: "public", uploadStatus: "processed" } }],
    ["private video", { status: { embeddable: true, privacyStatus: "private", uploadStatus: "processed" } }],
    ["deleted upload", { status: { embeddable: true, privacyStatus: "public", uploadStatus: "deleted" } }],
    ["age restriction", { contentDetails: { contentRating: { ytRating: "ytAgeRestricted" } } }],
    ["blocked region", { contentDetails: { regionRestriction: { blocked: ["US"] } } }],
    ["region not allowed", { contentDetails: { regionRestriction: { allowed: ["CA"] } } }],
    ["blocked everywhere", { contentDetails: { regionRestriction: { allowed: [] } } }]
]) {
    test(`matched but unavailable is distinct from a lookup miss: ${label}`, async () => {
        fetchImpl = async () => response({ items: [exactVideo] });
        detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, overrides)] });
        const result = await invoke(getYouTubeVideo, { ...anchor, regionCode: "US" });
        assert.equal(result.status, 404);
        assert.equal(result.body.reason, "unplayable");
        assert.equal(Object.keys(global.videoMissCache).length, 0);
        assert.equal(detailRequests.length, 1, "repeated search stages reuse the status check");
    });
}

test("a missing videos.list resource is unavailable, not a usable search result", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    detailsImpl = async () => response({ items: [] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.reason, "unplayable");
});

test("the API chooses a playable alternative instead of a prohibited candidate", async () => {
    const alternative = video("alternate", "Lose Control", "Teddy Swims - Topic");
    fetchImpl = async () => response({ items: [exactVideo, alternative] });
    detailsImpl = async () => response({ items: [
        verifiedVideo(exactVideo, { status: { embeddable: false, privacyStatus: "public", uploadStatus: "processed" } }),
        verifiedVideo(alternative)
    ] });
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.body.videoId, alternative.id.videoId);
    assert.equal(result.body.video.title, "Lose Control");
});

test("runtime-failed IDs bypass positive cache and cannot be selected again", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    await invoke(getYouTubeVideo, anchor);
    const alternative = video("alternate", "Lose Control", "Teddy Swims - Topic");
    fetchImpl = async () => response({ items: [exactVideo, alternative] });
    const result = await invoke(getYouTubeVideo, { ...anchor, excludeVideoIds: [exactVideo.id.videoId] });
    assert.equal(result.body.videoId, alternative.id.videoId);
    assert.equal(result.body.cached, false);
    const empty = await invoke(getYouTubeVideo, { ...anchor, excludeVideoIds: [exactVideo.id.videoId, alternative.id.videoId] });
    assert.equal(empty.body.reason, "unplayable");
    assert.equal(Object.keys(global.videoMissCache).length, 0);
});

test("a status-verification failure is an upstream error, not a song miss", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    detailsImpl = async () => response({ error: { errors: [{ reason: "accessNotConfigured" }] } }, 403);
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 502);
    assert.equal(result.body.reason, "access_denied");
    assert.equal(Object.keys(global.videoMissCache).length, 0);
});

test("invalid video IDs and changed song identity cannot be returned", async () => {
    const invalid = { ...exactVideo, id: { videoId: "not-a-valid-video-id" } };
    fetchImpl = async () => response({ items: [invalid] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).body.reason, "no_result");
    assert.equal(detailRequests.length, 0);
    global.videoMissCache = {};
    fetchImpl = async () => response({ items: [exactVideo] });
    detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, { snippet: { title: "Unrelated Song", channelTitle: "Other Artist" } })] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).status, 404);
});

test("country-specific availability is not reused across countries", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, { contentDetails: { regionRestriction: { blocked: ["US"] } } })] });
    assert.equal((await invoke(getYouTubeVideo, { ...anchor, regionCode: "US" })).body.reason, "unplayable");
    const result = await invoke(getYouTubeVideo, { ...anchor, regionCode: "CA" });
    assert.equal(result.status, 200);
    assert.equal(result.body.video.regionChecked, "CA");
});

function playerFrontend() {
    const ui = frontend();
    const players = [];
    ui.context.window.YT = { Player: function(iframe, options) {
        this.destroy = () => { this.destroyed = true; };
        players.push({ iframe, events: options.events, instance: this });
    } };
    ui.context.document.querySelectorAll = () => [];
    const slot = new Element();
    const button = { disabled: false, closest: () => ({ querySelector: () => slot }) };
    return { ...ui, players, slot, button };
}

test("a verified lookup is cached only after actual playback starts", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response({ videoId: exactVideo.id.videoId });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.match(ui.players[0].iframe.src, /enablejsapi=1/);
    assert.match(ui.players[0].iframe.src, /origin=http%3A%2F%2F127.0.0.1%3A3000/);
    assert.equal(ui.players[0].iframe.referrerPolicy, "strict-origin-when-cross-origin");
    ui.players[0].events.onStateChange({ data: 1 });
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), exactVideo.id.videoId);
});

test("an embed failure clears a cached ID, excludes it, and retries once", async () => {
    const ui = playerFrontend();
    ui.context.saveCachedVideo(anchor.song, anchor.artist, exactVideo.id.videoId);
    let sent;
    ui.context.fetch = async (url, options) => {
        sent = JSON.parse(options.body);
        return response({ videoId: idFor("alternate") });
    };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 101 });
    assert.deepEqual(sent.excludeVideoIds, [exactVideo.id.videoId]);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.equal(ui.players[0].instance.destroyed, true);
    assert.equal(ui.players.length, 2);
    ui.players[1].events.onStateChange({ data: 1 });
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), idFor("alternate"));
    await ui.players[1].events.onError({ data: 150 });
    assert.equal(ui.players.length, 2);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.match(textOf(ui.slot), /embedded player/);
    assert.match(textOf(ui.slot), /Listen on YouTube/);
});

test("removed videos receive a distinct message after the bounded retry", async () => {
    const ui = playerFrontend();
    let requests = 0;
    ui.context.fetch = async () => response({ videoId: requests++ ? idFor("alternate") : exactVideo.id.videoId });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 100 });
    await ui.players[1].events.onError({ data: 100 });
    assert.equal(requests, 2);
    assert.match(textOf(ui.slot), /no longer available/);
});

test("player identification errors do not masquerade as lookup misses or retry songs", async () => {
    const ui = playerFrontend();
    let requests = 0;
    ui.context.fetch = async () => { requests++; return response({ videoId: exactVideo.id.videoId }); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 153 });
    assert.equal(requests, 1);
    assert.match(textOf(ui.slot), /verify this player/);
    assert.doesNotMatch(textOf(ui.slot), /find a reliable preview/);
});

test("autoplay blocking keeps the player available and asks the user to press Play", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response({ videoId: exactVideo.id.videoId });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.players[0].events.onAutoplayBlocked();
    assert.match(textOf(ui.slot), /Press Play in the video/);
    assert.equal(ui.players[0].instance.destroyed, undefined);
});

test("network failures still provide a usable external-listening fallback", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => { throw new TypeError("Network error"); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.match(textOf(ui.slot), /lookup is having trouble/);
    assert.match(textOf(ui.slot), /Listen on YouTube/);
});

test("stopping playback also cancels a pending lookup", async () => {
    const ui = playerFrontend();
    ui.context.playlistTimer = null;
    vm.runInContext(functionSource("function stopPlayback()", "function playSavedSongs("), ui.context);
    let finish;
    ui.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.context.stopPlayback();
    finish(response({ videoId: exactVideo.id.videoId }));
    await pending;
    assert.equal(ui.players.length, 0);
});

test("alternative search returns distinct verified matches and prefers the artist source", async () => {
    const generic = [1, 2, 3].map(i => video(`generic${i}`, "Teddy Swims - Lose Control (Official Audio)", "Official Music VEVO Topic"));
    const official = video("artist", "Teddy Swims - Lose Control (Official Video)");
    let stage = 0;
    fetchImpl = async () => response({ items: stage++ ? [official, ...generic, video("wrong", "Lose Control", "Other Artist - Topic")] : generic });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.videoId, official.id.videoId);
    assert.equal(requests.length, 2, "a weak initial source triggers one official-source fallback");
    assert.equal(result.body.candidates.length, 4);
    assert.equal(new Set(result.body.candidates.map(item => item.videoId)).size, 4);
    assert.ok(result.body.candidates.every(item => item.video.embeddable));
    assert.equal(new URL(requests[0][0]).searchParams.get("maxResults"), "25");
});

test("generic lyric uploads do not stop the search before an official-video artist source", async () => {
    const lyrics = [1, 2, 3].map(i => video(`lyrics${i}`, "Teddy Swims - Lose Control (Lyrics)", "Lyric Channel"));
    const topic = video("topic", "Lose Control", "Teddy Swims - Topic");
    fetchImpl = async url => response({ items: new URL(url).searchParams.get("q") === "Teddy Swims Lose Control official video" ? [topic] : lyrics });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(requests.length, 3);
    assert.equal(result.body.videoId, topic.id.videoId);
});

test("verified alternative pools can exclude a failed ID without repeating upstream searches", async () => {
    const items = [1, 2, 3, 4, 5, 6].map(i => video(`variant${i}`, "Lose Control", "Teddy Swims - Topic"));
    fetchImpl = async () => response({ items });
    const first = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(first.body.candidates.length, 5);
    const count = requests.length;
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true, excludeVideoIds: [first.body.videoId] });
    assert.equal(result.body.cached, true);
    assert.equal(result.body.candidates.length, 4);
    assert.ok(result.body.candidates.every(item => item.videoId !== first.body.videoId));
    assert.equal(requests.length, count);
});

test("unrequested guest versions are excluded and same-artist live versions remain labelled", async () => {
    const studios = [1, 2, 3, 4, 5].map(i => video(`studio${i}`, "Lord Huron - The Night We Met (Lyrics)", "Lyric Channel"));
    const guest = video("guest", "The Night We Met (feat. Phoebe Bridgers)", "Lord Huron - Topic");
    const live = video("live", "Lord Huron - The Night We Met (Alive From Whispering Pines)", "Lord Huron");
    fetchImpl = async () => response({ items: [guest, live, ...studios] });
    const result = await invoke(getYouTubeVideo, { song: "The Night We Met", artist: "Lord Huron", includeAlternatives: true });
    assert.equal(result.body.candidates.length, 5);
    assert.ok(result.body.candidates.every(item => item.videoId !== guest.id.videoId));
    assert.equal(result.body.candidates.at(-1).videoId, live.id.videoId);
    assert.equal(result.body.candidates.at(-1).video.version, "live");
    assert.equal(result.body.candidates[0].video.version, "studio");
});

test("an incorrect Roslyn artist credit never causes a Bon Iver recording to be relabelled", async () => {
    fetchImpl = async () => response({ items: [video("roslyn", "Bon Iver & St. Vincent - Roslyn (Official Audio)", "Bon Iver")] });
    const result = await invoke(getYouTubeVideo, { song: "Roslyn", artist: "Robert Pattinson & St. Vincent", includeAlternatives: true });
    assert.equal(result.status, 404);
    assert.equal(result.body.reason, "no_result");
    assert.equal(detailRequests.length, 0);
});

function candidateResponse(count = 5) {
    const candidates = Array.from({ length: count }, (_, i) => ({ videoId: idFor(`candidate${i}`),
        video: { title: "Teddy Swims - Lose Control", channelTitle: "Teddy Swims", embeddable: true, version: "studio" } }));
    return { ...candidates[0], candidates };
}

test("five same-identity candidates are attempted before an embedding-restriction fallback", async () => {
    const ui = playerFrontend();
    let lookups = 0;
    ui.context.fetch = async (url, options) => {
        lookups++;
        assert.equal(JSON.parse(options.body).includeAlternatives, true);
        return response(candidateResponse());
    };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    for (let i = 0; i < 5; i++) await ui.players[i].events.onError({ data: 101 });
    assert.equal(ui.players.length, 5);
    assert.equal(lookups, 1, "retrying verified candidates does not multiply lookup requests");
    assert.match(textOf(ui.slot), /embedded player/);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
});

test("a later successful candidate is retained without playing or caching unrelated alternatives", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    for (let i = 0; i < 3; i++) await ui.players[i].events.onError({ data: 100 });
    ui.players[3].events.onStateChange({ data: 1 });
    assert.equal(ui.players.length, 4);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), idFor("candidate3"));
    assert.match(textOf(ui.slot), /Teddy Swims/);
});

test("duplicate IDs in a pool cannot create a retry loop", async () => {
    const ui = playerFrontend();
    const data = candidateResponse(2);
    data.candidates.push(data.candidates[0], data.candidates[1]);
    ui.context.fetch = async () => response(data);
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 150 });
    await ui.players[1].events.onError({ data: 150 });
    assert.equal(ui.players.length, 2);
    assert.match(textOf(ui.slot), /embedded player/);
});

test("a player-identification failure does not cycle through otherwise valid recordings", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 153 });
    assert.equal(ui.players.length, 1);
    assert.match(textOf(ui.slot), /verify this player/);
});

test("autoplay blocking leaves alternatives untouched and retains manual Play", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.players[0].events.onAutoplayBlocked();
    assert.equal(ui.players.length, 1);
    assert.match(textOf(ui.slot), /Press Play in the video/);
    assert.equal(ui.players[0].instance.destroyed, undefined);
});

for (const [reason, status, warning] of [["rateLimitExceeded", 429, "rate_limited"], ["backendError", 503, "upstream_error"]]) {
    test(`a later search failure preserves already-verified candidates: ${reason}`, async () => {
        let stage = 0;
        fetchImpl = async () => stage++ ? response({ error: { errors: [{ reason }] } }, status) : response({ items: [genericExactVideo] });
        const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
        assert.equal(result.status, 200);
        assert.equal(result.body.videoId, exactVideo.id.videoId);
        assert.equal(result.body.warning, warning);
        assert.equal(result.body.candidates.length, 1);
        assert.equal(detailRequests.length, 1);
        assert.equal(Object.keys(global.videoMissCache).length, 0);
        const cached = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
        assert.equal(cached.body.cached, true);
        assert.equal(cached.body.warning, warning);
        assert.equal(requests.length, 2);
    });
}

test("identical concurrent server lookups share one upstream request and release their flight", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fetchImpl = async () => { await gate; return response({ items: [exactVideo] }); };
    const first = invoke(getYouTubeVideo, anchor);
    const second = invoke(getYouTubeVideo, anchor);
    assert.equal(requests.length, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map(result => result.body.cacheSource), ["upstream", "inflight"]);
    assert.ok(results.every(result => result.body.videoId === exactVideo.id.videoId));
    assert.equal(detailRequests.length, 1);
    assert.equal(global.youtubeRateLimit["regression-test"].count, 1);
    assert.equal(global.youtubeLookups.size, 0);
});

test("server deduplication keeps country and failed-ID exclusions separate", async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fetchImpl = async () => { await gate; return response({ items: [exactVideo] }); };
    const first = invoke(getYouTubeVideo, { ...anchor, regionCode: "US" });
    const second = invoke(getYouTubeVideo, { ...anchor, regionCode: "CA" });
    const third = invoke(getYouTubeVideo, { ...anchor, regionCode: "US", excludeVideoIds: [exactVideo.id.videoId] });
    assert.equal(requests.length, 3);
    release();
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(results.map(result => result.status), [200, 200, 404]);
    assert.equal(results[2].body.videoId, undefined);
    assert.equal(global.youtubeLookups.size, 0);
});

test("rate backoff grows to a bound without sleeping or contacting YouTube during the pause", async () => {
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    fetchImpl = async () => response({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    for (const delay of [5, 10, 20, 40, 60, 60]) {
        const limited = await invoke(getYouTubeVideo, anchor);
        assert.equal(limited.body.reason, "rate_limited");
        assert.equal(limited.body.retryAfterSeconds, delay);
        assert.equal(limited.headers["Retry-After"], String(delay));
        assert.deepEqual(limited.body.diagnostics, { source: "youtube", upstreamStatus: 403,
            upstreamReason: "userRateLimitExceeded", operation: "search" });
        const calls = requests.length;
        const paused = await invoke(getYouTubeVideo, other);
        assert.equal(paused.body.diagnostics.source, "backoff");
        assert.equal(requests.length, calls);
        assert.equal(global.youtubeCooldownUntil, 0);
        now += delay * 1000 + 1;
    }
    fetchImpl = async () => response({ items: [exactVideo] });
    assert.equal((await invoke(getYouTubeVideo, anchor)).status, 200);
    assert.equal(global.youtubeRateBackoff, null);
    assert.equal(global.youtubeLookups.size, 0);
});

for (const [header, seconds] of [["90", 90], ["9999999", 300], ["invalid", 5],
    [new Date(1800000000000 + 45000).toUTCString(), 45]]) {
    test(`safe Retry-After handling: ${header}`, async () => {
        mock.method(Date, "now", () => 1800000000000);
        fetchImpl = async () => ({ ...response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429),
            headers: { get: () => header } });
        const result = await invoke(getYouTubeVideo, anchor);
        assert.equal(result.body.retryAfterSeconds, seconds);
    });
}

test("quota diagnostics survive the cooldown and never include arbitrary upstream messages or secrets", async () => {
    fetchImpl = async () => response({ error: { message: "secret-test-key https://example.test/?key=secret-test-key",
        errors: [{ reason: "quotaExceeded", message: "secret-test-key" }] } }, 403);
    const first = await invoke(getYouTubeVideo, anchor);
    const second = await invoke(getYouTubeVideo, other);
    assert.equal(first.body.reason, "quota_limited");
    assert.equal(first.body.retryAfterSeconds, 21600);
    assert.equal(first.body.diagnostics.upstreamReason, "quotaExceeded");
    assert.equal(second.body.diagnostics.source, "quota_cooldown");
    assert.equal(second.body.diagnostics.upstreamStatus, 403);
    assert.doesNotMatch(JSON.stringify([first, second]), /secret-test-key|example\.test|test-only/);
    assert.equal(requests.length, 1);
});

test("unknown upstream reason strings are excluded from public diagnostics", async () => {
    fetchImpl = async () => response({ error: { errors: [{ reason: "secret-test-key" }] } }, 429);
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.body.diagnostics.upstreamReason, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});

test("the local guard is distinct and verified cache hits bypass its lookup allowance", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    await invoke(getYouTubeVideo, anchor);
    global.youtubeRateLimit["regression-test"] = { count: 30, resetAt: Date.now() + 60000 };
    const cached = await invoke(getYouTubeVideo, anchor);
    assert.equal(cached.body.cacheSource, "server_cache");
    assert.equal(cached.status, 200);
    const limited = await invoke(getYouTubeVideo, other);
    assert.equal(limited.body.diagnostics.source, "local_guard");
    assert.ok(limited.body.retryAfterSeconds > 0);
    assert.equal(requests.length, 1);
});

test("a smaller verified pool is reused without expansion while another lookup is throttled", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    await invoke(getYouTubeVideo, anchor);
    fetchImpl = async () => response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429);
    await invoke(getYouTubeVideo, other);
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.cacheSource, "server_cache");
    assert.equal(result.body.videoId, exactVideo.id.videoId);
    assert.equal(result.body.warning, null);
    const calls = requests.length;
    const reused = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(reused.body.videoId, exactVideo.id.videoId);
    const excluded = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true, excludeVideoIds: [exactVideo.id.videoId] });
    assert.equal(excluded.status, 429);
    assert.equal(excluded.body.videoId, undefined);
    assert.equal(requests.length, calls);
});

test("browser shares lookups and reuses candidate pools while respecting failed IDs and expiry", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    ui.context.Date = { now: () => now };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    ui.context.fetch = async () => { calls++; await gate; return response(candidateResponse()); };
    const first = ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    const second = ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    assert.equal(calls, 1);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[1].data.cacheSource, "browser_inflight");
    const cached = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, [idFor("candidate0")]);
    assert.equal(cached.data.cacheSource, "browser_candidates");
    assert.equal(cached.data.videoId, idFor("candidate1"));
    assert.equal(calls, 1);
    now += 5 * 60 * 1000 + 1;
    await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    assert.equal(calls, 2);
    assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 0);
});

test("failed browser requests release their deduplication entry for a later retry", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => { throw new TypeError("Network failed"); };
    await assert.rejects(ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []), /Network failed/);
    assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 0);
    ui.context.fetch = async () => response(candidateResponse());
    assert.equal((await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, [])).status, 200);
});

test("browser backoff blocks repeated requests and a timed retry resumes lookup", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    ui.context.Date = { now: () => now };
    const timers = [];
    ui.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    let calls = 0;
    ui.context.fetch = async () => { calls++; return response({ reason: "rate_limited", retryAfterSeconds: 5 }, 429); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(ui.players.length, 0);
    assert.match(textOf(ui.slot), /lookup is temporarily limited/);
    const retry = ui.slot.children[0].children.find(child => child.className === "retryPreviewBtn");
    assert.equal(retry.disabled, true);
    await retry.events.click();
    assert.equal(calls, 1);
    assert.equal((await ui.context.lookupYouTubePreview(other.song, other.artist, [])).data.cacheSource, "browser_backoff");
    assert.equal(calls, 1);
    now += 5001;
    timers.find(timer => timer.delay === 1000).callback();
    timers.find(timer => timer.delay === 5000).callback();
    assert.equal(retry.disabled, false);
    ui.context.fetch = async () => { calls++; return response(candidateResponse()); };
    await retry.events.click();
    assert.equal(calls, 2);
    assert.equal(ui.players.length, 1);
});

test("browser can use an existing verified pool during a different song's rate pause", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    ui.context.fetch = async () => response({ reason: "rate_limited", retryAfterSeconds: 20 }, 429);
    await ui.context.lookupYouTubePreview(other.song, other.artist, []);
    const result = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, [idFor("candidate0")]);
    assert.equal(result.ok, true);
    assert.equal(result.data.videoId, idFor("candidate1"));
    assert.equal(result.data.cacheSource, "browser_candidates");
});

test("a partial successful lookup also pauses unrelated browser lookups on its rate warning", async () => {
    const ui = playerFrontend();
    let calls = 0;
    ui.context.fetch = async () => { calls++; return response({ ...candidateResponse(), warning: "rate_limited", retryAfterSeconds: 10 }); };
    assert.equal((await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, [])).ok, true);
    const otherResult = await ui.context.lookupYouTubePreview(other.song, other.artist, []);
    assert.equal(otherResult.status, 429);
    assert.equal(otherResult.data.reason, "rate_limited");
    assert.equal(calls, 1);
});

test("attempt, readiness and playback-state logs identify IDs and cache sources without caching readiness", async () => {
    const ui = playerFrontend();
    const logs = [];
    ui.context.console = { log: (event, data) => logs.push({ event, data }), warn() {}, error() {} };
    ui.context.fetch = async () => response({ ...candidateResponse(), cacheSource: "server_cache" });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const attempt = logs.find(log => log.event === "youtube_preview_attempt");
    assert.equal(attempt.data.videoId, idFor("candidate0"));
    assert.equal(attempt.data.cacheSource, "server_cache");
    ui.players[0].events.onReady();
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.ok(logs.some(log => log.event === "youtube_preview_player_ready" && log.data.videoId === idFor("candidate0")));
    ui.players[0].events.onStateChange({ data: 1 });
    assert.ok(logs.some(log => log.event === "youtube_preview_player_state" && log.data.state === 1));
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), idFor("candidate0"));
    ui.button.disabled = false;
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.ok(logs.some(log => log.event === "youtube_preview_attempt" && log.data.cacheSource === "browser_cache"));
});

test("a player that never becomes ready has a distinct timeout and does not cycle song IDs", async () => {
    const ui = playerFrontend();
    const timers = new Map();
    ui.context.setTimeout = (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; };
    ui.context.clearTimeout = token => timers.delete(token);
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const readiness = [...timers.values()].find(timer => timer.delay === 15000);
    await readiness.callback();
    assert.match(textOf(ui.slot), /did not become ready/);
    assert.equal(ui.players.length, 1);
    assert.equal(ui.players[0].instance.destroyed, true);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
});

test("player readiness cancels its timeout and disposed players cannot emit readiness logs", async () => {
    const ui = playerFrontend();
    const timers = new Map();
    ui.context.setTimeout = (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token; };
    ui.context.clearTimeout = token => timers.delete(token);
    const logs = [];
    ui.context.console = { log: (...args) => logs.push(args), warn() {}, error() {} };
    ui.context.fetch = async () => response(candidateResponse());
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.players[0].events.onReady();
    assert.equal([...timers.values()].some(timer => timer.delay === 15000), false);
    ui.context.destroyYouTubePreview(ui.slot.children[0]);
    const count = logs.length;
    ui.players[0].events.onReady();
    assert.equal(logs.length, count);
});

test("permanent external buttons have a distinct label from failure fallbacks", () => {
    assert.equal((html.match(/ytBar\.textContent = "Open YouTube"/g) || []).length, 3);
    assert.doesNotMatch(html, /ytBar\.textContent = "▶ Listen on YouTube"/);
});

test("an expired cached rate warning does not announce a fresh service pause", async () => {
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    let stage = 0;
    fetchImpl = async () => stage++ ? response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429)
        : response({ items: [genericExactVideo] });
    const first = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(first.body.warning, "rate_limited");
    assert.equal(first.body.retryAfterSeconds, 5);
    now += 5001;
    const cached = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(cached.body.warning, null);
    assert.equal(cached.body.retryAfterSeconds, undefined);
    assert.equal(cached.body.cacheSource, "server_cache");
    assert.equal(requests.length, 2);
});

test("a server cache success cannot clear a browser pause created by a concurrent lookup", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    ui.context.Date = { now: () => now };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    ui.context.fetch = async (url, options) => {
        calls++;
        if (JSON.parse(options.body).song === anchor.song) {
            await gate;
            return response({ ...candidateResponse(), cached: true, cacheSource: "server_cache" });
        }
        return response({ reason: "rate_limited", retryAfterSeconds: 30 }, 429);
    };
    const pending = ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    await ui.context.lookupYouTubePreview(other.song, other.artist, []);
    release();
    await pending;
    const paused = await ui.context.lookupYouTubePreview("Another song", "Another artist", []);
    assert.equal(paused.status, 429);
    assert.equal(paused.data.cacheSource, "browser_backoff");
    assert.equal(calls, 2);
});

test("a retry control from a stopped preview cannot restart playback", async () => {
    const ui = playerFrontend();
    const timers = [];
    ui.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    let calls = 0;
    ui.context.fetch = async () => { calls++; return response({ reason: "rate_limited", retryAfterSeconds: 5 }, 429); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const retry = ui.slot.children[0].children.find(child => child.className === "retryPreviewBtn");
    ui.context.window.tune4mePreviewRequest++;
    timers.find(timer => timer.delay === 5000).callback();
    assert.equal(retry.disabled, true);
    await retry.events.click();
    assert.equal(calls, 1);
    assert.equal(ui.players.length, 0);
});

test("browser backoff increases even when separate server invocations always suggest five seconds", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    ui.context.Date = { now: () => now };
    let calls = 0;
    ui.context.fetch = async () => { calls++; return response({ reason: "rate_limited", retryAfterSeconds: 5 }, 429); };
    for (const seconds of [5, 10, 20, 40, 60, 60]) {
        const result = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
        assert.equal(result.data.retryAfterSeconds, seconds);
        const count = calls;
        await ui.context.lookupYouTubePreview(other.song, other.artist, []);
        assert.equal(calls, count);
        now += seconds * 1000 + 1;
    }
    now += 300001;
    const afterIdle = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    assert.equal(afterIdle.data.retryAfterSeconds, 5);
});

test("quota retry UI keeps the longer service delay distinct and leaves saved songs intact", async () => {
    const ui = playerFrontend();
    ui.storage.set("savedSongs", JSON.stringify([anchor]));
    const timers = [];
    ui.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    ui.context.fetch = async () => response({ reason: "quota_limited", retryAfterSeconds: 21600,
        diagnostics: { source: "youtube", upstreamReason: "quotaExceeded", upstreamStatus: 403 } }, 429);
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.match(textOf(ui.slot), /quota is temporarily exhausted/);
    const retry = ui.slot.children[0].children.find(child => child.className === "retryPreviewBtn");
    assert.equal(retry.disabled, true);
    assert.ok(timers.some(timer => timer.delay === 21600000));
    assert.equal(ui.players.length, 0);
    assert.deepEqual(JSON.parse(ui.storage.get("savedSongs")), [anchor]);
});

for (const [song, artist, title, channel] of [
    ["Lose Control", "Teddy Swims", "Teddy Swims - Lose Control (Official Audio)", "Teddy Swims"],
    ["The Night We Met", "Lord Huron", "Lord Huron - The Night We Met (Official Audio)", "LordHuron"],
    ["Youth", "Daughter", "Youth", "Daughter - Topic"]
]) {
    test(`search budget: ${song} resolves on its first verified artist-source result`, async () => {
        const match = video("firstmatch", title, channel);
        fetchImpl = async () => response({ items: [match] });
        const result = await invoke(getYouTubeVideo, { song, artist, includeAlternatives: true });
        assert.equal(result.status, 200);
        assert.equal(result.body.videoId, match.id.videoId);
        assert.equal(result.body.candidates.length, 1, "one strong candidate does not force more searches");
        assert.equal(result.body.nextSearchStage, 1);
        assert.equal(requests.length, 1);
        assert.equal(detailRequests.length, 1);
        const params = new URL(requests[0][0]).searchParams;
        assert.equal(params.get("q"), `${artist} ${song}`);
        assert.equal(params.has("videoCategoryId"), false);
        assert.equal(params.get("maxResults"), "25");
        assert.equal(params.get("videoEmbeddable"), "true");
        assert.equal(params.get("videoSyndicated"), "true");
        const cached = await invoke(getYouTubeVideo, { song, artist, includeAlternatives: true });
        assert.equal(cached.body.cacheSource, "server_cache");
        assert.equal(cached.body.nextSearchStage, 1);
        assert.equal(requests.length, 1, "reusing this pool adds zero search requests");
    });
}

const expectedQueries = ["Teddy Swims Lose Control", "Teddy Swims Lose Control official audio",
    "Teddy Swims Lose Control official video", "Teddy Swims Lose Control lyric video"];

for (const successStage of [1, 2, 3]) {
    test(`search budget: fallback stage ${successStage} stops at the first strong verified match`, async () => {
        fetchImpl = async url => response({ items: new URL(url).searchParams.get("q") === expectedQueries[successStage]
            ? [exactVideo] : [] });
        const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
        assert.equal(result.status, 200);
        assert.equal(result.body.videoId, exactVideo.id.videoId);
        assert.equal(requests.length, successStage + 1);
        assert.equal(detailRequests.length, 1);
        assert.equal(result.body.nextSearchStage, successStage + 1);
        assert.deepEqual(requests.map(([url]) => new URL(url).searchParams.get("q")), expectedQueries.slice(0, successStage + 1));
        assert.equal(new URL(requests[1][0]).searchParams.get("videoCategoryId"), "10");
    });
}

test("search budget: a first-page pool preserves verified alternatives and official preference in one search", async () => {
    const lyrics = video("lyricsnew", "Teddy Swims - Lose Control (Lyrics)", "Lyric Channel");
    const official = video("officialnew", "Teddy Swims - Lose Control (Official Video)", "TeddySwimsVEVO");
    const topic = video("topicnew", "Lose Control", "Teddy Swims - Topic");
    const blocked = video("blockednew", "Teddy Swims - Lose Control (Official Audio)");
    fetchImpl = async () => response({ items: [lyrics, official, topic, official, blocked,
        video("wrongnew", "Lose Control", "Other Artist - Topic"),
        video("covernew", "Teddy Swims - Lose Control (Cover)", "Cover Channel")] });
    const normalDetails = detailsImpl;
    detailsImpl = async url => {
        const result = await (await normalDetails(url)).json();
        result.items.find(item => item.id === blocked.id.videoId).status.embeddable = false;
        return response(result);
    };
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 1);
    assert.equal(result.body.videoId, official.id.videoId);
    assert.deepEqual(new Set(result.body.candidates.map(item => item.videoId)),
        new Set([lyrics.id.videoId, official.id.videoId, topic.id.videoId]));
    assert.ok(result.body.candidates.every(item => item.video.embeddable));
});

test("search budget: incorrect matches exhaust four unique searches and never enter status verification", async () => {
    fetchImpl = async () => response({ items: [
        video("wrongwho", "Lose Control", "Other Artist - Topic"),
        video("wrongwhat", "Teddy Swims - Lose Control Again", "Teddy Swims"),
        video("wrongcover", "Teddy Swims - Lose Control (Cover)", "Cover Channel")
    ] });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 404);
    assert.equal(result.body.reason, "no_result");
    assert.equal(result.body.nextSearchStage, 4);
    assert.equal(requests.length, 4);
    assert.equal(detailRequests.length, 0);
    assert.deepEqual(requests.map(([url]) => new URL(url).searchParams.get("q")), expectedQueries);
    await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(requests.length, 4, "a cached miss does not repeat discovery");
});

test("search budget: metadata-prohibited matches search all fallbacks but verify repeated IDs only once", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    detailsImpl = async () => response({ items: [{ id: exactVideo.id.videoId, snippet: exactVideo.snippet,
        status: { embeddable: false, privacyStatus: "public", uploadStatus: "processed" }, contentDetails: {} }] });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 404);
    assert.equal(result.body.reason, "unplayable");
    assert.equal(requests.length, 4);
    assert.equal(detailRequests.length, 1);
    assert.equal(result.body.videoId, undefined);
});

test("search budget: only generic matching sources use bounded fallbacks and remain available", async () => {
    fetchImpl = async () => response({ items: [genericExactVideo] });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.videoId, exactVideo.id.videoId);
    assert.equal(result.body.nextSearchStage, 4);
    assert.equal(requests.length, 4);
    assert.equal(detailRequests.length, 1);
});

test("search budget: an artist live source cannot stop discovery of an unrequested studio recording", async () => {
    const live = video("livenew", "Teddy Swims - Lose Control (Live)", "Teddy Swims");
    const genericStudio = video("otherstudio", "Teddy Swims - Lose Control (Lyrics)", "Lyric Channel");
    let stage = 0;
    fetchImpl = async () => response({ items: stage++ ? [exactVideo] : [live, genericStudio] });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(requests.length, 2);
    assert.equal(result.body.videoId, exactVideo.id.videoId);
    assert.equal(result.body.video.version, "studio");
    assert.ok(result.body.candidates.some(item => item.videoId === live.id.videoId && item.video.version === "live"));
});

for (const coldContinuation of [false, true]) {
    test(`search budget: playback reuses its first pool before continuing discovery (${coldContinuation ? "new" : "warm"} runtime)`, async () => {
        const ui = playerFrontend();
        const firstPool = [exactVideo, video("initialalt", "Lose Control", "Teddy Swims - Topic")];
        const fallback = video("ondemand", "Teddy Swims - Lose Control (Official Video)");
        fetchImpl = async url => response({ items: new URL(url).searchParams.get("q") === expectedQueries[0] ? firstPool : [fallback] });
        const endpointRequests = [];
        ui.context.fetch = async (url, options) => {
            const body = JSON.parse(options.body);
            endpointRequests.push(body);
            if (coldContinuation && endpointRequests.length > 1) global.videoCache = {};
            const result = await invoke(getYouTubeVideo, body);
            return response(result.body, result.status);
        };
        await ui.context.playSong(anchor.song, anchor.artist, ui.button);
        assert.equal(requests.length, 1);
        await ui.players[0].events.onError({ data: 101 });
        assert.equal(ui.players.length, 2);
        assert.equal(requests.length, 1, "the existing alternative costs no new search");
        assert.equal(endpointRequests.length, 1);
        await ui.players[1].events.onError({ data: 100 });
        assert.equal(endpointRequests.length, 2);
        assert.equal(endpointRequests[1].startSearchStage, 1);
        assert.deepEqual(endpointRequests[1].excludeVideoIds, firstPool.map(item => item.id.videoId));
        assert.equal(requests.length, 2, "continuation starts at official audio instead of repeating the bare query");
        assert.deepEqual(requests.map(([url]) => new URL(url).searchParams.get("q")), expectedQueries.slice(0, 2));
        assert.equal(new URL(ui.players[2].iframe.src).pathname.split("/").pop(), fallback.id.videoId);
        ui.players[2].events.onStateChange({ data: 1 });
        assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), fallback.id.videoId);
    });
}

test("search budget: repeated playback failures continue each remaining stage once before external fallback", async () => {
    const ui = playerFrontend();
    fetchImpl = async url => {
        const stage = expectedQueries.indexOf(new URL(url).searchParams.get("q"));
        assert.ok(stage >= 0);
        return response({ items: [video(`stage${stage}`, "Teddy Swims - Lose Control (Official Audio)")] });
    };
    let endpointCalls = 0;
    ui.context.fetch = async (url, options) => {
        endpointCalls++;
        const result = await invoke(getYouTubeVideo, JSON.parse(options.body));
        return response(result.body, result.status);
    };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    for (let i = 0; i < 4; i++) await ui.players[i].events.onError({ data: 100 });
    assert.equal(ui.players.length, 4);
    assert.equal(endpointCalls, 4);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(([url]) => new URL(url).searchParams.get("q")), expectedQueries);
    assert.match(textOf(ui.slot), /no longer available/);
    assert.match(textOf(ui.slot), /Listen on YouTube/);
});

test("search budget: five first-search candidates preserve the playback cap without unused extra lookups", async () => {
    const ui = playerFrontend();
    fetchImpl = async () => response({ items: Array.from({ length: 5 }, (_, i) => video(`first${i}`, "Lose Control", "Teddy Swims - Topic")) });
    let endpointCalls = 0;
    ui.context.fetch = async (url, options) => {
        endpointCalls++;
        const result = await invoke(getYouTubeVideo, JSON.parse(options.body));
        return response(result.body, result.status);
    };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    for (let i = 0; i < 5; i++) await ui.players[i].events.onError({ data: 150 });
    assert.equal(ui.players.length, 5);
    assert.equal(endpointCalls, 1);
    assert.equal(requests.length, 1);
    assert.match(textOf(ui.slot), /embedded player/);
});

test("search budget: ten uncached strong matches use ten searches and their repeat playlist uses zero", async () => {
    fetchImpl = async url => {
        const query = new URL(url).searchParams.get("q");
        const match = /^Artist (\d+) Track \1$/.exec(query);
        assert.ok(match, "a successful first search must not request an extra suffix");
        return response({ items: [video(`track${match[1]}`, `Track ${match[1]}`, `Artist ${match[1]} - Topic`)] });
    };
    const perSong = [];
    for (let i = 0; i < 10; i++) {
        const before = requests.length;
        const result = await invoke(getYouTubeVideo, { song: `Track ${i}`, artist: `Artist ${i}`, includeAlternatives: true });
        assert.equal(result.status, 200);
        perSong.push(requests.length - before);
    }
    assert.deepEqual(perSong, Array(10).fill(1));
    assert.equal(requests.length, 10);
    assert.equal(detailRequests.length, 10);
    for (let i = 0; i < 10; i++) {
        const result = await invoke(getYouTubeVideo, { song: `Track ${i}`, artist: `Artist ${i}`, includeAlternatives: true });
        assert.equal(result.body.cacheSource, "server_cache");
    }
    assert.equal(requests.length, 10);
});

test("search progress rejects invalid cursors before any upstream request", async () => {
    for (const startSearchStage of [-1, 4, 1.5, "1"]) {
        const result = await invoke(getYouTubeVideo, { ...anchor, startSearchStage });
        assert.equal(result.status, 400);
        assert.equal(result.body.reason, "invalid_search_stage");
    }
    assert.equal(requests.length, 0);
});

test("a partial-stage miss cannot poison the full identity miss cache", async () => {
    fetchImpl = async () => response({ items: [] });
    const result = await invoke(getYouTubeVideo, { ...anchor, startSearchStage: 3, includeAlternatives: true });
    assert.equal(result.status, 404);
    assert.equal(requests.length, 1);
    assert.equal(Object.keys(global.videoMissCache).length, 0);
    fetchImpl = async () => response({ items: [exactVideo] });
    const complete = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(complete.status, 200);
    assert.equal(requests.length, 2);
});

test("cached search progress cannot make a caller repeat a previously completed stage", async () => {
    fetchImpl = async () => response({ items: [exactVideo] });
    await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    const cached = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true, startSearchStage: 3 });
    assert.equal(cached.body.cacheSource, "server_cache");
    assert.equal(cached.body.nextSearchStage, 3);
    assert.equal(requests.length, 1);
});
