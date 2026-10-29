import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, mock, test } from "node:test";
import getPlaylist from "../api/getPlaylist.js";
import getYouTubeVideo from "../api/getYouTubeVideo.js";
import analytics, { recordAnalyticsEvent } from "../api/analytics.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const success = readFileSync(new URL("../success.html", import.meta.url), "utf8");
const testEnv = { OPENAI_API_KEY: "test-only", YOUTUBE_API_KEY: "test-only", ANALYTICS_ADMIN_TOKEN: "test-only" };
const originalEnv = Object.fromEntries(Object.keys(testEnv).map(key => [key, process.env[key]]));
const secret = "PRIVATE-LISTENING-CONTEXT-DO-NOT-LOG";
const song = { song: "Lose Control", artist: "Teddy Swims" };
const id = "abcdefghijk";
let fetchImpl, calls, logs;

beforeEach(() => {
    for (const key of ["playlistRateLimit", "youtubeRateLimit", "videoCache", "videoMissCache", "youtubeCooldownUntil",
        "youtubeQuotaDiagnostics", "youtubeRateBackoff", "youtubeLookups", "tune4meAnalytics"]) delete global[key];
    for (const [key, value] of Object.entries(testEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    calls = []; logs = [];
    fetchImpl = () => { throw new Error("Live network is disabled in security tests"); };
    mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return fetchImpl(...args); });
    for (const level of ["log", "warn", "error"]) mock.method(console, level, (...args) => logs.push(args));
});
afterEach(() => {
    mock.restoreAll();
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
function response(body, status = 200) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
async function invoke(handler, body, method = "POST", extraHeaders = {}) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, body, headers: { "x-forwarded-for": "security-test", ...extraHeaders } }, res);
    return res;
}
function validAI(extra = {}) {
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ intro: secret, requestedSongs: [], inclusionRequested: false,
        unavailableRequestedSongs: [], songs: [song], explanation: secret }) } }], ...extra };
}
function source(start, end) {
    const begin = html.indexOf(start), finish = html.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin);
    return html.slice(begin, finish);
}
function browser(origin = "https://tune4-me.vercel.app", initial = {}) {
    const values = new Map(Object.entries(initial));
    const events = [];
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; } };
    const context = vm.createContext({ window: { location: { origin, search: "?session_id=cs_forged&paid=true" } },
        localStorage: storage, sessionStorage: storage, console: { log: (...args) => events.push(args), warn: (...args) => events.push(args), error: (...args) => events.push(args) },
        fetch: (...args) => fetchImpl(...args), YOUTUBE_CACHE_TTL_MS: 7 * 86400000,
        showStatusMessage: message => events.push([message]), trackTune4Me: event => events.push([event]) });
    vm.runInContext(source("function getVideoCacheKey(", "function closeYouTubePreview("), context);
    return { context, storage, values, events };
}
function cacheKey(songName = song.song) { return "yt_v4_" + JSON.stringify([[songName.toLowerCase(), song.artist.toLowerCase()], null]); }
function candidate() { return { videoId: id, video: { title: secret, channelTitle: secret } }; }
function seedCache(count = 200) {
    global.videoCache = Object.fromEntries(Array.from({ length: count }, (_, i) => [cacheKey("song" + i),
        { candidates: [candidate()], nextSearchStage: 1, cachedAt: Date.now() - i }]));
}
function assertNoSecret(value) { assert.ok(!JSON.stringify(value).includes(secret)); }

const canonicalKeyFixture = "fixture-canonical-key-never-log";
const updatedKeyFixture = "fixture-updated-key-never-log";
const untrustedKeyFixture = "fixture-untrusted-client-key-never-log";
function assertNoKeyMaterial(value) {
    const serialized = JSON.stringify(value);
    for (const key of [canonicalKeyFixture, updatedKeyFixture, untrustedKeyFixture]) {
        assert.ok(!serialized.includes(key));
    }
}

test("playlist uses the canonical server key for its single OpenAI request", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => response(validAI());
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, 200); assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assert.equal(JSON.parse(calls[0][1].body).messages[1].content.includes(secret), true);
    assertNoKeyMaterial(result.body); assertNoKeyMaterial(logs); assertNoSecret(logs);
});

