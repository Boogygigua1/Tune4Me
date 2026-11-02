import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const success = readFileSync(new URL("../success.html", import.meta.url), "utf8");
const song = { song: "Synthetic Song", artist: "Synthetic Artist" };
const textarea = html.match(/<textarea\b[^>]*id="moodInput"[^>]*>/)?.[0];
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
function source(start, end) {
    const from = html.indexOf(start), to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Missing source boundary: ${start}`);
    return html.slice(from, to);
}
class Element {
    constructor() { this.style = {}; this.attributes = {}; this.children = []; this.events = {}; this.dataset = {}; this.value = ""; this.textContent = ""; this.innerText = ""; this.disabled = false; }
    appendChild(child) { this.children.push(child); child.isConnected = true; return child; }
    prepend(child) { this.children.unshift(child); child.isConnected = true; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(key, fn) { this.events[key] = fn; }
    focus() { this.focused = true; }
    scrollIntoView() {}
    remove() { this.isConnected = false; }
    set innerHTML(value) { this.markup = value; this.children = []; }
    get innerHTML() { return this.markup || ""; }
}
function browser(initial = {}) {
    const values = new Map(Object.entries(initial));
    const elements = Object.fromEntries(["moodInput", "moodError", "appStatus", "result", "continueBtn", "lastMood", "floatingSaveBtn", "saveCounter", "savedSongs"].map(id => [id, new Element()]));
    const calls = [], events = [], opened = [];
    const context = vm.createContext({
        document: { getElementById: id => elements[id] || null, querySelector: () => null,
            createElement: () => new Element(), createTextNode: text => Object.assign(new Element(), { textContent: text }) },
        window: { location: { origin: "http://127.0.0.1:3000", search: "?paid=true&session_id=cs_synthetic" },
            matchMedia: () => ({ matches: true }), open: (...args) => opened.push(args) },
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
        console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {},
        currentPlaylist: JSON.parse(values.get("currentPlaylist") || "[]"), continueCount: 0, isPlayingAll: false, MAX_SAVE_LIMIT: 100,
        stopPlayback() {}, showUpgradeBox() {}, trackTune4Me: event => events.push(event),
        fetch: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            const data = { playlist: { songs: [song] }, choices: [{ message: { content: `1. Room for mixed feelings.\n\n2. 🎧 Songs:\n- ${song.song} - ${song.artist}\n\n3. 🧠 Why this fits:\nNo forced emotional progression.` } }] };
            return { status: 200, text: async () => JSON.stringify(data), json: async () => data };
        }
    });
    // Existing behavior tests exercise an already-agreed visit. Privacy gating is
    // exercised from a real unaccepted bootstrap in privacy-controls.test.mjs.
    vm.runInContext(source("const PRIVACY_POLICY_VERSION", "function trackTune4Me("), context);
    vm.runInContext("privacyAccepted = true;", context);
    for (const [start, end] of [
        ["const RECENT_RECOMMENDATION_KEY", "// AI"],
        ["function preferredScrollBehavior()", "function saveFeedback("],
        ["function loadSavedSongs()", "function deleteSavedSong("],
        ["function clearNewList()", "// LOAD"],
        ["function saveSong(song, artist)", "function saveSongWithVideo("],
        ["async function showMood(button)", "async function continuePlaylist()"],
        ["window.handleUpgrade =", "let deferredPrompt;"]
    ]) vm.runInContext(source(start, end), context);
    return { context, values, elements, calls, events, opened };
}

const recentKey = "tune4meRecentRecommendations";
const recentNow = 1800000000000;
const recentTTL = 30 * 86400000;
function clock(ui, now = recentNow) { vm.runInContext(`Date.now = () => ${now}`, ui.context); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function recentEntries(ui) { return JSON.parse(ui.values.get(recentKey) || "[]"); }

for (const continuation of [false, true]) test(`musical-fit limitation is clear, safe, and never retries (continuation: ${continuation})`, async () => {
    const ui = browser({ currentPlaylist: JSON.stringify([song]), saveLimit: "100", likedSongs: JSON.stringify([song]) });
    clock(ui); ui.context.rememberRecentRecommendations([song]);
    const before = Object.fromEntries(ui.values);
    ui.elements.moodInput.value = 'Play "Lose Control" by Teddy Swims. Find similar vocals and groove.';
    ui.context.fetch = async url => {
        ui.calls.push({ url });
        const data = { reason: "insufficient_musical_fit", error: "<img src=x onerror=PRIVATE_UNSUPPORTED>" };
        return { status: 502, text: async () => JSON.stringify(data), json: async () => data };
    };
    if (continuation) {
        vm.runInContext(source("async function continuePlaylist()", "// $$$$"), ui.context);
        await ui.context.continuePlaylist();
        assert.match(ui.elements.result.children[0].textContent, /couldn't assemble enough distinct songs/);
        assert.doesNotMatch(ui.elements.result.children[0].textContent, /PRIVATE|<img/);
    } else {
        await ui.context.showMood(new Element());
        assert.match(ui.elements.result.textContent, /couldn't assemble enough distinct songs/);
        assert.doesNotMatch(ui.elements.result.textContent, /PRIVATE|<img/);
    }
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.deepEqual(plain(ui.context.currentPlaylist), [song]);
    for (const key of [recentKey, "currentPlaylist", "saveLimit", "likedSongs"]) assert.equal(ui.values.get(key), before[key]);
});

test("recent recommendations survive a page reload and contain only identities and expiration metadata", () => {
    const ui = browser(); clock(ui);
    ui.context.rememberRecentRecommendations([{ ...song, mood: "PRIVATE-MOOD", rating: "bad", videoId: "abcdefghijk" }]);
    assert.deepEqual(recentEntries(ui), [{ ...song, recommendedAt: recentNow }]);
    const reloaded = browser(Object.fromEntries(ui.values)); clock(reloaded, recentNow + 1);
    assert.deepEqual(plain(reloaded.context.getRecentRecommendations()), [song]);
    assert.deepEqual(Object.keys(recentEntries(reloaded)[0]).sort(), ["artist", "recommendedAt", "song"]);
    assert.ok(!ui.values.get(recentKey).includes("PRIVATE-MOOD"));
    assert.equal(ui.calls.length, 0); assert.equal(reloaded.calls.length, 0);
});

test("history keeps the 30 most recent distinct recordings across batches", () => {
    const ui = browser();
    for (let index = 0; index < 45; index++) {
        clock(ui, recentNow + index);
        ui.context.rememberRecentRecommendations([{ song: `Recent ${index}`, artist: "Fixture Artist" }]);
        assert.ok(recentEntries(ui).length <= 30);
    }
    assert.deepEqual(recentEntries(ui).map(item => item.song), Array.from({ length: 30 }, (_, index) => `Recent ${44 - index}`));
});

test("normalization deduplicates identities, refreshes repeated songs, and preserves different artists", () => {
    const ui = browser(); clock(ui);
    ui.context.rememberRecentRecommendations([{ song: "Song", artist: "Artist" }, { song: "Song", artist: "Other Artist" }]);
    clock(ui, recentNow + 100);
    ui.context.rememberRecentRecommendations([{ song: " Ｓｏｎｇ ", artist: " ARTIST " }]);
    assert.deepEqual(recentEntries(ui), [
        { song: "Ｓｏｎｇ", artist: "ARTIST", recommendedAt: recentNow + 100 },
        { song: "Song", artist: "Other Artist", recommendedAt: recentNow }
    ]);
});

test("30-day expiry removes old and boundary entries but retains a still-current recommendation", () => {
    const entries = [
        { ...song, recommendedAt: recentNow - recentTTL + 1 },
        { song: "Exactly 30 Days", artist: "Artist", recommendedAt: recentNow - recentTTL },
        { song: "Older", artist: "Artist", recommendedAt: recentNow - recentTTL - 1 },
        { song: "Future", artist: "Artist", recommendedAt: recentNow + 1 },
        { song: "Invalid", artist: "Artist", recommendedAt: "yesterday" }
    ];
    const ui = browser({ [recentKey]: JSON.stringify(entries) }); clock(ui);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [song]);
    assert.equal(recentEntries(ui).length, 1);
    clock(ui, recentNow + 1);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
    assert.deepEqual(recentEntries(ui), []);
});

test("recommending a song again renews its own expiry without renewing older entries", () => {
    const old = { song: "Old", artist: "Artist", recommendedAt: recentNow - recentTTL + 50 };
    const ui = browser({ [recentKey]: JSON.stringify([{ ...song, recommendedAt: old.recommendedAt }, old]) }); clock(ui);
    ui.context.rememberRecentRecommendations([song]);
    clock(ui, recentNow + 50);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [song]);
    assert.equal(recentEntries(ui)[0].recommendedAt, recentNow);
});

for (const raw of ["not JSON", "null", "{}", '"not an array"', "[".repeat(20001)]) {
    test(`corrupted or oversized recent storage is repaired safely (${raw.length} characters)`, () => {
        const ui = browser({ [recentKey]: raw }); clock(ui);
        assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
        assert.deepEqual(recentEntries(ui), []);
        assert.equal(ui.calls.length, 0);
    });
}

test("invalid stored history entries are discarded and unknown fields never survive normalization", () => {
    const entries = [null, { song: {}, artist: "Artist", recommendedAt: recentNow },
        { song: " ", artist: "Artist", recommendedAt: recentNow },
        { song: "Bad\nTitle", artist: "Artist", recommendedAt: recentNow },
        { song: "x".repeat(121), artist: "Artist", recommendedAt: recentNow },
        { ...song, recommendedAt: recentNow, mood: "PRIVATE", anotherField: "discard" }];
    const ui = browser({ [recentKey]: JSON.stringify(entries) }); clock(ui);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [song]);
    assert.deepEqual(recentEntries(ui), [{ ...song, recommendedAt: recentNow }]);
});

test("clearing history is independent of favorites, feedback, current playlist, and saved capacity", () => {
    const initial = { savedSongs: JSON.stringify([song]), saveLimit: "65", currentPlaylist: JSON.stringify([song]),
        likedSongs: JSON.stringify([song]), avoidSongs: JSON.stringify([song]), songFeedback: '[{"rating":"bad"}]' };
    const ui = browser(initial); clock(ui);
    ui.context.rememberRecentRecommendations([song]);
    ui.context.clearRecentRecommendations();
    assert.equal(ui.values.has(recentKey), false);
    assert.equal(ui.elements.appStatus.textContent, "Recent recommendation history cleared. Your favorites and feedback are unchanged.");
    assert.deepEqual(Object.fromEntries(ui.values), initial);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
    assert.equal(ui.calls.length, 0); assert.deepEqual(ui.events, []);
});

test("the history clear control uses a native accessible blue button and describes data sharing", () => {
    assert.match(html, /<button class="secondary-button" type="button" onclick="clearRecentRecommendations\(\)"\s+aria-describedby="recentRecommendationNote">Clear Recent History<\/button>/);
    assert.match(html, /id="recentRecommendationNote"[^>]*>[\s\S]*?30 recent recommendations for 30 days/);
    assert.match(html, /Song titles and artists are shared with the curator when you create a playlist/);
});

test("denied history storage uses bounded visit memory without throwing or making requests", () => {
    const ui = browser(); clock(ui);
    ui.context.localStorage.getItem = () => { throw new Error("PRIVATE storage failure"); };
    ui.context.localStorage.setItem = () => { throw new Error("PRIVATE storage failure"); };
    for (let index = 0; index < 40; index++) {
        clock(ui, recentNow + index);
        ui.context.rememberRecentRecommendations([{ song: `Song ${index}`, artist: "Artist" }]);
    }
    assert.equal(ui.context.getRecentRecommendations().length, 30);
    assert.equal(ui.context.getRecentRecommendations()[0].song, "Song 39");
    assert.equal(ui.calls.length, 0); assert.deepEqual(ui.events, []);
});

test("a quota failure preserves readable history and new visit-memory recommendations", () => {
    const ui = browser({ [recentKey]: JSON.stringify([{ ...song, recommendedAt: recentNow - 1 }]) }); clock(ui);
    ui.context.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    const fresh = { song: "Fresh", artist: "Artist" };
    ui.context.rememberRecentRecommendations([fresh]);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [fresh, song]);
});

test("readable updates and clears from another tab replace stale in-memory history", () => {
    const ui = browser(); clock(ui); ui.context.rememberRecentRecommendations([song]);
    const external = { song: "Another Tab", artist: "Artist", recommendedAt: recentNow };
    ui.values.set(recentKey, JSON.stringify([external]));
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [{ song: external.song, artist: external.artist }]);
    ui.values.delete(recentKey);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
    assert.deepEqual(recentEntries(ui), []);
});

test("a denied history store does not stop generation or log history, mood, or storage exception details", async () => {
    const ui = browser(); clock(ui);
    const logs = [];
    ui.context.console = { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) };
    const get = ui.context.localStorage.getItem, set = ui.context.localStorage.setItem;
    ui.context.localStorage.getItem = key => { if (key === recentKey) throw new Error("PRIVATE-HISTORY"); return get(key); };
    ui.context.localStorage.setItem = (key, value) => { if (key === recentKey) throw new Error("PRIVATE-HISTORY"); return set(key, value); };
    const prior = { song: "PRIVATE-HISTORY", artist: "PRIVATE-ARTIST" };
    ui.context.rememberRecentRecommendations([prior]);
    ui.elements.moodInput.value = "PRIVATE-MOOD";
    await ui.context.showMood(new Element());
    await ui.context.showMood(new Element());
    assert.equal(ui.calls.length, 2); assert.ok(ui.calls.every(call => call.url === "/api/getPlaylist"));
    assert.deepEqual(ui.calls[0].body.recentSongs, [prior]);
    assert.deepEqual(ui.calls[1].body.recentSongs, [song, prior]);
    assert.deepEqual(plain(ui.context.currentPlaylist), [song]);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE-HISTORY|PRIVATE-ARTIST|PRIVATE-MOOD/);
});

test("failed removal can clear persisted history using an empty replacement", () => {
    const ui = browser(); clock(ui); ui.context.rememberRecentRecommendations([song]);
    ui.context.localStorage.removeItem = () => { throw new Error("Synthetic removal failure"); };
    ui.context.clearRecentRecommendations();
    assert.deepEqual(recentEntries(ui), []);
    assert.match(ui.elements.appStatus.textContent, /^Recent recommendation history cleared/);
});

test("a blocked persistent clear reports the limitation and still clears visit memory", () => {
    const ui = browser(); clock(ui); ui.context.rememberRecentRecommendations([song]);
    ui.context.localStorage.removeItem = () => { throw new Error("PRIVATE"); };
    ui.context.localStorage.setItem = () => { throw new Error("PRIVATE"); };
    ui.context.clearRecentRecommendations();
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
    assert.match(ui.elements.appStatus.textContent, /cleared for this visit\. Browser storage could not be updated/);
    assert.doesNotMatch(ui.elements.appStatus.textContent, /PRIVATE/);
});

test("fresh requests send only prior history pairs and record the successfully rendered recommendations", async () => {
    const prior = { song: "Prior", artist: "Prior Artist" };
    const ui = browser(); clock(ui); ui.context.rememberRecentRecommendations([prior]);
    ui.elements.moodInput.value = "PRIVATE emotional description";
    await ui.context.showMood(new Element());
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.deepEqual(ui.calls[0].body.recentSongs, [prior]);
    assert.equal(ui.calls[0].body.existingSongs, undefined);
    assert.deepEqual(ui.calls[0].body.avoidSongs, []);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [song, prior]);
    assert.ok(!ui.values.get(recentKey).includes("PRIVATE"));
    assert.ok(recentEntries(ui).every(item => Object.keys(item).length === 3));
});

test("clearing the current playlist does not erase recent memory or feedback", async () => {
    const ui = browser({ likedSongs: JSON.stringify([song]) }); clock(ui);
    ui.elements.moodInput.value = "Quiet nostalgia"; await ui.context.showMood(new Element());
    ui.context.clearNewList();
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), [song]);
    assert.equal(ui.values.get("likedSongs"), JSON.stringify([song]));
});

test("failed playlist generation records no recommendations and never retries", async () => {
    const ui = browser(); clock(ui); ui.elements.moodInput.value = "Synthetic mood";
    ui.context.fetch = async (url, options) => {
        ui.calls.push({ url, body: JSON.parse(options.body) });
        return { status: 502, text: async () => JSON.stringify({ error: "Synthetic failure" }) };
    };
    await ui.context.showMood(new Element());
    assert.equal(ui.calls.length, 1);
    assert.deepEqual(plain(ui.context.getRecentRecommendations()), []);
});

test("continuation remembers only new recommendations without refreshing the older playlist's expiry", async () => {
    const older = { song: "Older", artist: "Older Artist" };
    const ui = browser({ currentPlaylist: JSON.stringify([older]) }); clock(ui, recentNow - 500);
    ui.context.rememberRecentRecommendations([older]); clock(ui);
    ui.elements.moodInput.value = "Still missing someone";
    vm.runInContext(source("async function continuePlaylist()", "// $$$$"), ui.context);
    await ui.context.continuePlaylist();
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.deepEqual(ui.calls[0].body.existingSongs, [older]);
    assert.equal(ui.calls[0].body.recentSongs, undefined);
    assert.deepEqual(recentEntries(ui), [{ ...song, recommendedAt: recentNow }, { ...older, recommendedAt: recentNow - 500 }]);
});

test("mood entry is a labeled five-line required textarea with the requested example", () => {
    assert.ok(textarea);
    assert.match(textarea, /rows="5"/);
    assert.match(textarea, /maxlength="2000"/);
    assert.match(textarea, /\srequired(?:\s|>)/);
    assert.match(textarea, /placeholder="I'm feeling lonely tonight and would love music that's comforting, emotional, and a little hopeful\."/);
    assert.match(html, /<label for="moodInput"[^>]*>How are you feeling today\? \(required\)<\/label>/);
    assert.doesNotMatch(html, /<input\b[^>]*id="moodInput"/);
});

test("native Enter creates a new line without an interception or automatic playlist submission", () => {
    assert.doesNotMatch(textarea, /onkeydown|onkeypress|onkeyup/);
    assert.doesNotMatch(html, /function handleKey\(/);
    assert.doesNotMatch(html, /moodInput\.addEventListener\(["']key(?:down|press|up)/);
    assert.match(html, /Enter adds a new line\. Use Create Playlist when you’re ready/);
    assert.match(html, /id="createPlaylistBtn"[^>]*type="button"\s+onclick="showMood\(this\)"/);
});

test("textarea descriptions resolve and existing live announcements and result focus are retained", () => {
    const ids = textarea.match(/aria-describedby="([^"]+)"/)[1].split(/\s+/);
    for (const id of ids) assert.ok(html.includes(`id="${id}"`));
    assert.match(html, /id="moodError"[^>]*role="alert"/);
    assert.match(html, /id="appStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="result"[^>]*role="region"[^>]*tabindex="-1"/);
});

test("the primary heading and creator precede the collapsed introductory explanation", () => {
    assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
    assert.match(html, /<h1[^>]*>Tune4Me <span>— Music that understands your moment<\/span><\/h1>/);
    assert.match(html, /Free to try\. No account required\./);
    assert.ok(html.indexOf('id="createPlaylistBtn"') < html.indexOf('id="moreText"'));
    assert.match(html, /aria-expanded="false" aria-controls="moreText"/);
    assert.match(html, /id="moreText" style="display:none;"/);
    assert.doesNotMatch(html.slice(html.indexOf('</textarea>'), html.indexOf('id="createPlaylistBtn"')), /<p\b/);
});

test("secondary actions start quietly and use the actual save-button ID throughout", () => {
    assert.match(html, /id="floatingSaveBtn" class="secondary-button"[^>]*disabled/);
    assert.match(html, /class="secondary-button" onclick="clearNewList\(\)"/);
    assert.doesNotMatch(html, /getElementById\("savePlaylistBtn"\)/);
    assert.match(css, /\.secondary-button\s*\{[^}]*background: #EDF5FF;[^}]*color: #004A99;/);
});

test("a long multiline emotional description reaches generation intact and enables saving", async () => {
    const ui = browser();
    const mood = "I miss someone, but I feel relieved.\n\n" + "I want space for both feelings. ".repeat(35) + "\nPlease keep this gentle.";
    ui.elements.moodInput.value = mood;
    const button = new Element();
    await ui.context.showMood(button);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.equal(ui.calls[0].body.mood, mood);
    assert.equal(ui.elements.floatingSaveBtn.disabled, false);
    assert.equal(button.disabled, false);
    assert.equal(ui.elements.result.focused, true);
    assert.equal(ui.context.currentPlaylist.length, 1);
});

for (const [name, mood] of [["empty multiline entry", " \n\n "], ["overlong multiline entry", "a".repeat(1999) + "\nb"]]) {
    test(`${name} is rejected accessibly before any API request`, async () => {
        const ui = browser(); ui.elements.moodInput.value = mood;
        await ui.context.showMood(new Element());
        assert.equal(ui.calls.length, 0);
        assert.equal(ui.elements.moodInput.attributes["aria-invalid"], "true");
        assert.ok(ui.elements.moodError.textContent.length > 0);
        ui.context.clearMoodError();
        assert.equal(ui.elements.moodInput.attributes["aria-invalid"], undefined);
        assert.equal(ui.elements.moodError.textContent, "");
    });
}

test("the 2000-character boundary, including a newline, remains usable", async () => {
    const ui = browser(); ui.elements.moodInput.value = "a".repeat(999) + "\n" + "b".repeat(1000);
    await ui.context.showMood(new Element());
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].body.mood.length, 2000);
});

test("Create Playlist stays disabled during a pending request and recovers after failure", async () => {
    const ui = browser(); ui.elements.moodInput.value = "Lonely, with a little hope.";
    let rejectRequest; ui.context.fetch = () => new Promise((resolve, reject) => { rejectRequest = reject; });
    const button = new Element(); const pending = ui.context.showMood(button);
    assert.equal(button.disabled, true); assert.equal(ui.elements.floatingSaveBtn.disabled, true);
    rejectRequest(new Error("Mock network failure")); await pending;
    assert.equal(button.disabled, false); assert.equal(ui.elements.floatingSaveBtn.disabled, true);
});

test("clearing a generated playlist disables saving without removing favorites", async () => {
    const initial = JSON.stringify([song]); const ui = browser({ savedSongs: initial, saveLimit: "40" });
    ui.elements.moodInput.value = "Quiet nostalgia"; await ui.context.showMood(new Element());
    ui.context.clearNewList();
    assert.equal(ui.context.currentPlaylist.length, 0); assert.equal(ui.elements.floatingSaveBtn.disabled, true);
    assert.equal(ui.values.get("savedSongs"), initial); assert.equal(ui.values.get("saveLimit"), "40");
});

for (const songs of [[], [song]]) {
    test(`page initialization restores save-button availability for ${songs.length} existing playlist songs`, () => {
        const ui = browser({ currentPlaylist: JSON.stringify(songs), saveLimit: "65" });
        vm.runInContext(source("window.onload = function ()", "// HELPERS"), ui.context);
        ui.context.window.onload();
        assert.equal(ui.elements.floatingSaveBtn.disabled, songs.length === 0);
        assert.equal(ui.values.get("saveLimit"), "65");
    });
}

for (const limit of [15, 40, 65, 90, 100]) {
    test(`favorites messaging reports the existing ${limit}-song allowance without changing stored data`, () => {
        const initial = { savedSongs: JSON.stringify([song]), saveLimit: String(limit), songFeedback: "keep", likedSongs: "[]" };
        const ui = browser(initial); ui.context.loadSavedSongs();
        assert.equal(ui.elements.saveCounter.innerText, `Your favorites: 1 of ${limit} saved`);
        assert.deepEqual(Object.fromEntries(ui.values), initial);
        assert.equal(ui.elements.savedSongs.children.length, 1);
    });
}

test("empty and full favorites counts are concise and storage guidance remains visible", () => {
    const ui = browser(); ui.context.loadSavedSongs();
    assert.equal(ui.elements.saveCounter.innerText, "Your favorites: 0 of 15 saved");
    ui.values.set("savedSongs", JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ song: `Song ${i}`, artist: "Artist" }))));
    ui.context.loadSavedSongs();
    assert.match(ui.elements.saveCounter.innerText, /^Your favorites: 15 of 15 saved\nYour saved songs list is full/);
    assert.doesNotMatch(ui.elements.saveCounter.innerText, /spaces remaining/);
    assert.match(html, /<p class="favorites-note">Favorites are stored locally on this device\.<\/p>/);
});

test("saved-song count updates at the 100-song boundary without extending the allowance", () => {
    const ui = browser({ saveLimit: "100", savedSongs: JSON.stringify(Array.from({ length: 99 }, (_, i) => ({ song: `Song ${i}`, artist: "Artist" }))) });
    ui.context.saveSong(song.song, song.artist);
    assert.match(ui.elements.saveCounter.innerText, /^Your favorites: 100 of 100 saved/);
    ui.context.saveSong("Another Song", "Artist");
    assert.equal(JSON.parse(ui.values.get("savedSongs")).length, 100);
    assert.equal(ui.values.get("saveLimit"), "100");
});

test("upgrade information and forged success visits still cannot change capacity or open checkout", () => {
    const ui = browser({ saveLimit: "65", savedSongs: JSON.stringify([song]), tune4mePlus: "active" });
    const before = [...ui.values];
    ui.context.window.handleUpgrade(); ui.context.window.handleUpgrade();
    for (const match of success.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], ui.context);
    assert.deepEqual([...ui.values], before); assert.equal(ui.opened.length, 0);
    assert.match(ui.elements.appStatus.textContent, /temporarily unavailable/);
    assert.doesNotMatch(html, /Unlock More Saved Songs|onclick=["'][^\n]*buy\.stripe\.com/);
    assert.match(html, /Upgrades are temporarily unavailable\. Your saved songs and existing capacity are unchanged\./);
});

test("responsive mood entry fills its container, permits vertical resize, and retains visible focus", () => {
    assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
    const rule = css.match(/#moodInput\s*\{([^}]+)\}/)[1];
    assert.match(rule, /width: 100%/); assert.match(rule, /min-height: 160px/);
    assert.match(rule, /resize: vertical/); assert.match(rule, /font-size: 16px/);
    assert.match(css, /@media \(max-width: 360px\)/);
    assert.match(css, /textarea:focus-visible,[\s\S]*?outline: 3px solid #005FCC/);
});

function color(selector, property) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))[1];
    return rule.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(#[0-9a-f]{6})`, "i"))[1];
}
function contrast(a, b) {
    const luminance = hex => hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255)
        .map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
        .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
}
test("mood text, placeholder, primary action, and secondary text meet 4.5:1 contrast", () => {
    const background = color("#moodInput", "background");
    for (const [foreground, behind] of [[color("#moodInput", "color"), background], ["#4D4D4D", background],
        ["#FFFFFF", color(".create-playlist-button", "background")], [color(".secondary-button", "color"), color(".secondary-button", "background")]]) {
        assert.ok(contrast(foreground, behind) >= 4.5, `${foreground} on ${behind}`);
    }
});
test("blue boundaries and keyboard focus meet 3:1 contrast against adjacent backgrounds", () => {
    for (const [foreground, background] of [["#2563B0", color("#moodInput", "background")], ["#2563B0", "#F4F4F4"],
        ["#005FCC", "#FFFFFF"], ["#005FCC", color("#moodInput", "background")]]) assert.ok(contrast(foreground, background) >= 3);
});

