import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");
const terms = readFileSync(new URL("../terms.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
const acceptanceKey = "tune4mePrivacyAcceptance";
const version = "2026-11-01";
const song = { song: "Synthetic Song", artist: "Synthetic Artist" };
const agreed = (analytics = false) => JSON.stringify({ version, acceptedAt: Date.now() - 1, analytics });

class Element {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase(); this.style = {}; this.attributes = {}; this.children = [];
        this.events = {}; this.dataset = {}; this.textContent = ""; this.innerText = ""; this.value = "";
        this.hidden = false; this.inert = false; this.disabled = false; this.checked = false; this.className = "";
        this.isConnected = true;
    }
    appendChild(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
        this.children.push(child); child.parentElement = this; child.isConnected = true; return child;
    }
    prepend(child) { this.children.unshift(child); child.parentElement = this; return child; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    get validity() {
        // Approximate native HTML email constraints in this offline DOM fixture.
        const emailSyntax = /^[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
        const missing = this.required && !this.value;
        const malformed = this.getAttribute("type") === "email" && this.value && !emailSyntax.test(this.value);
        return { valid: !missing && !malformed };
    }
    addEventListener(key, callback) { this.events[key] = callback; }
    click() { if (!this.disabled) return this.events.click?.({ currentTarget: this, target: this, isTrusted: true, stopPropagation() {}, preventDefault() {} }); }
    contains(item) { return item === this || descendants(this).includes(item); }
    insertAdjacentElement(position, item) {
        const parent = this.parentElement;
        if (!parent) return null;
        if (item.parentElement) item.parentElement.children = item.parentElement.children.filter(child => child !== item);
        const index = parent.children.indexOf(this) + (position === "afterend" ? 1 : 0);
        parent.children.splice(index, 0, item); item.parentElement = parent; item.isConnected = true;
        return item;
    }
    focus() { this.focused = true; }
    scrollIntoView() {}
    remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); }
    querySelector(selector) { return descendants(this).find(item => matches(item, selector)) || null; }
    closest(selector) { for (let item = this; item; item = item.parentElement) if (matches(item, selector)) return item; return null; }
    set innerHTML(value) { this.markup = value; this.children = []; }
    get innerHTML() { return this.markup || ""; }
}
function descendants(root) { return root.children.flatMap(child => [child, ...descendants(child)]); }
function matches(element, selector) {
    if (selector.startsWith(".")) return element.className.split(/\s+/).includes(selector.slice(1));
    return element.tagName.toLowerCase() === selector.toLowerCase();
}
function fixture() {
    const songs = Array.from({ length: 10 }, (_, index) => ({ song: `Synthetic ${index}`, artist: `Artist ${index}` }));
    return { playlist: { songs }, choices: [{ message: { content: `1. A synthetic playlist.\n\n2. 🎧 Songs:\n${songs.map(item => `- ${item.song} - ${item.artist}`).join("\n")}\n\n3. 🧠 Why this fits:\nAn unverified curator judgment.` } }] };
}
function page(initial = {}, options = {}) {
    const values = new Map(Object.entries(initial)), elements = {}, head = new Element("head"), body = new Element("body");
    const calls = [], beacons = [], opened = [], navigation = [], historyUpdates = [], logs = [], timers = new Map(), confirmations = [];
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
        const element = new Element(match[1]); elements[match[3]] = element;
        element.hidden = /\shidden(?:\s|$)/.test(match[2]); element.inert = /\sinert(?:\s|$)/.test(match[2]);
        element.disabled = /\sdisabled(?:\s|$)/.test(match[2]);
        element.required = /\srequired(?:\s|$)/.test(match[2]);
        element.className = match[2].match(/class="([^"]*)"/)?.[1] || "";
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attr[1], attr[2]);
        body.appendChild(element);
    }
    elements.supportMessage.form = new Element("form");
    elements.supportMessage.form.action = "https://formspree.io/f/xojrboej";
    elements.supportEmail.value = "listener@example.com";
    const localStorage = {
        getItem(key) { if (options.denyRead || options.unreadableKey === key) throw new Error("PRIVATE-STORAGE-ERROR"); return values.get(key) ?? null; },
        setItem(key, value) { if (options.denyWrite) throw new Error("PRIVATE-STORAGE-ERROR"); values.set(key, String(value)); },
        removeItem(key) { if (options.denyRemove) throw new Error("PRIVATE-STORAGE-ERROR"); values.delete(key); },
        key(index) { return [...values.keys()][index] ?? null; }, get length() { return values.size; }
    };
    const document = {
        head, body, getElementById: id => elements[id] || null,
        createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element(), { textContent: text }),
        querySelector: () => null,
        querySelectorAll(selector) {
            if (selector === "#savedSongs .card") return descendants(elements.savedSongs).filter(item => matches(item, ".card"));
            return descendants(body).filter(item => matches(item, selector));
        }
    };
    const window = {
        location: { origin: "https://staging.invalid", pathname: "/", search: options.search || "", hash: options.hash || "", replace: url => navigation.push(url) },
        history: { replaceState(_state, _title, url) {
            if (options.denyHistory) throw new Error("PRIVATE-HISTORY-ERROR");
            const target = new URL(url, window.location.origin);
            window.location.search = target.search; window.location.hash = target.hash; historyUpdates.push(url);
        } },
        addEventListener() {}, matchMedia: () => ({ matches: true }), open: (...args) => opened.push(args)
    };
    const context = vm.createContext({
        window, document, localStorage, Blob, AbortSignal, AbortController, URLSearchParams,
        navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
        requestAnimationFrame: callback => callback(),
        setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
        confirm: message => { confirmations.push(message); return options.confirm !== false; },
        console: Object.fromEntries(["log", "warn", "error"].map(level => [level, (...args) => logs.push([level, ...args])])),
        fetch: async (url, request) => {
            calls.push({ url, request });
            if (url === elements.supportMessage.form.action) {
                if (options.supportFetch) return options.supportFetch(url, request);
                return { status: 200, ok: true };
            }
            if (options.fetch) return options.fetch(url, request);
            assert.equal(url, "/api/getPlaylist", "Only the explicit mocked playlist request is allowed");
            const data = fixture(); return { status: 200, ok: true, text: async () => JSON.stringify(data), json: async () => data };
        }
    });
    if (options.denyGetter) Object.defineProperty(context, "localStorage", { get() { throw new Error("PRIVATE-STORAGE-GETTER"); } });
    for (const script of scripts) vm.runInContext(script, context);
    elements.supportMessage.form.requestSubmit = () => elements.supportMessage.form.events.submit({ preventDefault() {} });
    window.onload();
    function agree() { context.requirePrivacyAcceptance(null, elements.moodInput); return context.acceptPrivacyPolicy(); }
    return { agree, context, values, elements, head, body, calls, beacons, opened, navigation, historyUpdates, logs, timers, confirmations,
        evaluate: expression => vm.runInContext(expression, context) };
}
function normalize(text) { return text.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().toLowerCase(); }
function labelMatches(button) {
    const visible = normalize(button.innerText || button.textContent);
    const name = normalize(button.attributes["aria-label"] || visible);
    assert.ok(name.includes(visible), `Visible label '${visible}' must be contained in accessible name '${name}'`);
}

for (const action of ["single", "button", "playlist"]) {
    for (const initialCount of [99, 100]) {
        test(`save limit is clamped at every ${action} write after post-initialization storage tampering (${initialCount})`, () => {
            const saved = Array.from({ length: initialCount }, (_, index) => ({ song: `Saved ${index}`, artist: "Fixture Artist" }));
            const ui = page({ [acceptanceKey]: agreed(), savedSongs: JSON.stringify(saved), saveLimit: "100" });
            ui.values.set("saveLimit", "1000");
            if (action === "single") ui.context.saveSong("Extra Fixture", "Fixture Artist");
            if (action === "button") ui.context.saveSongWithVideo({ isTrusted: true, stopPropagation() {} }, "Extra Fixture", "Fixture Artist");
            if (action === "playlist") {
                ui.evaluate('currentPlaylist = [{song:"Extra Fixture",artist:"Fixture Artist"},{song:"Second Fixture",artist:"Fixture Artist"}]');
                ui.context.savePlaylist();
            }
            const stored = JSON.parse(ui.values.get("savedSongs"));
            assert.equal(stored.length, 100);
            assert.deepEqual(stored.slice(0, initialCount), saved);
            assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
        });
    }
}

test("clamping the maximum preserves lower legacy capacity and already-saved records", () => {
    const saved = Array.from({ length: 65 }, (_, i) => ({ song: `Legacy ${i}`, artist: "Fixture Artist" }));
    const raw = JSON.stringify(saved);
    const ui = page({ [acceptanceKey]: agreed(), savedSongs: raw, saveLimit: "65" });
    ui.context.saveSong("New Fixture", "Fixture Artist");
    assert.equal(ui.values.get("savedSongs"), raw); assert.equal(ui.values.get("saveLimit"), "65");
    assert.equal(ui.calls.length, 0);
});

test("a pre-existing over-cap collection is preserved but cannot be enlarged by app save actions", () => {
    const saved = Array.from({ length: 101 }, (_, i) => ({ song: `Existing ${i}`, artist: "Fixture Artist" }));
    const raw = JSON.stringify(saved);
    const ui = page({ [acceptanceKey]: agreed(), savedSongs: raw, saveLimit: "100" });
    ui.values.set("saveLimit", "1000"); ui.context.saveSong("New Fixture", "Fixture Artist");
    assert.equal(ui.values.get("savedSongs"), raw); assert.equal(ui.calls.length, 0);
});