test("explicit anchor recovery keeps parsed identities and emotional context out of logs and makes one canonical call", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => response(validAI());
    const result = await invoke(getPlaylist, {
        mood: `Play "${secret}" by Fixture Artist because I feel ${secret}`,
        length: 1,
        avoidSongs: [{ song: secret, artist: "Fixture Artist" }]
    });
    assert.equal(result.code, 200);
    assert.deepEqual(result.body.playlist.songs, [{ song: secret, artist: "Fixture Artist" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assertNoSecret(logs); assertNoKeyMaterial(logs); assertNoKeyMaterial(result.body);
});

test("a rejected explicit-song request cannot recover through another key or another provider", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => response({ error: { type: "authentication_error", message: secret + canonicalKeyFixture } }, 401);
    const result = await invoke(getPlaylist, { mood: `Play "${secret}" by Fixture Artist`, length: 1 });
    assert.equal(result.code, 502);
    assert.equal(result.body.reason, "authentication_error");
    assert.equal(result.body.playlist, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
    assertNoSecret(result.body); assertNoSecret(logs); assertNoKeyMaterial(result.body); assertNoKeyMaterial(logs);
});

test("unsatisfied inclusion notices contain no identities, emotional text, or credential material in logs", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    const requested = { song: secret, artist: "Fixture Artist" };
    fetchImpl = async () => {
        const data = validAI();
        const playlist = JSON.parse(data.choices[0].message.content);
        playlist.inclusionRequested = true;
        playlist.unavailableRequestedSongs = [requested];
        data.choices[0].message.content = JSON.stringify(playlist);
        return response(data);
    };
    const result = await invoke(getPlaylist, { mood: `Please include "${secret}" by Fixture Artist`, length: 1 });
    assert.equal(result.code, 200);
    assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
    assertNoSecret(result.body.playlist.requestNotice); assertNoSecret(logs);
    assertNoKeyMaterial(result.body); assertNoKeyMaterial(logs);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
});

test("a current private title exclusion blocks recovery without exposing the title or credentials in logs", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    const requested = { song: secret, artist: "Fixture Artist" };
    fetchImpl = async () => {
        const data = validAI();
        const playlist = JSON.parse(data.choices[0].message.content);
        playlist.requestedSongs = [requested];
        data.choices[0].message.content = JSON.stringify(playlist);
        return response(data);
    };
    const result = await invoke(getPlaylist, { mood: `Please include "${secret}" by Fixture Artist. Actually, don't play "${secret}".`, length: 1 });
    assert.equal(result.code, 200);
    assert.deepEqual(result.body.playlist.songs, [song]);
    assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assertNoSecret(logs); assertNoSecret(result.body.playlist.requestNotice);
    assertNoKeyMaterial(logs); assertNoKeyMaterial(result.body);
});

test("resolving a private command-like title preserves canonical authorization and logs no identities", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    const full = { song: "Play " + secret + " Again", artist: "Fixture Artist" };
    fetchImpl = async () => {
        const data = validAI();
        const playlist = JSON.parse(data.choices[0].message.content);
        playlist.requestedSongs = [full];
        data.choices[0].message.content = JSON.stringify(playlist);
        return response(data);
    };
    const result = await invoke(getPlaylist, { mood: `${full.song} by Fixture Artist and recommend other songs with similar longing.`, length: 1 });
    assert.equal(result.code, 200);
    assert.deepEqual(result.body.playlist.songs, [full]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assertNoSecret(logs); assertNoKeyMaterial(logs); assertNoKeyMaterial(result.body);
});

for (const value of [undefined, ""]) test("playlist rejects a " + (value === undefined ? "missing" : "blank") + " canonical key before contacting OpenAI", async () => {
    if (value === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = value;
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, 500); assert.equal(calls.length, 0);
    assert.deepEqual(result.body, { error: "Playlist service is not configured" });
    assert.deepEqual(logs, [["GET PLAYLIST CONFIG ERROR:", { missing: "OPENAI_API_KEY" }]]);
    assertNoKeyMaterial(result.body); assertNoKeyMaterial(logs); assertNoSecret(logs);
});