test("primary and secondary button colors keep readable contrast across interaction states and pages", () => {
    for (const selector of ["button", "button:hover:not(:disabled)", "button:active:not(:disabled)"])
        assert.ok(contrast("#FFFFFF", color(selector, "background")) >= 4.5, selector);
    for (const selector of [".secondary-button", ".secondary-button:hover:not(:disabled)", ".secondary-button:active:not(:disabled)"])
        assert.ok(contrast(color(".secondary-button", "color"), color(selector, "background")) >= 4.5, selector);
    assert.ok(contrast(color("button:disabled", "color"), color("button:disabled", "background")) >= 4.5);
    for (const page of [html, success, readFileSync(new URL("../admin-analytics.html", import.meta.url), "utf8")]) {
        assert.doesNotMatch(page, /#1B5E20/i);
        assert.match(page, /button\s*\{[^}]*min-height: 44px;/);
        assert.match(page, /button\s*\{[^}]*border-radius: 10px;[^}]*background: #1456A0;|button\s*\{[^}]*background: #1456A0;[^}]*border-radius: 10px;/);
    }
});

test("generated, continued, and saved song controls retain behavior hooks and use the secondary blue theme", async () => {
    function controls(element) {
        return [element, ...element.children.flatMap(controls)].filter(item => item.attributes["aria-label"]);
    }
    function check(elements) {
        const buttons = elements.flatMap(controls).filter(item => /^(Save |Mark |Remove |Open YouTube )/.test(item.attributes["aria-label"]));
        assert.ok(buttons.length >= 2);
        for (const button of buttons) {
            assert.ok(button.className.split(/\s+/).includes("secondary-button"), button.attributes["aria-label"]);
            assert.equal(typeof button.events.click, "function");
            assert.equal(button.style.background, undefined);
            assert.equal(button.style.color, undefined);
        }
    }
    const ui = browser({ savedSongs: JSON.stringify([song]) });
    ui.elements.moodInput.value = "A quiet, complicated evening";
    await ui.context.showMood(new Element()); check(ui.elements.result.children);
    ui.context.loadSavedSongs(); check(ui.elements.savedSongs.children);
    const continued = browser(); continued.elements.moodInput.value = "Still missing someone";
    vm.runInContext(source("async function continuePlaylist()", "// $$$$"), continued.context);
    await continued.context.continuePlaylist(); check(continued.elements.result.children);
});