test("first visit permits browsing without an agreement or optional third-party requests", () => {
    const ui = page();
    assert.equal(ui.elements.appFeatures.hidden, false); assert.equal(ui.elements.appFeatures.inert, false);
    assert.equal(ui.elements.acceptPrivacyBtn.hidden, false);
    assert.equal(ui.head.children.length, 0); assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
    assert.match(html, /id="appFeatures">/); assert.equal(ui.elements.privacyAgreement.hidden, true);
    assert.doesNotMatch(html, /<script\b[^>]*src=["'](?:https:\/\/www\.youtube\.com|\/_vercel\/insights)/);
});

for (const action of ["showMood", "continuePlaylist", "playSong", "playAllSongs", "playSavedSongs", "saveSong", "saveFeedback", "savePlaylist", "saveSongWithVideo"]) {
    test(`unaccepted direct ${action} action fails closed without requests or stored preferences`, async () => {
        const ui = page(), before = JSON.stringify([...ui.values]); ui.elements.moodInput.value = "Synthetic request";
        await ui.context[action]();
        assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0); assert.equal(ui.opened.length, 0);
        assert.equal(JSON.stringify([...ui.values]), before); assert.equal(ui.elements.privacyHeading.focused, true);
        assert.match(ui.elements.privacyStatus.textContent, /No request has been sent/);
    });
}
test("direct music lookup stays blocked while support works without music agreement", async () => {
    const ui = page();
    const result = await ui.context.lookupYouTubePreview(song.song, song.artist, []);
    assert.equal(result.status, 403);
    const pending = ui.evaluate("pendingPrivacyAction");
    let prevented = false; await ui.elements.supportMessage.form.events.submit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(ui.calls.length, 1); assert.equal(ui.beacons.length, 0);
    assert.equal(ui.calls[0].url, ui.elements.supportMessage.form.action);
    assert.equal(ui.evaluate("pendingPrivacyAction"), pending);
    assert.equal(ui.values.has(acceptanceKey), false); assert.equal(ui.evaluate("privacyAccepted"), false);
});

test("agreement activates features with analytics off by default and preserves favorites and capacity", () => {
    const saved = JSON.stringify([song]); const ui = page({ savedSongs: saved, saveLimit: "65" });
    ui.agree();
    assert.equal(ui.elements.appFeatures.hidden, false); assert.equal(ui.elements.appFeatures.inert, false);
    assert.equal(ui.elements.moodInput.focused, true); assert.equal(ui.head.children.length, 0);
    const receipt = JSON.parse(ui.values.get(acceptanceKey));
    assert.deepEqual(Object.keys(receipt).sort(), ["acceptedAt", "analytics", "version"]);
    assert.equal(receipt.version, version); assert.equal(receipt.analytics, false); assert.ok(Number.isFinite(receipt.acceptedAt));
    assert.equal(ui.values.get("savedSongs"), saved); assert.equal(ui.values.get("saveLimit"), "65");
    assert.equal(ui.beacons.length, 0); assert.equal(ui.calls.length, 0);
    const reload = page(Object.fromEntries(ui.values)); assert.equal(reload.elements.appFeatures.hidden, false);
});
test("optional analytics requires a separate affirmative choice and starts only once", () => {
    const ui = page(); ui.elements.analyticsChoice.checked = true; ui.agree();
    ui.context.updatePrivacyControls();
    assert.equal(ui.head.children.length, 1); assert.equal(ui.head.children[0].src, "/_vercel/insights/script.js");
    assert.equal(ui.beacons.length, 1); assert.equal(ui.beacons[0].url, "/api/analytics");
    assert.equal(JSON.parse(ui.values.get(acceptanceKey)).analytics, true);
    assert.equal(ui.calls.length, 0); assert.ok(!ui.head.children.some(script => script.src.includes("youtube")));
});
test("opted-out analytics stays off on reload and does not block a ten-song playlist", async () => {
    const ui = page({ [acceptanceKey]: agreed(false) }); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.equal(JSON.parse(ui.calls[0].request.body).length, undefined);
    assert.equal(ui.evaluate("currentPlaylist.length"), 10); assert.equal(ui.beacons.length, 0);
    assert.equal(ui.head.children.length, 0);
});

for (const receipt of ["{bad", "null", '"yes"', "[]", JSON.stringify({ version: "older", acceptedAt: 1 }),
    JSON.stringify({ version, acceptedAt: "1" }), JSON.stringify({ version, acceptedAt: -1 }),
    JSON.stringify({ version, acceptedAt: Date.now() + 86400000, analytics: true })]) {
    test(`invalid/obsolete agreement fails closed (${receipt})`, () => {
        const ui = page({ [acceptanceKey]: receipt });
        assert.equal(ui.evaluate("privacyAccepted"), false); assert.equal(ui.elements.privacyAgreement.hidden, true); assert.equal(ui.head.children.length, 0); assert.equal(ui.beacons.length, 0);
    });
}
test("withdrawal stops playback and revokes agreement in place without deleting song data", () => {
    const saved = JSON.stringify([song]); const ui = page({ [acceptanceKey]: agreed(true), savedSongs: saved, saveLimit: "65", avoidSongs: saved });
    const wrapper = new Element(); wrapper.className = "video-wrapper"; let destroyed = 0;
    wrapper.youtubePlayer = { destroy() { destroyed++; } }; ui.elements.player.appendChild(wrapper);
    ui.context.withdrawPrivacyAcceptance(); ui.context.trackTune4Me("song_saved");
    assert.equal(destroyed, 1); assert.equal(ui.values.has(acceptanceKey), false);
    assert.equal(ui.elements.appFeatures.hidden, false); assert.equal(ui.elements.appFeatures.inert, false);
    assert.deepEqual(ui.navigation, []); assert.deepEqual(ui.historyUpdates, ["/?privacy=review"]); assert.equal(ui.beacons.length, 1);
    for (const key of ["savedSongs", "avoidSongs"]) assert.equal(ui.values.get(key), saved);
    assert.equal(ui.values.get("saveLimit"), "65"); assert.equal(ui.calls.length, 0);
});
test("withdrawal review marker overrides an undeletable stored receipt until fresh explicit agreement", () => {
    const receipt = agreed(true); const ui = page({ [acceptanceKey]: receipt }, { denyRemove: true, denyWrite: true });
    ui.context.withdrawPrivacyAcceptance(); assert.equal(ui.values.get(acceptanceKey), receipt);
    const reload = page(Object.fromEntries(ui.values), { search: "?privacy=review" });
    assert.equal(reload.evaluate("privacyAccepted"), false); assert.equal(reload.elements.appFeatures.hidden, false); assert.equal(reload.head.children.length, 0);
    reload.agree(); assert.equal(reload.elements.appFeatures.hidden, false);
    assert.equal(reload.context.window.location.search, "");
});
test("a preview loads the YouTube API only on explicit demand and shares initialization without retries", async () => {
    const ui = page({ [acceptanceKey]: agreed() });
    assert.equal(ui.head.children.length, 0);
    const first = ui.context.waitForYouTubeApi(), second = ui.context.waitForYouTubeApi();
    assert.equal(first, second); assert.equal(ui.head.children.length, 1);
    assert.equal(ui.head.children[0].src, "https://www.youtube.com/iframe_api");
    ui.context.window.YT = { Player() {} }; ui.context.window.onYouTubeIframeAPIReady();
    await first; await second;
    assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
});
test("YouTube script failure rejects once without scheduling another load or lookup", async () => {
    const ui = page({ [acceptanceKey]: agreed() });
    const pending = ui.context.waitForYouTubeApi(); ui.head.children[0].onerror();
    await assert.rejects(pending, /unavailable/);
    assert.equal(ui.head.children.length, 1); assert.equal(ui.calls.length, 0); assert.equal(ui.timers.size, 0);
});

for (const key of ["savedSongs", "currentPlaylist", "likedSongs", "avoidSongs", "songFeedback"]) {
    for (const raw of ["{broken", "null", '"wrong shape"', '{"song":"wrong shape"}', '[null,{},"invalid"]']) {
        test(`corrupt ${key} is ignored without clearing unrelated data (${raw})`, () => {
            const ui = page({ [key]: raw, saveLimit: "65", [acceptanceKey]: agreed(), untouched: "keep" });
            assert.equal(ui.values.get(key), raw); assert.equal(ui.values.get("saveLimit"), "65");
            assert.equal(ui.values.get("untouched"), "keep"); assert.equal(ui.elements.appFeatures.hidden, false);
            assert.deepEqual(JSON.parse(JSON.stringify(ui.context.readStoredSongs(key))), []);
            assert.equal(ui.logs.length, 0); assert.equal(ui.calls.length, 0);
        });
    }
}
test("valid legacy records survive shape filtering without changing artist identity or allowance", () => {
    const legacy = [{ song: "Legacy" }, song, null]; const raw = JSON.stringify(legacy);
    const ui = page({ savedSongs: raw, saveLimit: "65" });
    assert.deepEqual(JSON.parse(JSON.stringify(ui.context.readStoredSongs("savedSongs"))), [{ song: "Legacy", artist: "" }, song]);
    assert.equal(ui.values.get("savedSongs"), raw); assert.equal(ui.values.get("saveLimit"), "65");
});
for (const options of [{ denyGetter: true }, { denyRead: true, denyWrite: true, denyRemove: true }, { denyWrite: true }]) {
    test(`blocked or full storage does not crash initialization (${JSON.stringify(options)})`, () => {
        const ui = page({}, options); ui.agree(); ui.context.saveSong(song.song, song.artist);
        assert.equal(ui.elements.appFeatures.hidden, false);
        assert.equal(ui.context.readStoredSongs("savedSongs").length, 1);
        assert.match(ui.elements.storageStatus.textContent, /visit/);
        assert.equal(ui.calls.length, 0); assert.equal(ui.logs.length, 0);
        assert.equal(ui.context.getCachedVideo(song.song, song.artist), null);
    });
}
test("a failed read cannot later overwrite previously unread saved songs when storage becomes writable", () => {
    const original = JSON.stringify([song]), options = { unreadableKey: "savedSongs" };
    const ui = page({ savedSongs: original, saveLimit: "65", [acceptanceKey]: agreed() }, options);
    delete options.unreadableKey;
    ui.context.saveSong("Visit-only", "Fixture");
    assert.equal(ui.values.get("savedSongs"), original);
    assert.equal(ui.context.readStoredSongs("savedSongs")[0].song, "Visit-only");
});
test("saving after corrupt JSON preserves the unreadable original until an explicit clear", () => {
    const raw = "{PRIVATE-CORRUPT-RECORD"; const ui = page({ savedSongs: raw, [acceptanceKey]: agreed() });
    ui.context.saveSong(song.song, song.artist); assert.equal(ui.values.get("savedSongs"), raw);
    assert.equal(ui.context.readStoredSongs("savedSongs").length, 1);
    ui.context.clearSavedSongs(); assert.equal(ui.values.has("savedSongs"), false);
    assert.ok(!JSON.stringify(ui.logs).includes("PRIVATE-CORRUPT-RECORD"));
});

test("preference reset deletes only feedback, likes and avoidance, independently of agreement", () => {
    const data = JSON.stringify([song]);
    const ui = page({ songFeedback: data, likedSongs: data, avoidSongs: data, savedSongs: data, saveLimit: "65",
        currentPlaylist: data, tune4meRecentRecommendations: data, unrelated: "keep" });
    const protectedKeys = ["savedSongs", "saveLimit", "currentPlaylist", "tune4meRecentRecommendations", "unrelated"];
    const before = protectedKeys.map(key => ui.values.get(key));
    ui.context.clearStoredPreferences();
    assert.equal(ui.confirmations.length, 1);
    for (const key of ["songFeedback", "likedSongs", "avoidSongs"]) assert.equal(ui.values.has(key), false);
    assert.deepEqual(protectedKeys.map(key => ui.values.get(key)), before);
    assert.match(ui.elements.privacyStatus.textContent, /cleared/); assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
});
test("cancelled preference reset leaves every stored record unchanged", () => {
    const data = JSON.stringify([song]); const ui = page({ songFeedback: data, likedSongs: data, avoidSongs: data }, { confirm: false });
    const before = [...ui.values]; ui.context.clearStoredPreferences(); assert.deepEqual([...ui.values], before);
});
test("cleared preferences are absent from the next request while recent history and favorites remain", async () => {
    const data = JSON.stringify([song]); const recent = JSON.stringify([{ ...song, recommendedAt: Date.now() }]);
    const ui = page({ [acceptanceKey]: agreed(), likedSongs: data, avoidSongs: data, songFeedback: data,
        savedSongs: data, saveLimit: "65", tune4meRecentRecommendations: recent });
    ui.context.clearStoredPreferences(); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    const request = JSON.parse(ui.calls[0].request.body);
    assert.deepEqual(request.avoidSongs, []); assert.deepEqual(request.likedSongs, []);
    assert.deepEqual(request.recentSongs, [song]);
    assert.equal(ui.values.get("savedSongs"), data); assert.equal(ui.values.get("saveLimit"), "65");
    assert.equal(ui.calls.length, 1); assert.equal(ui.head.children.length, 0);
});
test("agreed support submission does not require optional analytics", async () => {
    const ui = page({ [acceptanceKey]: agreed() }); let prevented = false;
    await ui.elements.supportMessage.form.events.submit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(ui.beacons.length, 0); assert.equal(ui.calls.length, 1);
    assert.equal(ui.elements.supportStatus.textContent, "Your message was sent. Thank you for your feedback.");
});
test("failed deletion can clear preferences using an empty replacement", () => {
    const data = JSON.stringify([song]); const ui = page({ songFeedback: data, likedSongs: data, avoidSongs: data }, { denyRemove: true });
    ui.context.clearStoredPreferences();
    for (const key of ["songFeedback", "likedSongs", "avoidSongs"]) assert.equal(ui.values.get(key), "[]");
    assert.match(ui.elements.privacyStatus.textContent, /preferences cleared/i);
});
test("blocked preference deletion reports visit-only clearing without claiming persistent deletion", () => {
    const data = JSON.stringify([song]); const ui = page({ songFeedback: data, likedSongs: data, avoidSongs: data, savedSongs: data }, { denyRemove: true, denyWrite: true });
    ui.context.clearStoredPreferences();
    for (const key of ["songFeedback", "likedSongs", "avoidSongs"]) {
        assert.equal(ui.values.get(key), data); assert.equal(ui.context.readStoredSongs(key).length, 0);
    }
    assert.equal(ui.values.get("savedSongs"), data); assert.match(ui.elements.privacyStatus.textContent, /may return after reload/);
});

test("all static text-labelled buttons include their visible words in their accessible name", () => {
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
        const label = match[1].match(/aria-label="([^"]+)"/)?.[1]; if (!label) continue;
        const visible = normalize(match[2].replace(/<[^>]+>/g, " "));
        if (visible) assert.ok(normalize(label).includes(visible), `${visible}: ${label}`);
    }
});
test("generated and saved controls preserve Label in Name including Open YouTube and Remove and avoid", async () => {
    const ui = page({ [acceptanceKey]: agreed(), savedSongs: JSON.stringify([song]) }); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    for (const root of [ui.elements.result, ui.elements.savedSongs]) {
        const buttons = descendants(root).filter(element => element.tagName === "BUTTON");
        assert.ok(buttons.length > 0); for (const button of buttons) labelMatches(button);
    }
    const remove = descendants(ui.elements.result).find(element => element.textContent === "🗑 Remove and avoid");
    assert.ok(remove); remove.events.click();
    assert.equal(ui.evaluate("currentPlaylist.length"), 9); assert.equal(ui.context.readStoredSongs("avoidSongs").length, 1);
    assert.equal(ui.context.readStoredSongs("savedSongs").length, 1);
    assert.match(html, /Remove and avoid removes a song[\s\S]*future avoidance/);
});
test("preview toggles expose Stop and restore Preview First Song in accessible names", () => {
    const ui = page({ [acceptanceKey]: agreed(), savedSongs: JSON.stringify([song]) });
    ui.context.playNextSong = () => {}; const button = new Element("button"); button.className = "play-saved-btn"; ui.body.appendChild(button);
    ui.context.playSavedSongs(button); assert.equal(button.innerText, "⏹ Stop"); labelMatches(button);
    ui.context.stopPlayback(); assert.equal(button.innerText, "▶ Preview First Song"); labelMatches(button);
});
test("the YouTube error fallback retains Listen on YouTube in its accessible name", () => {
    const ui = page({ [acceptanceKey]: agreed() }), slot = new Element();
    ui.context.showPreviewFailure(slot, song.song, song.artist, "unplayable");
    const button = descendants(slot).find(element => element.tagName === "BUTTON"); labelMatches(button);
    button.events.click(); assert.equal(ui.opened.length, 1);
    ui.context.withdrawPrivacyAcceptance(); button.events.click(); assert.equal(ui.opened.length, 1);
});
test("the privacy flow retains native labels, live announcements, focus, and Enter-as-newline", () => {
    assert.match(html, /<button id="acceptPrivacyBtn" type="button"/);
    assert.match(html, /<label[^>]*for="analyticsChoice"/);
    assert.match(html, /id="privacyStatus"[^>]*role="status" aria-live="polite"/);
    assert.match(html, /id="storageStatus"[^>]*role="status" aria-live="polite"/);
    assert.match(html, /Enter adds a new line/);
    assert.doesNotMatch(html, /moodInput\.addEventListener\(["']key(?:down|press|up)/);
    const ui = page(); ui.agree(); assert.equal(ui.elements.moodInput.focused, true);
});
test("privacy and terms accurately describe agreement, retention, providers, deletion and disabled purchases", () => {
    assert.match(privacy, /Last updated: November 6, 2026/);
    assert.match(terms, /Last updated: November 1, 2026/);
    for (const page of [privacy, terms]) {
        assert.match(page, /checkout[\s\S]{0,100}disabled/i);
        assert.match(page, /100-song limit/); assert.match(page, /unverified AI judgments|AI judgments/);
    }
    for (const phrase of [/30-day expiration/, /no automatic expiry/, /Clear Likes, Dislikes and Avoidance/,
        /Clear Saved Songs/, /Withdraw privacy agreement/, /seven days/, /advertisements/, /IP addresses/,
        /separate opt-in/, /does not automatically erase provider records/, /not audio files/]) assert.match(privacy, phrase);
    assert.match(privacy, /https:\/\/policies.google.com\/privacy/); assert.match(terms, /https:\/\/www.youtube.com\/t\/terms/);
});
test("the historical real-provider response artifact is absent and excluded from future uploads", () => {
    assert.equal(existsSync(new URL("./local-preview-audit.json", import.meta.url)), false);
    assert.match(readFileSync(new URL("../.vercelignore", import.meta.url), "utf8"), /^tests\/local-preview-audit\.json$/m);
    assert.doesNotMatch(readFileSync(new URL("./README.md", import.meta.url), "utf8"), /\[local-preview-audit\.json\]\(local-preview-audit\.json\)/);
});

test("drafting before agreement neither transmits nor automatically saves the description", () => {
    const ui = page(); const before = [...ui.values];
    ui.elements.moodInput.value = "UNSENT-DRAFT-SENTINEL\nIncluding a new line";
    ui.elements.moodInput.events.input();
    assert.deepEqual([...ui.values], before); assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
    assert.equal(ui.head.children.length, 0); assert.equal(ui.elements.privacyAgreement.hidden, true);
    assert.equal(ui.elements.appFeatures.hidden, false); assert.equal(ui.elements.appFeatures.inert, false);
    assert.equal(ui.evaluate("pendingPrivacyAction"), null);
});
test("first Create opens the inline agreement without sending, and Agree resumes it exactly once", async () => {
    const ui = page(); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    assert.equal(ui.elements.privacyAgreement.hidden, false); assert.equal(ui.elements.privacyHeading.focused, true);
    assert.equal(ui.elements.acceptPrivacyBtn.textContent, "Agree and create playlist");
    assert.equal(ui.calls.length, 0); assert.equal(ui.evaluate("privacyAccepted"), false);
    const first = ui.context.acceptPrivacyPolicy(), repeated = ui.context.acceptPrivacyPolicy();
    await Promise.all([first, repeated]);
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    assert.equal(ui.evaluate("currentPlaylist.length"), 10);
    assert.equal(ui.elements.privacyAgreement.hidden, true); assert.equal(ui.evaluate("pendingPrivacyAction"), null);
    await ui.context.acceptPrivacyPolicy(); assert.equal(ui.calls.length, 1);
    assert.equal(ui.beacons.length, 0); assert.equal(ui.head.children.length, 0);
});
test("Not now preserves the draft and preferences and returns focus to Create", async () => {
    const ui = page({ savedSongs: JSON.stringify([song]), saveLimit: "65" });
    ui.elements.moodInput.value = "UNCHANGED-DRAFT\nSecond line"; const before = [...ui.values];
    await ui.context.showMood(ui.elements.createPlaylistBtn); ui.context.cancelPrivacyAgreement();
    assert.equal(ui.elements.moodInput.value, "UNCHANGED-DRAFT\nSecond line"); assert.deepEqual([...ui.values], before);
    assert.equal(ui.elements.createPlaylistBtn.focused, true); assert.equal(ui.elements.privacyAgreement.hidden, true);
    assert.equal(ui.evaluate("privacyAccepted"), false); assert.equal(ui.calls.length, 0);
    await ui.context.acceptPrivacyPolicy(); assert.equal(ui.calls.length, 0); assert.deepEqual([...ui.values], before);
    assert.equal(ui.elements.appFeatures.inert, false);
});
test("Escape cancels without trapping Tab or submitting a request", async () => {
    const ui = page(); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    let prevented = false;
    ui.elements.privacyAgreement.events.keydown({ key: "Tab", preventDefault() { prevented = true; } });
    assert.equal(prevented, false); assert.equal(ui.elements.privacyAgreement.hidden, false);
    ui.elements.privacyAgreement.events.keydown({ key: "Escape", preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(ui.elements.privacyAgreement.hidden, true);
    assert.equal(ui.elements.createPlaylistBtn.focused, true); assert.equal(ui.calls.length, 0);
});
test("edits made while agreement is open are validated and used, preserving current exclusions", async () => {
    const ui = page(); ui.elements.moodInput.value = "Original synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    const current = "Updated mood. Do not include any songs by the excluded fixture artist.";
    ui.elements.moodInput.value = current;
    assert.ok(!JSON.stringify([...ui.values]).includes(current)); assert.equal(ui.calls.length, 0);
    await ui.context.acceptPrivacyPolicy();
    assert.equal(JSON.parse(ui.calls[0].request.body).mood, current); assert.equal(ui.elements.moodInput.value, current);
    assert.equal(ui.calls.length, 1);
});
for (const draft of ["", " ", "a".repeat(2001)]) {
    test(`invalid draft is not sent or queued (${draft.length} characters)`, async () => {
        const ui = page(); ui.elements.moodInput.value = draft;
        await ui.context.showMood(ui.elements.createPlaylistBtn);
        assert.equal(ui.elements.privacyAgreement.hidden, true); assert.equal(ui.evaluate("pendingPrivacyAction"), null);
        assert.equal(ui.elements.moodInput.attributes["aria-invalid"], "true"); assert.equal(ui.calls.length, 0);
    });
}
test("an emptied draft is revalidated after agreement without sending or retrying", async () => {
    const ui = page(); ui.elements.moodInput.value = "Initial draft";
    await ui.context.showMood(ui.elements.createPlaylistBtn); ui.elements.moodInput.value = "";
    await ui.context.acceptPrivacyPolicy();
    assert.equal(ui.calls.length, 0); assert.equal(ui.elements.moodInput.attributes["aria-invalid"], "true");
    assert.equal(ui.evaluate("privacyActionRunning"), false);
});
test("repeated or competing activations keep only the first pending action", async () => {
    const ui = page(); let first = 0, second = 0;
    ui.context.requirePrivacyAcceptance(() => { first++; }, ui.elements.createPlaylistBtn, "Agree and create playlist");
    ui.context.requirePrivacyAcceptance(() => { second++; }, ui.elements.moodInput, "Agree and play YouTube preview");
    assert.equal(ui.elements.acceptPrivacyBtn.textContent, "Agree and create playlist");
    await Promise.all([ui.context.acceptPrivacyPolicy(), ui.context.acceptPrivacyPolicy()]);
    assert.equal(first, 1); assert.equal(second, 0);
});
test("repeated Create activations before agreement produce only one playlist request", async () => {
    const ui = page(); ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn); await ui.context.showMood(ui.elements.createPlaylistBtn);
    await ui.context.acceptPrivacyPolicy(); assert.equal(ui.calls.length, 1);
});
test("a failed resumed request is not retried by repeated Agree clicks", async () => {
    const ui = page(); let attempted = 0;
    ui.context.fetch = async () => { attempted++; throw new Error("SYNTHETIC-NETWORK-FAILURE"); };
    ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn); await ui.context.acceptPrivacyPolicy();
    await ui.context.acceptPrivacyPolicy(); assert.equal(attempted, 1);
    assert.equal(ui.evaluate("pendingPrivacyAction"), null); assert.equal(ui.evaluate("privacyActionRunning"), false);
});
test("reloading or restoring valid acceptance never automatically resumes an action", async () => {
    const ui = page(); ui.elements.moodInput.value = "Unsent mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    const unacceptedReload = page(Object.fromEntries(ui.values));
    assert.equal(unacceptedReload.evaluate("pendingPrivacyAction"), null); assert.equal(unacceptedReload.calls.length, 0);
    assert.equal(unacceptedReload.elements.privacyAgreement.hidden, true);
    const acceptedReload = page({ [acceptanceKey]: agreed() });
    assert.equal(acceptedReload.evaluate("privacyAccepted"), true); assert.equal(acceptedReload.calls.length, 0);
    assert.equal(acceptedReload.elements.privacyAgreement.hidden, true);
    acceptedReload.elements.moodInput.value = "Fresh explicit request";
    await acceptedReload.context.showMood(acceptedReload.elements.createPlaylistBtn);
    assert.equal(acceptedReload.calls.length, 1); assert.equal(acceptedReload.elements.privacyAgreement.hidden, true);
});
test("first saved-song playback uses the YouTube agreement label and resumes only the selected playback", async () => {
    const ui = page({ savedSongs: JSON.stringify([song]) }); let plays = 0;
    ui.context.playNextSong = (index, selector) => { assert.equal(index, 0); assert.equal(selector, "#savedSongs"); plays++; };
    const button = new Element("button"); button.className = "play-saved-btn"; ui.body.appendChild(button);
    ui.context.playSavedSongs(button);
    assert.equal(plays, 0); assert.equal(ui.head.children.length, 0); assert.equal(ui.calls.length, 0);
    assert.equal(ui.elements.acceptPrivacyBtn.textContent, "Agree and play YouTube preview");
    await ui.context.acceptPrivacyPolicy(); await ui.context.acceptPrivacyPolicy();
    assert.equal(plays, 1); assert.equal(button.innerText, "⏹ Stop"); labelMatches(button);
});
test("cancelling saved playback makes no lookup and returns focus to its button", () => {
    const ui = page({ savedSongs: JSON.stringify([song]) }); const button = new Element("button"); ui.body.appendChild(button);
    ui.context.playSavedSongs(button); ui.context.cancelPrivacyAgreement();
    assert.equal(button.focused, true); assert.equal(ui.calls.length, 0); assert.equal(ui.head.children.length, 0);
    assert.equal(ui.evaluate("isPlayingAll"), false);
});
test("the agreement is restored to a stable location before a resumed action can rerender its trigger", async () => {
    const ui = page(), button = new Element("button"); ui.body.appendChild(button);
    ui.context.requirePrivacyAcceptance(() => button.remove(), button);
    assert.equal(ui.elements.privacyAgreement.parentElement, ui.body);
    await ui.context.acceptPrivacyPolicy();
    assert.equal(ui.elements.privacyAgreement.parentElement, ui.elements.privacyAgreementHome);
    assert.equal(ui.elements.privacyAgreement.hidden, true);
});
test("a removed triggering control cannot resume a stale action", async () => {
    const ui = page(), button = new Element("button"); ui.body.appendChild(button); let invoked = 0;
    ui.context.requirePrivacyAcceptance(() => { invoked++; }, button); button.remove();
    await ui.context.acceptPrivacyPolicy();
    assert.equal(invoked, 0); assert.equal(ui.evaluate("privacyAccepted"), false);
    assert.equal(ui.elements.moodInput.focused, true);
});
test("withdrawal cancels a waiting action and leaves the next homepage browseable", async () => {
    const ui = page(); let invoked = 0;
    ui.context.requirePrivacyAcceptance(() => { invoked++; }, ui.elements.createPlaylistBtn);
    ui.context.withdrawPrivacyAcceptance(); await ui.context.acceptPrivacyPolicy();
    assert.equal(invoked, 0); assert.equal(ui.elements.appFeatures.hidden, false); assert.equal(ui.elements.appFeatures.inert, false);
    const reload = page(Object.fromEntries(ui.values), { search: "?privacy=review" });
    assert.equal(reload.elements.privacyAgreement.hidden, true); assert.equal(reload.calls.length, 0);
    assert.equal(reload.elements.appFeatures.hidden, false);
});
test("an existing current receipt is reused, while a changed policy version requires a fresh action agreement", async () => {
    const valid = page({ [acceptanceKey]: agreed() }); assert.equal(valid.evaluate("privacyAccepted"), true);
    const old = page({ [acceptanceKey]: JSON.stringify({ version: "older-policy", acceptedAt: Date.now() - 1 }) });
    old.elements.moodInput.value = "Synthetic mood"; await old.context.showMood(old.elements.createPlaylistBtn);
    assert.equal(old.elements.privacyAgreement.hidden, false); assert.equal(old.calls.length, 0);
    await old.context.acceptPrivacyPolicy(); assert.equal(old.calls.length, 1);
});
test("analytics opt-in remains separate, off by default and unchanged by browsing, decline, or playback", async () => {
    const ui = page(); assert.equal(ui.elements.analyticsChoice.checked, false);
    ui.elements.moodInput.value = "Synthetic mood"; await ui.context.showMood(ui.elements.createPlaylistBtn);
    ui.context.cancelPrivacyAgreement(); assert.equal(ui.beacons.length, 0); assert.equal(ui.head.children.length, 0);
    await ui.context.showMood(ui.elements.createPlaylistBtn); await ui.context.acceptPrivacyPolicy();
    assert.equal(JSON.parse(ui.values.get(acceptanceKey)).analytics, false); assert.equal(ui.beacons.length, 0);
});
test("an analytics choice made in settings is not silently reset when the agreement opens", async () => {
    const ui = page(); ui.elements.analyticsChoice.checked = true; ui.elements.moodInput.value = "Synthetic mood";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    assert.equal(ui.elements.analyticsChoice.checked, true); assert.equal(ui.head.children.length, 0);
    await ui.context.acceptPrivacyPolicy();
    assert.equal(JSON.parse(ui.values.get(acceptanceKey)).analytics, true);
    assert.equal(ui.beacons.length, 2); // Explicit opted-in home and generated-playlist events.
    assert.equal(ui.head.children.filter(item => item.src === "/_vercel/insights/script.js").length, 1);
    assert.equal(ui.head.children.some(item => item.src.includes("youtube")), false);
});
test("feedback never grants music consent and playlist submission still requires agreement", async () => {
    const ui = page();
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.calls.length, 1); assert.equal(ui.evaluate("pendingPrivacyAction"), null);
    assert.equal(ui.elements.privacyAgreement.hidden, true); assert.equal(ui.values.has(acceptanceKey), false);
    ui.elements.moodInput.value = "Synthetic music request";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    assert.equal(ui.calls.length, 1); assert.equal(ui.elements.privacyAgreement.hidden, false);
    assert.equal(ui.elements.acceptPrivacyBtn.textContent, "Agree and create playlist");
    await ui.context.acceptPrivacyPolicy(); await ui.context.acceptPrivacyPolicy();
    assert.equal(ui.calls.filter(call => call.url === "/api/getPlaylist").length, 1);
});

test("support email is required, labelled and connected to a persistent accessible error", () => {
    const ui = page();
    assert.equal(ui.elements.supportEmail.getAttribute("type"), "email");
    assert.equal(ui.elements.supportEmail.getAttribute("name"), "email");
    assert.equal(ui.elements.supportEmail.required, true);
    assert.equal(ui.elements.supportEmail.getAttribute("autocomplete"), "email");
    assert.equal(ui.elements.supportEmail.getAttribute("maxlength"), "254");
    assert.match(ui.elements.supportEmail.getAttribute("aria-describedby"), /supportEmailHint.*supportEmailError/);
    assert.equal(ui.elements.supportEmailError.getAttribute("role"), "alert");
    assert.equal(ui.elements.supportEmailError.hidden, true);
    assert.match(html, /<label for="supportEmail"[^>]*>Email \(required\)<\/label>/);
    assert.match(privacy, /support form requires an email address/i);
});

for (const email of ["", " ", "listener", "listener@", "@example.com", "listener example@example.com",
    "listener@@example.com", "listener@example..com", "listener@-example.com",
    "listener@example.com,other@example.com", "listener@example.com\nBcc: other@example.com",
    "<script>@example.com", "a".repeat(255) + "@example.com"]) {
    test("malformed support email is blocked accessibly before consent or transmission " + JSON.stringify(email), () => {
        const ui = page();
        ui.elements.supportEmail.value = email;
        ui.elements.supportMessage.value = "PRIVATE-SUPPORT-MESSAGE";
        ui.elements.moodInput.value = "PRIVATE-MUSIC-DRAFT";
        let prevented = false;
        ui.elements.supportMessage.form.events.submit({ preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(ui.elements.supportEmail.getAttribute("aria-invalid"), "true");
        assert.equal(ui.elements.supportEmail.focused, true);
        assert.equal(ui.elements.supportEmailError.hidden, false);
        assert.match(ui.elements.supportEmailError.textContent, /valid email address/i);
        assert.equal(ui.elements.supportMessage.value, "PRIVATE-SUPPORT-MESSAGE");
        assert.equal(ui.elements.moodInput.value, "PRIVATE-MUSIC-DRAFT");
        assert.equal(ui.elements.privacyAgreement.hidden, true);
        assert.equal(ui.calls.length, 0);
        assert.equal(ui.beacons.length, 0);
        assert.equal(ui.logs.length, 0);
        assert.equal(ui.elements.supportMessage.form.submissions, undefined);
    });
}

for (const email of ["listener@example.com", "listener+support@example.co.uk", "O'Connor@example.com",
    "First.Last@sub.example.com", "listener@xn--bcher-kva.example"]) {
    test("well-formed support email preserves ordinary address formats " + email, async () => {
        const ui = page({ [acceptanceKey]: agreed() });
        ui.elements.supportEmail.value = " " + email + " ";
        let prevented = false;
        await ui.elements.supportMessage.form.events.submit({ preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.equal(ui.elements.supportEmail.value, email);
        assert.equal(ui.elements.supportEmailError.hidden, true);
        assert.equal(ui.elements.supportEmail.getAttribute("aria-invalid"), null);
        assert.equal(ui.calls.length, 1);
        assert.equal(ui.beacons.length, 0);
    });
}

test("native email invalid events announce a safe error and editing clears stale error state", () => {
    const ui = page({ [acceptanceKey]: agreed() });
    ui.elements.supportEmail.value = "PRIVATE-INVALID-CONTACT";
    let prevented = false;
    ui.elements.supportEmail.events.invalid({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(ui.elements.supportEmail.focused, true);
    assert.equal(ui.elements.supportEmailError.hidden, false);
    assert.doesNotMatch(ui.elements.supportEmailError.textContent, /PRIVATE/);
    ui.elements.supportEmail.value = "listener@example.com";
    ui.elements.supportEmail.events.input();
    assert.equal(ui.elements.supportEmail.getAttribute("aria-invalid"), null);
    assert.equal(ui.elements.supportEmailError.hidden, true);
    assert.equal(ui.elements.supportEmailError.textContent, "");
    assert.equal(ui.context.validateSupportEmail(), true);
});

test("support remains independent of an already-pending playlist agreement", async () => {
    const ui = page();
    ui.elements.moodInput.value = "Synthetic music request";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    const pending = ui.evaluate("pendingPrivacyAction");
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.calls.length, 1); assert.equal(ui.evaluate("pendingPrivacyAction"), pending);
    assert.equal(ui.evaluate("privacyAccepted"), false);
    await ui.context.acceptPrivacyPolicy();
    assert.equal(ui.calls.filter(call => call.url === "/api/getPlaylist").length, 1);
    assert.equal(ui.calls.filter(call => call.url === ui.elements.supportMessage.form.action).length, 1);
    assert.equal(ui.beacons.length, 0);
});

test("support email and message stay out of storage, public playlist content, analytics and music requests", async () => {
    const ui = page({ [acceptanceKey]: agreed(true) });
    ui.elements.supportEmail.value = "private-support-fixture@example.com";
    ui.elements.supportMessage.value = "PRIVATE-SUPPORT-MESSAGE https://example.invalid/support-fixture";
    ui.elements.result.textContent = "Existing public playlist fixture";
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.elements.result.textContent, "Existing public playlist fixture");
    assert.equal(ui.calls.length, 1);
    assert.deepEqual([...ui.calls[0].request.body.keys()], ["name", "email", "topic", "message"]);
    assert.equal(ui.calls[0].request.body.get("message"), ui.elements.supportMessage.value);
    const diagnostics = JSON.stringify({ storage: [...ui.values], logs: ui.logs });
    assert.doesNotMatch(diagnostics, /private-support-fixture|PRIVATE-SUPPORT-MESSAGE|support-fixture/);
    for (const beacon of ui.beacons) {
        const body = await beacon.blob.text();
        assert.deepEqual(Object.keys(JSON.parse(body)), ["event"]);
        assert.doesNotMatch(body, /private-support-fixture|PRIVATE-SUPPORT-MESSAGE|support-fixture/);
    }
    ui.elements.moodInput.value = "Synthetic music request";
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    assert.equal(ui.calls.length, 2);
    assert.doesNotMatch(ui.calls[1].request.body, /private-support-fixture|PRIVATE-SUPPORT-MESSAGE|support-fixture/);
});
test("support processing notice is adjacent to Send and its status is a persistent accessible live region", () => {
    const ui = page();
    assert.equal(ui.elements.supportSendBtn.getAttribute("aria-describedby"), "supportProcessingNotice");
    assert.equal(ui.elements.supportStatus.getAttribute("role"), "status");
    assert.equal(ui.elements.supportStatus.getAttribute("aria-live"), "polite");
    assert.equal(ui.elements.supportStatus.getAttribute("aria-atomic"), "true");
    assert.equal(ui.elements.supportStatus.hidden, false);
    assert.match(html, /id="supportProcessingNotice"[\s\S]*?name, email, topic and message with Formspree[\s\S]*?<a href="\/privacy.html">Privacy Policy<\/a>[\s\S]*?id="supportSendBtn"[\s\S]*?id="supportStatus"/);
    assert.match(privacy, /Sending feedback does not grant consent to playlist/);
    assert.doesNotMatch(html, /first active music action or support submission|Agree and send support message/);
});

test("slow support submission shows pending status, keeps focus and prevents duplicate sends", async () => {
    let finish;
    const ui = page({}, { supportFetch: () => new Promise(resolve => { finish = resolve; }) });
    ui.elements.supportMessage.value = "Synthetic support message";
    ui.elements.supportSendBtn.focus();
    const pending = ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.elements.supportStatus.textContent, "Sending your message…");
    assert.equal(ui.elements.supportSendBtn.getAttribute("aria-disabled"), "true");
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.calls.length, 1); assert.equal(ui.elements.supportSendBtn.focused, true);
    assert.equal(ui.elements.supportMessage.value, "Synthetic support message");
    assert.equal(ui.evaluate("privacyAccepted"), false);
    finish({ ok: true, status: 200 }); await pending;
    assert.equal(ui.elements.supportStatus.textContent, "Your message was sent. Thank you for your feedback.");
    assert.equal(ui.elements.supportSendBtn.getAttribute("aria-disabled"), null);
    assert.equal(ui.calls.length, 1); assert.equal(ui.elements.supportEmail.focused, undefined);
    assert.equal(ui.elements.supportMessage.value, "Synthetic support message");
});

for (const status of [400, 422, 429, 500, 503]) {
    test("support HTTP failure " + status + " preserves all entries and only retries on a new submission", async () => {
        let attempts = 0;
        const ui = page({}, { supportFetch: async () => ({ ok: ++attempts > 1, status: attempts === 1 ? status : 200 }) });
        const expected = { supportName: "Fixture Listener", supportEmail: "listener@example.com",
            supportTopic: "Bug", supportMessage: "Synthetic support message" };
        for (const [key, value] of Object.entries(expected)) ui.elements[key].value = value;
        await ui.elements.supportMessage.form.requestSubmit();
        assert.equal(ui.elements.supportStatus.textContent, "We couldn’t send your message. Please try again.");
        assert.equal(ui.calls.length, 1); assert.equal(attempts, 1);
        assert.equal(ui.elements.supportSendBtn.getAttribute("aria-disabled"), null);
        for (const [key, value] of Object.entries(expected)) assert.equal(ui.elements[key].value, value);
        await ui.elements.supportMessage.form.requestSubmit();
        assert.equal(ui.calls.length, 2); assert.equal(attempts, 2);
        assert.equal(ui.elements.supportStatus.textContent, "Your message was sent. Thank you for your feedback.");
        assert.equal(ui.values.has(acceptanceKey), false); assert.equal(ui.elements.privacyAgreement.hidden, true);
    });
}

test("support network errors use a fixed safe message without logging provider responses or retrying", async () => {
    const ui = page({}, { supportFetch: async () => { throw new Error("PRIVATE-NETWORK-ERROR"); } });
    ui.elements.supportMessage.value = "PRIVATE-SUPPORT-MESSAGE";
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.elements.supportStatus.textContent, "We couldn’t send your message. Please try again.");
    assert.equal(ui.calls.length, 1); assert.equal(ui.logs.length, 0); assert.equal(ui.beacons.length, 0);
    assert.equal(ui.elements.supportMessage.value, "PRIVATE-SUPPORT-MESSAGE");
    assert.equal(ui.elements.supportSendBtn.getAttribute("aria-disabled"), null);
    assert.doesNotMatch(ui.elements.supportStatus.textContent, /PRIVATE/);
});

test("support uses only its bounded form fields and never accepts redirected responses", async () => {
    const ui = page();
    ui.elements.moodInput.value = "PRIVATE-MUSIC-DRAFT";
    await ui.elements.supportMessage.form.requestSubmit();
    const request = ui.calls[0].request;
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit"); assert.equal(request.headers.Accept, "application/json");
    assert.deepEqual([...request.body.keys()], ["name", "email", "topic", "message"]);
    assert.ok(!request.body.toString().includes("PRIVATE-MUSIC-DRAFT"));
    assert.equal(ui.evaluate("privacyAccepted"), false); assert.equal(ui.values.has(acceptanceKey), false);
});

test("invalid support email cannot enter a sending state or send after a previous success", async () => {
    const ui = page();
    await ui.elements.supportMessage.form.requestSubmit();
    ui.elements.supportEmail.value = "not-an-email";
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.calls.length, 1); assert.equal(ui.elements.supportStatus.textContent, "");
    assert.equal(ui.elements.supportEmail.focused, true);
    assert.equal(ui.elements.supportEmailError.hidden, false);
    assert.equal(ui.elements.supportSendBtn.getAttribute("aria-disabled"), null);
});

test("support keeps working after music consent is withdrawn without granting it again", async () => {
    const ui = page({ [acceptanceKey]: agreed(true) });
    ui.context.withdrawPrivacyAcceptance();
    const beaconsBeforeSupport = ui.beacons.length;
    await ui.elements.supportMessage.form.requestSubmit();
    assert.equal(ui.calls.length, 1); assert.equal(ui.evaluate("privacyAccepted"), false);
    assert.equal(ui.values.has(acceptanceKey), false); assert.equal(ui.elements.privacyAgreement.hidden, true);
    assert.equal(ui.beacons.length, beaconsBeforeSupport);
});

test("an external YouTube action resumes only on its specifically labelled agreement", async () => {
    const ui = page(), slot = new Element(); ui.context.showPreviewFailure(slot, song.song, song.artist, "unplayable");
    const button = descendants(slot).find(element => element.tagName === "BUTTON"); ui.body.appendChild(slot);
    button.click(); assert.equal(ui.opened.length, 0); assert.equal(ui.elements.acceptPrivacyBtn.textContent, "Agree and open YouTube");
    await ui.context.acceptPrivacyPolicy(); await ui.context.acceptPrivacyPolicy();
    assert.equal(ui.opened.length, 1); assert.equal(ui.calls.length, 0);
});
test("a cancelled action releases pending closures without storing its draft, song or callback", async () => {
    const ui = page(); ui.elements.moodInput.value = "PRIVATE-DRAFT-NOT-PERSISTED";
    await ui.context.showMood(ui.elements.createPlaylistBtn); ui.context.cancelPrivacyAgreement();
    assert.equal(ui.evaluate("pendingPrivacyAction"), null);
    for (const value of [JSON.stringify([...ui.values]), JSON.stringify(ui.logs), JSON.stringify(ui.navigation)])
        assert.ok(!value.includes("PRIVATE-DRAFT-NOT-PERSISTED"));
    assert.equal(ui.calls.length, 0);
});

test("a resumed action's exception is sanitized and never triggers a second attempt", async () => {
    const ui = page(); let attempts = 0;
    ui.context.requirePrivacyAcceptance(() => { attempts++; throw new Error("PRIVATE-ACTION-ERROR"); }, ui.elements.createPlaylistBtn);
    await ui.context.acceptPrivacyPolicy(); await ui.context.acceptPrivacyPolicy();
    assert.equal(attempts, 1); assert.equal(ui.calls.length, 0);
    assert.equal(ui.evaluate("privacyActionRunning"), false); assert.equal(ui.evaluate("pendingPrivacyAction"), null);
    assert.match(ui.elements.privacyStatus.textContent, /no automatic retry/);
    assert.ok(!JSON.stringify(ui.logs).includes("PRIVATE-ACTION-ERROR"));
    assert.ok(!ui.elements.privacyStatus.textContent.includes("PRIVATE-ACTION-ERROR"));
});

function existingContent(initial = {}, options = {}) {
    const songs = Array.from({ length: 10 }, (_, index) => ({ song: `Existing ${index}`, artist: `Fixture ${index}` }));
    const stored = JSON.stringify(songs);
    const ui = page({ [acceptanceKey]: agreed(), currentPlaylist: stored, savedSongs: JSON.stringify([song]),
        likedSongs: stored, avoidSongs: "[]", songFeedback: "[]", saveLimit: "65",
        tune4meRecentRecommendations: JSON.stringify([{ ...song, recommendedAt: Date.now() }]), ...initial }, options);
    ui.elements.moodInput.value = "PRIVATE-UNSAVED-DRAFT\nKeep this exact wording.";
    ui.elements.result.innerHTML = "EXISTING-PLAYLIST-MARKUP";
    for (const text of ["Existing introduction", "Existing ten-song list", "Existing explanation"]) {
        const part = new Element("p"); part.textContent = text; ui.elements.result.appendChild(part);
    }
    ui.elements.lastMood.innerText = "EXISTING-MOOD-LABEL";
    return ui;
}
function displayedContent(ui) {
    return { draft: ui.elements.moodInput.value, markup: ui.elements.result.innerHTML,
        children: [...ui.elements.result.children], text: ui.elements.result.children.map(item => item.textContent),
        lastMood: ui.elements.lastMood.innerText, playlist: ui.evaluate("JSON.stringify(currentPlaylist)") };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function previewResponse() {
    const candidate = { videoId: "abc123_____", video: { title: "Synthetic recording", channelTitle: "Fixture",
        madeForKids: false, duration: "PT3M", durationSeconds: 180 } };
    return { ok: true, status: 200, json: async () => ({ ...candidate, candidates: [candidate], nextSearchStage: 4 }) };
}

for (const action of ["Not now", "Escape"]) test(`${action} preserves the complete existing playlist, explanation and draft`, async () => {
    const ui = existingContent({ [acceptanceKey]: null }); const content = displayedContent(ui), stored = [...ui.values];
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    if (action === "Escape") ui.elements.privacyAgreement.events.keydown({ key: "Escape", preventDefault() {} });
    else ui.context.cancelPrivacyAgreement();
    assert.deepEqual(displayedContent(ui), content); assert.deepEqual([...ui.values], stored);
    assert.equal(ui.elements.createPlaylistBtn.focused, true); assert.match(ui.elements.privacyStatus.textContent, /draft is unchanged/);
    assert.equal(ui.calls.length, 0); assert.equal(ui.navigation.length, 0);
});

test("withdrawal retains exact displayed content and all user storage independently of consent", () => {
    const ui = existingContent(), content = displayedContent(ui);
    const stored = [...ui.values].filter(([key]) => key !== acceptanceKey);
    ui.context.withdrawPrivacyAcceptance();
    assert.deepEqual(displayedContent(ui), content);
    assert.deepEqual([...ui.values].filter(([key]) => key !== acceptanceKey), stored);
    assert.equal(ui.values.has(acceptanceKey), false); assert.deepEqual(ui.navigation, []);
    assert.equal(ui.evaluate("privacyAccepted || analyticsAllowed || privacyActionRunning"), false);
    assert.equal(ui.evaluate("pendingPrivacyAction"), null);
    assert.equal(ui.elements.privacyControlsToggle.focused, true);
    assert.match(ui.elements.privacyStatus.textContent, /Agreement withdrawn\. Playback stopped\. Your draft and playlist are unchanged/);
    assert.equal(ui.elements.privacyStatus.getAttribute("role"), "status");
    assert.equal(ui.elements.privacyStatus.getAttribute("aria-live"), "polite");
    for (const output of [JSON.stringify([...ui.values]), JSON.stringify(ui.logs), JSON.stringify(ui.historyUpdates)])
        assert.ok(!output.includes("PRIVATE-UNSAVED-DRAFT"));
    assert.equal(ui.calls.length, 0); assert.equal(ui.beacons.length, 0);
});

test("withdrawal destroys active players and timers but leaves song cards intact", () => {
    const ui = existingContent(), content = displayedContent(ui); let destroyed = 0;
    const wrapper = new Element(); wrapper.className = "video-wrapper";
    wrapper.youtubePlayer = { destroy() { destroyed++; } }; ui.elements.player.appendChild(wrapper);
    const iframe = new Element("iframe"); iframe.src = "https://www.youtube-nocookie.com/embed/synthetic"; wrapper.appendChild(iframe);
    ui.evaluate("isPlayingAll = true; playlistTimer = setTimeout(() => {}, 30000)");
    ui.context.withdrawPrivacyAcceptance();
    assert.equal(destroyed, 1); assert.equal(iframe.src, ""); assert.equal(wrapper.isConnected, false);
    assert.equal(ui.evaluate("isPlayingAll"), false); assert.equal(ui.evaluate("playlistTimer"), null);
    assert.equal(ui.timers.size, 0); assert.deepEqual(displayedContent(ui), content);
});

for (const failure of ["denyWrite", "denyRemove", "denyRead", "denyGetter", "corrupt", "all storage"]) {
    test(`withdrawal stays fail-closed on reload with ${failure}`, () => {
        const options = failure === "all storage" ? { denyRead: true, denyWrite: true, denyRemove: true }
            : failure === "corrupt" ? {} : { [failure]: true };
        const ui = existingContent(failure === "corrupt" ? { [acceptanceKey]: "corrupt-json" } : {}, options);
        const content = displayedContent(ui); ui.context.withdrawPrivacyAcceptance();
        assert.deepEqual(displayedContent(ui), content); assert.equal(ui.navigation.length, 0);
        const reload = page(Object.fromEntries(ui.values), { ...options, search: ui.context.window.location.search });
        assert.equal(reload.evaluate("privacyAccepted"), false); assert.equal(reload.beacons.length, 0); assert.equal(reload.head.children.length, 0);
    });
}
test("blocked receipt deletion and write cannot restore consent because the URL marker survives", () => {
    const receipt = agreed(true), ui = existingContent({ [acceptanceKey]: receipt }, { denyWrite: true, denyRemove: true });
    ui.context.withdrawPrivacyAcceptance(); assert.equal(ui.values.get(acceptanceKey), receipt);
    const reload = page(Object.fromEntries(ui.values), { search: ui.context.window.location.search });
    assert.equal(reload.evaluate("privacyAccepted"), false); assert.equal(reload.beacons.length, 0);
    assert.equal(reload.head.children.length, 0);
});
test("a fragment marker preserves withdrawal when history and persistent receipt changes are blocked", () => {
    const receipt = agreed(true), ui = existingContent({ [acceptanceKey]: receipt }, { denyHistory: true, denyWrite: true, denyRemove: true });
    const content = displayedContent(ui); ui.context.withdrawPrivacyAcceptance();
    assert.match(ui.context.window.location.hash, /tune4me-privacy=review/);
    assert.deepEqual(displayedContent(ui), content); assert.equal(ui.navigation.length, 0);
    const reload = page(Object.fromEntries(ui.values), { hash: ui.context.window.location.hash });
    assert.equal(reload.evaluate("privacyAccepted"), false); assert.equal(reload.head.children.length, 0);
});
test("receipt revocation still works when all same-page address changes are blocked", () => {
    const ui = existingContent({}, { denyHistory: true });
    Object.defineProperty(ui.context.window.location, "hash", { get: () => "", set() { throw new Error("PRIVATE-HASH-ERROR"); } });
    ui.context.withdrawPrivacyAcceptance();
    assert.equal(ui.values.has(acceptanceKey), false); assert.equal(ui.navigation.length, 0);
    assert.equal(page(Object.fromEntries(ui.values)).evaluate("privacyAccepted"), false);
});
test("complete inability to persist withdrawal is reported without losing content or claiming durable revocation", () => {
    const ui = existingContent({}, { denyHistory: true, denyWrite: true, denyRemove: true }), content = displayedContent(ui);
    Object.defineProperty(ui.context.window.location, "hash", { get: () => "", set() { throw new Error("PRIVATE-HASH-ERROR"); } });
    ui.context.withdrawPrivacyAcceptance(); assert.deepEqual(displayedContent(ui), content);
    assert.equal(ui.evaluate("privacyAccepted"), false); assert.match(ui.elements.privacyStatus.textContent, /old stored agreement may otherwise return/);
    assert.ok(!ui.elements.privacyStatus.textContent.includes("PRIVATE-HASH-ERROR"));
    assert.equal(ui.navigation.length, 0); assert.equal(ui.calls.length, 0);
});
test("renewed visit-only acceptance does not remove a fail-closed marker when receipt writes fail", async () => {
    const ui = existingContent({}, { denyWrite: true, denyRemove: true }); ui.context.withdrawPrivacyAcceptance();
    await ui.agree(); assert.equal(ui.evaluate("privacyAccepted"), true);
    assert.equal(ui.context.window.location.search, "?privacy=review");
    const reload = page(Object.fromEntries(ui.values), { search: ui.context.window.location.search });
    assert.equal(reload.evaluate("privacyAccepted"), false);
});
test("withdrawal and renewed acceptance preserve unrelated query and fragment values", async () => {
    const ui = existingContent({}, { search: "?source=fixture", hash: "#about" });
    ui.context.withdrawPrivacyAcceptance(); assert.equal(ui.context.window.location.search, "?source=fixture&privacy=review");
    await ui.agree(); assert.equal(ui.context.window.location.search, "?source=fixture"); assert.equal(ui.context.window.location.hash, "#about");
});

for (const action of ["showMood", "continuePlaylist"]) {
    for (const phase of ["headers", "body"]) for (const outcome of ["success", "error"]) {
        test(`withdrawal aborts ${action} and ignores late ${phase} ${outcome} after renewed agreement`, async () => {
            const waiting = deferred(); let bodyStarted = false;
            const response = { ok: true, status: 200,
                text: () => { bodyStarted = true; return waiting.promise; },
                json: () => { bodyStarted = true; return waiting.promise; } };
            const ui = existingContent({}, { fetch: () => phase === "headers" ? waiting.promise : Promise.resolve(response) });
            const pending = ui.context[action](ui.elements.createPlaylistBtn); await flush();
            assert.equal(ui.calls.length, 1); if (phase === "body") assert.equal(bodyStarted, true);
            const logCount = ui.logs.length;
            const signal = ui.calls[0].request.signal; assert.equal(signal.aborted, false);
            ui.context.withdrawPrivacyAcceptance(); const content = displayedContent(ui), stored = [...ui.values];
            assert.equal(signal.aborted, true); assert.equal(ui.evaluate("privacyRequests.size"), 0);
            await ui.agree(); const afterAccept = [...ui.values];
            if (outcome === "error") waiting.reject(new Error("PRIVATE-LATE-ERROR"));
            else if (phase === "headers") waiting.resolve({ ok: true, status: 200, text: async () => JSON.stringify(fixture()), json: async () => fixture() });
            else waiting.resolve(action === "showMood" ? JSON.stringify(fixture()) : fixture());
            await pending;
            assert.deepEqual(displayedContent(ui), content); assert.deepEqual([...ui.values], afterAccept);
            assert.deepEqual([...ui.values].filter(([key]) => key !== acceptanceKey), stored.filter(([key]) => key !== acceptanceKey));
            assert.equal(ui.calls.length, 1); assert.equal(ui.logs.length, logCount);
        });
    }
}

test("a withdrawn Agree callback cannot clear a newer pending action's running guard", async () => {
    const ui = page(), old = deferred(), next = deferred();
    ui.context.requirePrivacyAcceptance(() => old.promise, ui.elements.createPlaylistBtn);
    const first = ui.context.acceptPrivacyPolicy(); ui.context.withdrawPrivacyAcceptance();
    ui.context.requirePrivacyAcceptance(() => next.promise, ui.elements.createPlaylistBtn);
    const second = ui.context.acceptPrivacyPolicy(); old.reject(new Error("PRIVATE-OLD-ACTION")); await first;
    assert.equal(ui.evaluate("privacyActionRunning"), true); assert.equal(ui.elements.acceptPrivacyBtn.disabled, true);
    assert.ok(!ui.elements.privacyStatus.textContent.includes("could not finish"));
    next.resolve(); await second; assert.equal(ui.evaluate("privacyActionRunning"), false);
});

test("late YouTube lookup cannot populate caches or remove a newer same-song request", async () => {
    const old = deferred(), next = deferred(); let count = 0;
    const ui = existingContent({}, { fetch: () => ++count === 1 ? old.promise : next.promise });
    const first = ui.context.lookupYouTubePreview(song.song, song.artist, []);
    const firstSignal = ui.calls[0].request.signal; ui.context.withdrawPrivacyAcceptance();
    assert.equal(firstSignal.aborted, true); assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 0);
    await ui.agree(); const second = ui.context.lookupYouTubePreview(song.song, song.artist, []);
    old.resolve(previewResponse()); assert.equal((await first).status, 403);
    assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 1);
    assert.equal(ui.context.window.tune4mePreviewLookups.pools.size, 0);
    next.resolve(previewResponse()); assert.equal((await second).status, 200);
    assert.equal(ui.calls.length, 2); assert.equal(ui.context.window.tune4mePreviewLookups.pending.size, 0);
});
test("withdrawal ignores a late YouTube response body without caching or retrying", async () => {
    const body = deferred(), ui = existingContent({}, { fetch: async () => ({ ok: true, status: 200, json: () => body.promise }) });
    const pending = ui.context.lookupYouTubePreview(song.song, song.artist, []); await flush();
    ui.context.withdrawPrivacyAcceptance(); body.resolve(await previewResponse().json());
    assert.equal((await pending).status, 403); assert.equal(ui.context.window.tune4mePreviewLookups.pools.size, 0);
    assert.equal(ui.calls.length, 1);
});
test("late player API readiness cannot create a player after withdrawal and reacceptance", async () => {
    const ui = existingContent(), ready = deferred(); let constructed = 0;
    ui.context.waitForYouTubeApi = () => ready.promise;
    const { wrapper } = ui.context.createYouTubePreviewWrapper("https://www.youtube-nocookie.com/embed/synthetic", ui.elements.createPlaylistBtn);
    ui.elements.player.appendChild(wrapper); ui.context.withdrawPrivacyAcceptance(); await ui.agree();
    ready.resolve({ Player: function () { constructed++; } }); await flush();
    assert.equal(constructed, 0); assert.equal(ui.calls.length, 0);
});
test("late ready and playing callbacks cannot restart withdrawn playback or record it", async () => {
    const ui = existingContent(); let events, played = 0, recorded = 0;
    ui.context.window.YT = { Player: function (_iframe, config) {
        events = config.events; return { destroy() {}, playVideo() { played++; } };
    } };
    const { wrapper } = ui.context.createYouTubePreviewWrapper("https://www.youtube-nocookie.com/embed/synthetic", ui.elements.createPlaylistBtn,
        () => { throw new Error("Unexpected late error callback"); }, () => { recorded++; });
    ui.elements.player.appendChild(wrapper); await flush(); assert.ok(events);
    ui.context.withdrawPrivacyAcceptance(); await ui.agree();
    events.onReady({ target: { playVideo() { played++; } } }); events.onStateChange({ data: 1 }); events.onError({ data: 100 });
    assert.equal(played, 0); assert.equal(recorded, 0); assert.equal(ui.calls.length, 0);
});
test("request invalidation still protects content in a browser without AbortController", async () => {
    const waiting = deferred(), ui = existingContent({}, { fetch: () => waiting.promise });
    ui.context.AbortController = undefined;
    const pending = ui.context.showMood(ui.elements.createPlaylistBtn); ui.context.withdrawPrivacyAcceptance(); const content = displayedContent(ui);
    waiting.reject(new Error("PRIVATE-LATE-ERROR")); await pending;
    assert.deepEqual(displayedContent(ui), content); assert.equal(ui.calls.length, 1); assert.equal(ui.logs.length, 0);
});

test("the registered analytics beforeSend predicate suppresses all later events after withdrawal", async () => {
    const ui = existingContent({ [acceptanceKey]: agreed(true) });
    const beforeSend = ui.context.window.vaq.find(args => args[0] === "beforeSend")[1], event = { type: "pageview", url: "https://staging.invalid/" };
    assert.equal(beforeSend(event), event); assert.equal(ui.head.children.length, 1);
    const sent = ui.beacons.length; ui.context.withdrawPrivacyAcceptance();
    assert.equal(beforeSend(event), null); ui.context.trackTune4Me("song_saved"); ui.context.updatePrivacyControls();
    assert.equal(ui.beacons.length, sent); assert.equal(ui.elements.analyticsChoice.checked, false);
    await ui.agree(); assert.equal(beforeSend(event), null); assert.equal(ui.head.children.length, 1);
    ui.context.withdrawPrivacyAcceptance(); ui.elements.analyticsChoice.checked = true; await ui.agree();
    assert.equal(beforeSend(event), event); assert.equal(ui.head.children.length, 1);
});
test("analytics consent revoked while its script loads is checked when a queued event would be sent", () => {
    const ui = page(); ui.elements.analyticsChoice.checked = true; ui.agree();
    const queue = ui.context.window.vaq, gate = queue.find(args => args[0] === "beforeSend")[1];
    assert.equal(queue[0][0], "beforeSend"); ui.context.withdrawPrivacyAcceptance();
    assert.equal(gate({ type: "pageview" }), null); assert.equal(ui.navigation.length, 0);
});
test("withdrawn music actions wait for renewed agreement and Create resumes exactly once", async () => {
    const ui = existingContent(); ui.context.withdrawPrivacyAcceptance(); const content = displayedContent(ui);
    await ui.context.showMood(ui.elements.createPlaylistBtn); ui.context.cancelPrivacyAgreement();
    assert.deepEqual(displayedContent(ui), content); assert.equal(ui.calls.length, 0);
    assert.equal((await ui.context.lookupYouTubePreview(song.song, song.artist, [])).status, 403);
    ui.context.cancelPrivacyAgreement();
    await ui.context.showMood(ui.elements.createPlaylistBtn);
    await Promise.all([ui.context.acceptPrivacyPolicy(), ui.context.acceptPrivacyPolicy()]);
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/getPlaylist");
    await ui.context.acceptPrivacyPolicy(); assert.equal(ui.calls.length, 1);
    assert.equal(ui.beacons.length, 0); assert.equal(ui.head.children.length, 0);
});
test("withdrawal discards a queued action rather than resuming it on a later agreement", async () => {
    const ui = page(); let discarded = 0, requested = 0;
    ui.context.requirePrivacyAcceptance(() => { discarded++; }, ui.elements.createPlaylistBtn);
    ui.context.withdrawPrivacyAcceptance(); await ui.context.acceptPrivacyPolicy();
    assert.equal(discarded, 0);
    ui.context.requirePrivacyAcceptance(() => { requested++; }, ui.elements.createPlaylistBtn);
    await ui.context.acceptPrivacyPolicy(); await ui.context.acceptPrivacyPolicy();
    assert.equal(discarded, 0); assert.equal(requested, 1); assert.equal(ui.calls.length, 0);
});

test("a late preview completion cannot install a timer or clear a newly authorized playback timer", async () => {
    const ui = existingContent(), pending = deferred(), card = new Element(), button = new Element("button"), title = new Element();
    card.className = "card"; title.textContent = "Existing 0"; card.appendChild(title); card.appendChild(button);
    ui.elements.result.appendChild(card);
    const query = ui.context.document.querySelectorAll;
    ui.context.document.querySelectorAll = selector => selector === "#result .play-song-btn" ? [button] : query(selector);
    ui.context.playSong = () => pending.promise; ui.evaluate("isPlayingAll = true");
    const first = ui.context.playNextSong(0);
    ui.context.withdrawPrivacyAcceptance(); assert.equal(ui.evaluate("playlistTimer"), null);
    await ui.agree(); ui.evaluate("isPlayingAll = true; playlistTimer = setTimeout(() => {}, 30000)");
    const newTimer = ui.evaluate("playlistTimer"); pending.resolve(); await first;
    assert.equal(ui.evaluate("playlistTimer"), newTimer); assert.equal(ui.timers.size, 1);
    assert.equal(ui.calls.length, 0);
});

test("withdrawn consent blocks even a cached preview until renewed explicit agreement", async () => {
    const ui = existingContent({}, { fetch: async () => previewResponse() });
    assert.equal((await ui.context.lookupYouTubePreview(song.song, song.artist, [])).status, 200);
    assert.equal(ui.calls.length, 1); ui.context.withdrawPrivacyAcceptance();
    assert.equal((await ui.context.lookupYouTubePreview(song.song, song.artist, [])).status, 403);
    assert.equal(ui.calls.length, 1); ui.context.cancelPrivacyAgreement(); await ui.agree();
    const cached = await ui.context.lookupYouTubePreview(song.song, song.artist, []);
    assert.equal(cached.status, 200); assert.equal(cached.data.cacheSource, "browser_candidates"); assert.equal(ui.calls.length, 1);
});