for (const status of [401, 403, 429, 500]) test("canonical OpenAI HTTP " + status + " is sanitized without retry", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => response({ error: { type: status === 401 ? "authentication_error" : "server_error",
        code: "invalid_api_key", message: canonicalKeyFixture + secret } }, status);
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, status === 429 ? 429 : status < 500 ? 502 : 503);
    assert.equal(calls.length, 1); assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assertNoKeyMaterial(result.body); assertNoSecret(result.body); assertNoKeyMaterial(logs); assertNoSecret(logs);
});

test("canonical OpenAI network failures never retry or leak credentials and exception text", async () => {
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => { throw new Error(canonicalKeyFixture + secret); };
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, 500); assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assertNoKeyMaterial(result.body); assertNoSecret(result.body); assertNoKeyMaterial(logs); assertNoSecret(logs);
});

test("warm playlist requests validate and use the current canonical key without retaining a previous value", async () => {
    fetchImpl = async () => response(validAI());
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 200);
    delete process.env.OPENAI_API_KEY;
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 500);
    assert.equal(calls.length, 1);
    process.env.OPENAI_API_KEY = updatedKeyFixture;
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 200);
    assert.deepEqual(calls.map(call => call[1].headers.Authorization),
        [canonicalKeyFixture, updatedKeyFixture].map(key => "Bearer " + key));
    assertNoKeyMaterial(logs); assertNoSecret(logs);
});

test("client body and authorization headers cannot replace a missing or configured canonical server key", async () => {
    const body = { mood: secret, length: 1, OPENAI_API_KEY: untrustedKeyFixture };
    const headers = { authorization: "Bearer " + untrustedKeyFixture };
    delete process.env.OPENAI_API_KEY;
    const missing = await invoke(getPlaylist, body, "POST", headers);
    assert.equal(missing.code, 500); assert.equal(calls.length, 0);
    process.env.OPENAI_API_KEY = canonicalKeyFixture;
    fetchImpl = async () => response(validAI());
    const result = await invoke(getPlaylist, body, "POST", headers);
    assert.equal(result.code, 200); assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.Authorization, "Bearer " + canonicalKeyFixture);
    assert.ok(!calls[0][1].body.includes(untrustedKeyFixture));
    assertNoKeyMaterial(missing.body); assertNoKeyMaterial(result.body); assertNoKeyMaterial(logs); assertNoSecret(logs);
});

function seedPlaylistTracker(now, count = 1000) {
    global.playlistRateLimit = Object.fromEntries(Array.from({ length: count }, (_, i) =>
        [`client-${i}`, { count: 11, resetAt: now + 60000 }]));
}

test("playlist tracker removes other expired and malformed entries without resetting active clients", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    global.playlistRateLimit = {
        expired: { count: 12, resetAt: now - 1 }, active: { count: 9, resetAt: now + 30000 },
        corrupt: null, missingExpiry: { count: 1 }, invalidCount: { count: NaN, resetAt: now + 60000 }
    };
    fetchImpl = async () => response(validAI());
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, 200); assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(global.playlistRateLimit).sort(), ["active", "security-test"]);
    assert.deepEqual(global.playlistRateLimit.active, { count: 9, resetAt: now + 30000 });
    assert.deepEqual(global.playlistRateLimit["security-test"], { count: 1, resetAt: now + 60000 });
});

test("playlist rate limiting still permits twelve requests and blocks subsequent requests before the provider", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    fetchImpl = async () => response(validAI());
    for (let i = 0; i < 12; i++) assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 200);
    for (let i = 0; i < 2; i++) {
        const limited = await invoke(getPlaylist, { mood: secret, length: 1 });
        assert.equal(limited.code, 429);
        assert.deepEqual(limited.body, { error: "Too many playlist requests", reason: "rate_limited" });
    }
    assert.equal(calls.length, 12);
    assert.equal(global.playlistRateLimit["security-test"].count, 14);
    assert.equal(global.playlistRateLimit["security-test"].resetAt, now + 60000);
});

test("playlist expiry preserves the exact existing window boundary and then restores legitimate access", async () => {
    let now = 1800000000000; mock.method(Date, "now", () => now);
    global.playlistRateLimit = { "security-test": { count: 12, resetAt: now } };
    fetchImpl = async () => response(validAI());
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 429);
    assert.equal(calls.length, 0);
    now++;
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(global.playlistRateLimit["security-test"], { count: 1, resetAt: now + 60000 });
});

test("many distinct playlist clients cannot grow the tracker beyond one thousand entries", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    for (let i = 0; i < 1250; i++) {
        const result = await invoke(getPlaylist, {}, "POST", { "x-forwarded-for": `2001:db8::${(i + 1).toString(16)}` });
        // Invalid prompts consume the same local allowance as before, without invoking a provider.
        assert.equal(result.code, i < 1000 ? 400 : 429);
        assert.ok(Object.keys(global.playlistRateLimit).length <= 1000);
    }
    assert.equal(Object.keys(global.playlistRateLimit).length, 1000);
    assert.equal(calls.length, 0);
});

test("a full playlist tracker preserves active counters and permits an existing client's remaining allowance", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    seedPlaylistTracker(now);
    const keys = Object.keys(global.playlistRateLimit);
    fetchImpl = async () => response(validAI());
    const newcomer = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(newcomer.code, 429); assert.equal(calls.length, 0);
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 }, "POST", { "x-forwarded-for": "client-1" })).code, 200);
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 }, "POST", { "x-forwarded-for": "client-1" })).code, 429);
    assert.equal(calls.length, 1); assert.deepEqual(Object.keys(global.playlistRateLimit), keys);
    assert.deepEqual(global.playlistRateLimit["client-0"], { count: 11, resetAt: now + 60000 });
    assert.equal(global.playlistRateLimit["client-1"].count, 13);
});

test("one expired playlist slot admits a new client without evicting any live record", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    seedPlaylistTracker(now); global.playlistRateLimit["client-0"].resetAt = now - 1;
    fetchImpl = async () => response(validAI());
    assert.equal((await invoke(getPlaylist, { mood: secret, length: 1 })).code, 200);
    assert.equal(calls.length, 1); assert.equal(Object.keys(global.playlistRateLimit).length, 1000);
    assert.equal(Object.hasOwn(global.playlistRateLimit, "client-0"), false);
    assert.deepEqual(global.playlistRateLimit["security-test"], { count: 1, resetAt: now + 60000 });
    for (let i = 1; i < 1000; i++) assert.deepEqual(global.playlistRateLimit[`client-${i}`], { count: 11, resetAt: now + 60000 });
});

test("unexpected playlist client keys cannot inherit counters, mutate prototypes, or bypass capacity", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    global.playlistRateLimit = {};
    for (const key of ["__proto__", "constructor", "toString"]) {
        for (let i = 0; i < 13; i++) {
            const result = await invoke(getPlaylist, {}, "POST", { "x-forwarded-for": key });
            assert.equal(result.code, i < 12 ? 400 : 429);
        }
        assert.equal(Object.hasOwn(global.playlistRateLimit, key), true);
        assert.equal(global.playlistRateLimit[key].count, 13);
    }
    assert.equal(Object.getPrototypeOf(global.playlistRateLimit), Object.prototype);
    assert.equal(Object.prototype.count, undefined);
    seedPlaylistTracker(now);
    assert.equal((await invoke(getPlaylist, {}, "POST", { "x-forwarded-for": "constructor" })).code, 429);
    assert.equal(Object.keys(global.playlistRateLimit).length, 1000); assert.equal(calls.length, 0);
});

test("playlist success, per-client limiting, and capacity limiting never expose client IPs in responses or logs", async () => {
    const now = 1800000000000; mock.method(Date, "now", () => now);
    const client = "2001:db8::decaf", newcomer = "2001:db8::beef";
    fetchImpl = async () => response(validAI());
    const success = await invoke(getPlaylist, { mood: secret, length: 1 }, "POST", { "x-forwarded-for": client });
    assert.equal(success.code, 200);
    global.playlistRateLimit[client].count = 12;
    const limited = await invoke(getPlaylist, { mood: secret, length: 1 }, "POST", { "x-forwarded-for": client });
    assert.equal(limited.code, 429);
    seedPlaylistTracker(now);
    const full = await invoke(getPlaylist, { mood: secret, length: 1 }, "POST", { "x-forwarded-for": newcomer });
    assert.equal(full.code, 429); assert.equal(calls.length, 1);
    for (const value of [success.body, limited.body, full.body, logs]) {
        assert.ok(!JSON.stringify(value).includes(client)); assert.ok(!JSON.stringify(value).includes(newcomer));
    }
    assertNoSecret(logs);
});

test("OpenAI has a 3072 output-token ceiling and a 15-second abort signal without changing music context", async () => {
    const controller = new AbortController(); let duration;
    mock.method(AbortSignal, "timeout", value => { duration = value; return controller.signal; });
    fetchImpl = async () => response(validAI());
    const result = await invoke(getPlaylist, { mood: secret, length: 1, likedSongs: [song] });
    assert.equal(result.code, 200);
    const request = calls[0][1], payload = JSON.parse(request.body);
    assert.equal(duration, 15000); assert.equal(request.signal, controller.signal);
    assert.equal(payload.max_completion_tokens, 3072); assert.equal(payload.model, "gpt-4o-mini");
    assert.equal(JSON.parse(payload.messages[1].content).mood, secret);
    assert.deepEqual(result.body.playlist.songs, [song]); assertNoSecret(logs);
});
test("unexpected OpenAI response metadata is not relayed to the browser", async () => {
    const data = validAI({ provider_internal: secret }); data.choices[0].message.provider_internal = secret;
    fetchImpl = async () => response(data);
    const result = await invoke(getPlaylist, { mood: "music", length: 1 });
    assert.equal(result.code, 200); assert.equal(result.body.provider_internal, undefined);
    assert.equal(result.body.choices[0].message.provider_internal, undefined);
});
for (const finish of ["length", "content_filter", null]) test(`incomplete OpenAI result (${finish}) cannot become a playlist`, async () => {
    const data = validAI(); data.choices[0].finish_reason = finish;
    fetchImpl = async () => response(data);
    const result = await invoke(getPlaylist, { mood: secret, length: 1 });
    assert.equal(result.code, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined); assertNoSecret(logs);
});
test("OpenAI timeout returns a safe retryable failure without returning the prompt", async () => {
    fetchImpl = async () => { throw new DOMException(secret, "TimeoutError"); };
    const result = await invoke(getPlaylist, { mood: secret });
    assert.equal(result.code, 504); assert.equal(result.body.reason, "request_timeout");
    assertNoSecret(result.body); assertNoSecret(logs);
});
test("arbitrary OpenAI provider error type, code, and message are excluded from responses and logs", async () => {
    fetchImpl = async () => response({ error: { type: secret, code: secret, message: secret } }, 400);
    const result = await invoke(getPlaylist, { mood: secret });
    assert.equal(result.code, 502); assert.equal(result.body.reason, "upstream_error");
    assertNoSecret(result.body); assertNoSecret(logs);
});
test("network exception names cannot leak into server logs", async () => {
    fetchImpl = async () => { const error = new Error(secret); error.name = secret; throw error; };
    const result = await invoke(getPlaylist, { mood: secret });
    assert.equal(result.code, 500); assertNoSecret(result.body); assertNoSecret(logs);
});

for (const limit of [15, 40, 65, 90, 100]) test(`repeated success-page visits cannot increase legacy allowance ${limit}`, () => {
    const ui = browser(undefined, { saveLimit: String(limit), savedSongs: JSON.stringify([song]), tune4mePlus: "active" });
    const script = [...success.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)][0][1];
    const before = [...ui.values];
    for (let visit = 0; visit < 3; visit++) vm.runInContext(script, ui.context);
    assert.deepEqual([...ui.values], before); assert.equal(ui.events.length, 0);
    ui.context.goBack(); assert.equal(ui.context.window.location.href, "/");
});
test("direct handleUpgrade invocation cannot grant saves or emit a sale, even with forged paid flags", () => {
    const ui = browser(undefined, { saveLimit: "65", savedSongs: JSON.stringify([song]), tune4mePlus: "active" });
    const before = [...ui.values];
    vm.runInContext(source("window.handleUpgrade =", "let deferredPrompt;"), ui.context);
    for (let attempt = 0; attempt < 4; attempt++) ui.context.window.handleUpgrade({ paid: true, session_id: "cs_forged" });
    assert.deepEqual([...ui.values], before);
    assert.ok(ui.events.every(event => !event.includes("upgrade_completed")));
    assert.match(ui.events[0][0], /temporarily unavailable/);
});
test("the public upgrade button cannot start an unfulfillable Stripe checkout", () => {
    assert.doesNotMatch(html, /onclick=["'][^\n]*buy\.stripe\.com/);
    assert.match(html, /onclick="handleUpgrade\(\)"/);
    assert.doesNotMatch(success, /localStorage\.setItem|sessionStorage\.setItem|upgrade_completed/);
});
for (const event of ["upgrade_completed", "confirmed_sale", "payment_verified"]) test(`browser analytics rejects forged sales event ${event}`, async () => {
    const result = await invoke(analytics, { event, paid: true });
    assert.equal(result.code, 400); assert.equal(result.body.ok, false);
    assert.equal(recordAnalyticsEvent(event), false);
});
test("warm legacy analytics cannot count old client upgrade reports as verified sales", async () => {
    global.tune4meAnalytics = { startedAt: "test", counts: { upgrade_completed: 500, upgrade_dialog_viewed: 2 } };
    assert.equal((await invoke(analytics, {}, "GET")).code, 401);
    const result = await invoke(analytics, {}, "GET", { authorization: "Bearer test-only" });
    assert.equal(result.code, 200); assert.equal(result.body.counts.upgrade_completed, undefined);
    assert.equal(result.body.metrics.confirmedSales, null); assert.equal(result.body.metrics.upgradeConversion, null);
    assert.equal((await invoke(analytics, { event: "song_saved", song: secret })).code, 202);
    assertNoSecret((await invoke(analytics, {}, "GET", { authorization: "Bearer test-only" })).body);
});

for (const origin of ["https://tune4-me.vercel.app", "https://preview.vercel.app", "http://localhost.attacker.example", "https://127.0.0.1.attacker.example", "null"]) {
    test(`hosted preview logs omit listening data: ${origin}`, () => {
        const ui = browser(origin);
        for (const level of ["log", "warn"]) ui.context.logPreviewDiagnostic(level, "youtube_preview_attempt", { song: secret, artist: secret, videoId: id, video: secret, diagnostics: secret });
        assert.deepEqual(ui.events, [["youtube_preview_attempt"], ["youtube_preview_attempt"]]);
    });
}
test("local loopback diagnostics retain existing troubleshooting behavior", () => {
    const ui = browser("http://127.0.0.1:3000");
    ui.context.logPreviewDiagnostic("log", "youtube_preview_attempt", { videoId: id });
    assert.equal(ui.events[0][1].videoId, id);
});
test("server positive caches are bounded even when many fresh identities already exist", async () => {
    seedCache(205);
    const result = await invoke(getYouTubeVideo, { ...song, song: "song0" });
    assert.equal(result.code, 200); assert.equal(Object.keys(global.videoCache).length, 200); assert.equal(calls.length, 0);
});
test("new verified YouTube results also preserve the positive cache bound", async () => {
    seedCache();
    fetchImpl = async url => response(String(url).includes("/videos?") ? { items: [{ id, snippet: { title: "Teddy Swims - Lose Control", channelTitle: "Teddy Swims" }, status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed" }, contentDetails: {} }] }
        : { items: [{ id: { videoId: id }, snippet: { title: "Teddy Swims - Lose Control", channelTitle: "Teddy Swims" } }] });
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 200); assert.equal(result.body.videoId, id);
    assert.equal(Object.keys(global.videoCache).length, 200);
});
test("negative caches remain bounded when another identity has no result", async () => {
    global.videoMissCache = Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["old" + i, { cachedAt: Date.now() - i }]));
    fetchImpl = async () => response({ items: [] });
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 404); assert.equal(Object.keys(global.videoMissCache).length, 200);
    assert.equal(calls.length, 4);
});
test("expired and corrupt caches are swept without waiting for the same song to be requested", async () => {
    global.videoCache = { abandoned: { cachedAt: Date.now() - 8 * 86400000 }, corrupt: null };
    global.videoMissCache = { abandoned: { cachedAt: Date.now() - 360000 } };
    fetchImpl = async () => response({ items: [] });
    await invoke(getYouTubeVideo, song);
    assert.deepEqual(global.videoCache, {}); assert.equal(global.videoMissCache.abandoned, undefined);
});
test("a full active IP guard rejects new identities without growing or evicting active guards", async () => {
    global.youtubeRateLimit = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["ip" + i, { count: 1, resetAt: Date.now() + 60000 }]));
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 429); assert.equal(Object.keys(global.youtubeRateLimit).length, 1000); assert.equal(calls.length, 0);
});
test("expired IP guards are pruned so legitimate traffic can resume", async () => {
    global.youtubeRateLimit = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["ip" + i, { count: 1, resetAt: Date.now() - 100 }]));
    fetchImpl = async () => response({ items: [] });
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 404); assert.equal(Object.keys(global.youtubeRateLimit).length, 1);
});
test("full server in-flight registry returns a safe retry before another paid provider lookup", async () => {
    global.youtubeLookups = new Map(Array.from({ length: 32 }, (_, i) => [i, Promise.resolve(null)]));
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 429); assert.equal(result.body.retryAfterSeconds, 5); assert.equal(calls.length, 0);
});
test("arbitrary YouTube network exception properties cannot impersonate trusted provider diagnostics", async () => {
    fetchImpl = async () => { throw Object.assign(new Error(secret), { previewStatus: 200, previewReason: secret, diagnostics: { message: secret }, retryAfterSeconds: secret }); };
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 502); assert.equal(result.body.reason, "upstream_error"); assertNoSecret(result.body); assertNoSecret(logs);
});
test("provider error strings cannot leak through known YouTube error classification", async () => {
    fetchImpl = async () => response({ error: { message: secret, errors: [{ reason: secret }] } }, 403);
    const result = await invoke(getYouTubeVideo, song);
    assert.equal(result.code, 502); assert.equal(result.body.reason, "access_denied");
    assertNoSecret(result.body); assertNoSecret(logs);
});
test("persistent preview cache evicts oldest entries and preserves songs, feedback and legacy capacity", () => {
    const initial = { savedSongs: JSON.stringify([song]), songFeedback: secret, saveLimit: "100" };
    for (let i = 0; i < 205; i++) initial["yt_v4_old" + i] = JSON.stringify({ videoId: id, cachedAt: Date.now() - 1000 - i });
    initial.yt_v3_expired = JSON.stringify({ videoId: id, cachedAt: 1 });
    initial.yt_v4_corrupt = "invalid";
    const ui = browser(undefined, initial);
    ui.context.saveCachedVideo(song.song, song.artist, id);
    assert.equal([...ui.values.keys()].filter(key => /^yt_v/.test(key)).length, 200);
    assert.equal(ui.storage.getItem("savedSongs"), initial.savedSongs); assert.equal(ui.storage.getItem("songFeedback"), secret);
    assert.equal(ui.storage.getItem("saveLimit"), "100"); assert.equal(ui.context.getCachedVideo(song.song, song.artist), id);
    assert.equal(ui.storage.getItem("yt_v4_old204"), null);
});
test("browser storage exhaustion does not throw from preview cache writes", () => {
    const ui = browser(); ui.storage.setItem = () => { throw new Error(secret); };
    assert.doesNotThrow(() => ui.context.saveCachedVideo(song.song, song.artist, id)); assert.equal(ui.events.length, 0);
});
test("browser candidate pools remain bounded during many distinct legitimate lookups", async () => {
    const ui = browser(); fetchImpl = async () => response({ ...candidate(), candidates: [candidate()], nextSearchStage: 1 });
    for (let i = 0; i < 105; i++) assert.equal((await ui.context.lookupYouTubePreview("Song" + i, "Artist", [])).ok, true);
    assert.equal(ui.context.window.tune4mePreviewLookups.pools.size, 100);
});
test("browser expired candidate pools are pruned and a full pending registry does not grow", async () => {
    const ui = browser();
    ui.context.window.tune4mePreviewLookups = { pools: new Map([["expired", { cachedAt: 1 }]]), pending: new Map(Array.from({ length: 16 }, (_, i) => [i, Promise.resolve(null)])), limited: null, attempt: 0 };
    const result = await ui.context.lookupYouTubePreview(song.song, song.artist, []);
    assert.equal(result.status, 429); assert.equal(ui.context.window.tune4mePreviewLookups.pools.size, 0);
    assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 16);
});
