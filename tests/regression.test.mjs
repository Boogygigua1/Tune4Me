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
        inclusionRequested: false,
        unavailableRequestedSongs: [],
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

const complementaryRecordings = Array.from({ length: 10 }, (_, index) => ({
    song: `Synthetic Complement ${index + 1}`, artist: `Complementary Artist ${index + 1}`
}));

function assertCohesiveCuratorRequest(mood) {
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(detailRequests.length, 0);
    const sent = JSON.parse(requests[0][1].body);
    const instructions = sent.messages[0].content;
    assert.match(instructions, /emotional resonance/);
    assert.match(instructions, /vocal expression and emotional intensity/);
    assert.match(instructions, /atmosphere, instrumentation and rhythm/);
    assert.match(instructions, /blues, soul, folk, rock and other influences/);
    assert.match(instructions, /other artists by default/);
    assert.match(instructions, /explicit single-artist or genre-only constraint/);
    assert.match(instructions, /illustrative connections, not a fixed artist roster/);
    assert.match(instructions, /desired intensity rather than automatically escalating it/);
    assert.match(instructions, /Do not automatically turn sadness into empowerment/);
    assert.equal(sent.model, "gpt-4o-mini");
    assert.equal(sent.max_completion_tokens, 3072);
    const context = JSON.parse(sent.messages[1].content);
    assert.equal(context.mood, mood);
    assert.equal(context.length, 10);
    return context;
}

test("an explicit Lose Control request anchors a ten-song cross-artist emotional playlist", async () => {
    const mood = 'Please include "Lose Control" by Teddy Swims. I feel longing and passion, but I am not ready for a hopeful ending.';
    const explanation = "The selections share yearning, expressive vocals and a spacious atmosphere without pushing toward resolution.";
    aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
    assert.equal(new Set(result.body.playlist.songs.map(item => item.artist)).size, 10);
    assert.equal(result.body.playlist.explanation, explanation);
    assert.deepEqual(assertCohesiveCuratorRequest(mood).requiredSongs, [anchor]);
});

test("a Big Mama Thornton artist reference can preserve emotionally connected Janis Joplin and Etta James selections", async () => {
    const mood = "I'd like Big Mama Thornton, with raw, passionate singing and songs that feel emotionally connected.";
    // Synthetic recordings test routing/preservation, not real catalog or audio analysis.
    const songs = [
        { song: "Synthetic Blues Vocal", artist: "Big Mama Thornton" },
        { song: "Synthetic Passionate Vocal", artist: "Janis Joplin" },
        { song: "Synthetic Soul Vocal", artist: "Etta James" },
        ...complementaryRecordings.slice(0, 7)
    ];
    aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, songs);
    const context = assertCohesiveCuratorRequest(mood);
    assert.equal(context.requiredSongs, undefined);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

test("cohesion guidance does not override an explicit single-artist request", async () => {
    const mood = "Make this a Teddy Swims-only playlist about yearning, with no other artists.";
    const songs = complementaryRecordings.map(item => ({ ...item, artist: "Teddy Swims" }));
    aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, songs);
    assertCohesiveCuratorRequest(mood);
});

test("cross-genre bridges remain optional when the listener explicitly restricts genre", async () => {
    const mood = "Only blues, please. I want music that understands heartbreak without trying to cheer me up.";
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, complementaryRecordings);
    assertCohesiveCuratorRequest(mood);
});

test("cohesion keeps mixed feelings and desired intensity intact rather than imposing an emotional progression", async () => {
    const mood = "I miss someone and feel relieved they left. I want tenderness, a steady rhythm and company in both feelings, not catharsis or a hopeful ending.";
    const explanation = "These selections leave room for tenderness, longing and relief together, without demanding a change of feeling.";
    aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
    const result = await invoke(getPlaylist, { mood, likedSongs: [other], avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.explanation, explanation);
    const context = assertCohesiveCuratorRequest(mood);
    assert.deepEqual(context.likedSongs, [other]);
    assert.deepEqual(context.avoidSongs, [anchor]);
});

test("an emotional taste reference guides complementary artists without making the original mandatory", async () => {
    const mood = "I love Lose Control by Teddy Swims because its yearning vocal captures my mood. Find me emotionally connected music by other artists.";
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, complementaryRecordings);
    const context = assertCohesiveCuratorRequest(mood);
    assert.deepEqual(context.requiredSongs, []);
    assert.deepEqual(context.tasteSongs, [anchor]);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

for (const mood of [
    '"Lose Control" by Teddy Swims',
    "Please find Lose Control by Teddy Swims",
    "Lose Control by Teddy Swims because I miss my ex"
]) {
    test(`exact song reference uses canonical fields, not surrounding prose: ${mood}`, async () => {
        // Canonical model anchors and independently parsed omission recovery are both tested.
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

const recommendations = Array.from({ length: 10 }, (_, index) => ({
    song: `Synthetic Recommendation ${index + 1}`, artist: `Synthetic Artist ${index + 1}`
}));

const naturalSongRequest = "Play Lose Control by Teddy Swims and recommend other songs that capture the same passion, vulnerability, longing, and soulful intensity. Include artists whose music evokes similar emotions, even across different genres.";

for (const mood of [
    "Play Lose Control by Teddy Swims",
    "play Lose Control by Teddy Swims",
    "Please play Lose Control by Teddy Swims",
    'Play "Lose Control" by Teddy Swims'
]) {
    for (const disliked of [false, true]) {
        test(`short explicit request survives model omission and historical feedback (${disliked}): ${mood}`, async () => {
            aiReply(playlistFixture({ songs: recommendations }));
            const body = { mood, avoidSongs: disliked ? [anchor] : [] };
            const before = JSON.stringify(body);
            const result = await invoke(getPlaylist, body);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
            assert.equal(result.body.playlist.requestNotice, undefined);
            const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
            assert.deepEqual(context.requiredSongs, [anchor]);
            assert.deepEqual(context.avoidSongs, []);
            assert.equal(JSON.stringify(body), before);
            assert.equal(requests.length, 1);
            assert.equal(detailRequests.length, 0);
        });
    }
}

for (const mood of [
    "Play It Again by Luke Bryan",
    "play It Again by Luke Bryan",
    'Play "Play It Again" by Luke Bryan',
    "Play Play It Again by Luke Bryan"
]) test(`short Play commands preserve a real command-like full title: ${mood}`, async () => {
    const full = { song: "Play It Again", artist: "Luke Bryan" };
    const shortened = { song: "It Again", artist: "Luke Bryan" };
    aiReply(playlistFixture({ requestedSongs: [full, shortened], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, avoidSongs: [full] });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.songs[0].song.toLowerCase(), full.song.toLowerCase());
    assert.equal(result.body.playlist.songs[0].artist, full.artist);
    assert.deepEqual(result.body.playlist.songs.slice(1), recommendations.slice(0, 9));
    assert.equal(requests.length, 1);
});

test("an unresolved short command-like title is not shortened or silently satisfied", async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play It Again by Luke Bryan" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
    assert.equal(requests.length, 1);
});

test("informal misspellings use the same curator's canonical identity without fuzzy video matching", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], inclusionRequested: true, songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play loose control by Teddy Swim", avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.mood, "Play loose control by Teddy Swim");
    assert.ok(!context.requiredSongs?.length);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

for (const fields of [{}, { unavailableRequestedSongs: [anchor] }]) {
    test(`unresolved informal spelling receives a limitation without inventing a recording: ${Object.keys(fields)}`, async () => {
        aiReply(playlistFixture({ songs: recommendations, ...fields }));
        const result = await invoke(getPlaylist, { mood: "Play loose control by Teddy Swim" });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, recommendations);
        assert.match(result.body.playlist.requestNotice, /couldn't/);
        assert.equal(result.body.playlist.intro, result.body.playlist.requestNotice);
        assert.match(result.body.choices[0].message.content, /alternative recommendations/);
        assert.equal(requests.length, 1);
        assert.equal(detailRequests.length, 0);
    });
}

for (const suffix of [
    ". Actually, don't play Lose Control.",
    ". Do not include any songs by Teddy Swims.",
    ". Only recommend similar songs."
]) test(`short Play recovery cannot override a current exclusion: ${suffix}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play Lose Control by Teddy Swims" + suffix, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
    assert.equal(requests.length, 1);
});

test("a canonical correction of informal spelling still respects current artist exclusions", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play loose control by Teddy Swim. Do not include any songs by Teddy Swims." });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /current exclusions/);
    assert.equal(requests.length, 1);
});

test("an unavailable short explicit request is explained rather than recovered", async () => {
    aiReply(playlistFixture({ unavailableRequestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play Lose Control by Teddy Swims", avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /recording-availability constraints/);
    assert.equal(requests.length, 1);
});

for (const [song, artist, shortened] of [
    ["Play It Again", "Luke Bryan", "It Again"],
    ["Listen to Your Heart", "Roxette", "Your Heart"],
    ["Find Your Love", "Drake", "Your Love"]
]) {
    const full = { song, artist };
    const wrong = { song: shortened, artist };
    for (const form of ["unquoted", "quoted", "outer command"]) {
        test(`full command-like identity wins over a conflicting model/parser identity: ${song}, ${form}`, async () => {
            const reference = form === "quoted" ? `Play "${song}" by ${artist}`
                : form === "outer command" ? `Please play ${song} by ${artist}` : `${song} by ${artist}`;
            aiReply(playlistFixture({ requestedSongs: form === "unquoted" ? [full, wrong] : [wrong], songs: recommendations }));
            const result = await invoke(getPlaylist, { mood: reference + " and recommend other songs with the same longing.", avoidSongs: [full] });
            assert.equal(result.status, 200);
            assert.deepEqual(result.body.playlist.songs, [full, ...recommendations.slice(0, 9)]);
            assert.equal(result.body.playlist.songs.some(item => item.song === shortened && item.artist === artist), false);
            assert.equal(requests.length, 1);
            assert.equal(detailRequests.length, 0);
        });
    }
    test(`a full title selected by the curator is not accompanied by its shortened duplicate: ${song}`, async () => {
        aiReply(playlistFixture({ songs: [full, ...recommendations.slice(0, 9)] }));
        const result = await invoke(getPlaylist, { mood: `${song} by ${artist} and recommend other songs with similar yearning.` });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [full, ...recommendations.slice(0, 9)]);
        assert.equal(requests.length, 1);
    });
    test(`unavailable full command-like titles cannot recover through a shortened identity: ${song}`, async () => {
        aiReply(playlistFixture({ unavailableRequestedSongs: [full], songs: recommendations }));
        const result = await invoke(getPlaylist, { mood: `${song} by ${artist} and recommend other songs with similar yearning.` });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, recommendations);
        assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
        assert.equal(requests.length, 1);
    });
    test(`an unresolved unquoted command-like title receives a limitation rather than a shortened recording: ${song}`, async () => {
        aiReply(playlistFixture({ songs: recommendations }));
        const result = await invoke(getPlaylist, { mood: `${song} by ${artist} and recommend other songs with the same longing.` });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, recommendations);
        assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.ok(!context.requiredSongs?.length);
        assert.ok(context.ambiguousSongTitles.some(item => item.full.song === song && item.full.artist === artist));
        assert.equal(requests.length, 1);
    });
    test(`quoting the full command-like title permits independent recovery without model metadata: ${song}`, async () => {
        aiReply(playlistFixture({ songs: recommendations }));
        const result = await invoke(getPlaylist, { mood: `Please play "${song}" by ${artist} and recommend other songs with the same longing.` });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [full, ...recommendations.slice(0, 9)]);
        assert.equal(requests.length, 1);
    });
}

test("title conflict resolution never substitutes a different artist's recording", async () => {
    const full = { song: "Play It Again", artist: "Luke Bryan" };
    const unrelated = { song: "It Again", artist: "Synthetic Different Artist" };
    aiReply(playlistFixture({ requestedSongs: [full], songs: [unrelated, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: "Play It Again by Luke Bryan and recommend other songs with the same longing." });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs.slice(0, 2), [full, unrelated]);
    assert.equal(result.body.playlist.songs.length, 10);
});

for (const [mood, requested] of [
    ["Please play The Night We Met by Lord Huron.", { song: "The Night We Met", artist: "Lord Huron" }],
    ["Please play The Door by Teddy Swims.", { song: "The Door", artist: "Teddy Swims" }],
    ["Please play the song The Night We Met by Lord Huron.", { song: "The Night We Met", artist: "Lord Huron" }]
]) test(`command parsing preserves an article belonging to the title: ${mood}`, async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, avoidSongs: [requested] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [requested, ...recommendations.slice(0, 9)]);
    assert.equal(requests.length, 1);
});

for (const mood of [
    "Play the song Lose Control by Teddy Swims and recommend other songs with similar longing.",
    "Please find me the track Lose Control by Teddy Swims and recommend other songs with similar longing."
]) test(`an explicit song/track marker is not interpreted as part of an alternative title: ${mood}`, async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.ambiguousSongTitles, undefined);
    assert.equal(requests.length, 1);
});

test("full-title resolution preserves continuation exclusions and explains the non-repetition", async () => {
    const full = { song: "Play It Again", artist: "Luke Bryan" };
    aiReply(playlistFixture({ requestedSongs: [full], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Play It Again by Luke Bryan and recommend other songs with similar longing.", existingSongs: [full] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /already in your playlist/);
    assert.equal(requests.length, 1);
});

test("ordinary emotional absence does not become a title-only music exclusion", async () => {
    const hopeful = { song: "Hope", artist: "Synthetic Artist" };
    aiReply(playlistFixture({ songs: [hopeful, ...recommendations.slice(0, 9)] }));
    const mood = "Tonight I have no hope. I want gentle company in that feeling.";
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [hopeful, ...recommendations.slice(0, 9)]);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.mood, mood);
    assert.equal(context.requiredSongs, undefined);
    assert.equal(requests.length, 1);
});

for (const correction of [
    "Actually, don't play Lose Control.",
    'Actually, do not include "Lose Control".',
    "Actually, don’t recommend ‘Lose Control’.",
    "Do not include any songs by Teddy Swims.",
    'Exclude all tracks by "Teddy Swims".',
    "Don't play music from Teddy Swims.",
    "No songs by Teddy Swims.",
    "Avoid Teddy Swims.",
    "Do not play the song Lose Control by Teddy Swims."
]) test(`current corrections block recovery despite conflicting model inclusion: ${correction}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const mood = naturalSongRequest + " " + correction;
    const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.mood, mood);
    assert.deepEqual(context.requiredSongs, []);
    assert.deepEqual(context.excludedSongs, [anchor]);
    assert.deepEqual(context.avoidSongs, [anchor]);
    assert.match(result.body.playlist.requestNotice, /alternative recommendations/);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

test("a title-only correction overrides recovery even when the curator omits all inclusion metadata", async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Please play Lose Control by Teddy Swims. Actually, don't play Lose Control." });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.equal(requests.length, 1);
});

for (const correction of [
    "Don't play Lose Control Again.",
    "Don't play Lose Control by Another Artist.",
    "Do not include any songs by Teddy Swims Junior.",
    "Don't exclude Lose Control by Teddy Swims.",
    "Do not avoid Teddy Swims."
]) test(`current exclusions retain exact identity and do not reverse double negation: ${correction}`, async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: naturalSongRequest + " " + correction, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(requests.length, 1);
});

for (const [artist, excludedArtist] of [["Nothing", "Nothing But Thieves"], ["Simon", "Simon and Garfunkel"]]) {
    test(`artist-wide exclusion does not match a shorter artist prefix: ${excludedArtist}`, async () => {
        const requested = { song: "Synthetic Requested Song", artist };
        aiReply(playlistFixture({ songs: recommendations }));
        const result = await invoke(getPlaylist, { mood: `Please include "${requested.song}" by "${artist}". Do not include any songs by ${excludedArtist}.` });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [requested, ...recommendations.slice(0, 9)]);
        assert.equal(requests.length, 1);
    });
}

test("artist-wide exclusions cover model-only recommendations and fail closed rather than returning forbidden songs", async () => {
    const forbidden = { song: "Synthetic Different Track", artist: "Teddy Swims" };
    aiReply(playlistFixture({ songs: [forbidden, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: "I feel hopeful and heartbroken. Do not include any songs by Teddy Swims." });
    assert.equal(result.status, 502);
    assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

test("artist exclusions still leave room to recover another eligible requested song", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor, other], songs: [{ song: "Synthetic Different Track", artist: "Teddy Swims" }, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele. Actually, do not include any songs by Teddy Swims.' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [other, ...recommendations.slice(0, 9)]);
    assert.equal(requests.length, 1);
});

for (const [title, status] of [["C++", 502], ["C++++", 200]]) test(`exclusion targets are literal names rather than regex patterns: ${title}`, async () => {
    const candidate = { song: "C++", artist: "Artist (Test)" };
    aiReply(playlistFixture({ songs: [candidate, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: `I feel reflective. Don't play "${title}" by "Artist (Test)".` });
    assert.equal(result.status, status);
    if (status === 200) assert.deepEqual(result.body.playlist.songs[0], candidate);
    else assert.equal(result.body.playlist, undefined);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

for (const mood of [
    naturalSongRequest,
    "I'm feeling exposed tonight. Play Lose Control by Teddy Swims and recommend other songs that understand that vulnerability.",
    "I miss someone; could you Play Lose Control by Teddy Swims and recommend more music with that yearning?",
    "Please play Lose Control by Teddy Swims and suggest other songs with soulful vocals.",
    "I've had a difficult evening. Can you play Lose Control by Teddy Swims and suggest some music that lets me sit with my feelings?",
    "I'm hopeful and heartbroken. I want you to include Lose Control by Teddy Swims because I want room for both feelings.",
    "I'm exhausted tonight. Include Lose Control by Teddy Swims and find me other songs with the same longing."
]) test(`natural-language explicit inclusion is independently recovered: ${mood}`, async () => {
    // The provider supplies neither the anchor nor inclusion metadata: recovery must be local.
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(result.body.playlist.requestNotice, undefined);
    const sent = JSON.parse(requests[0][1].body);
    const context = JSON.parse(sent.messages[1].content);
    assert.equal(context.mood, mood);
    assert.deepEqual(context.requiredSongs, [anchor]);
    assert.deepEqual(context.avoidSongs, []);
    assert.equal(result.body.playlist.explanation, playlistFixture().explanation);
    assert.equal(requests.length, 1);
    assert.match(requests[0][0], /^https:\/\/api\.openai\.com\//);
    assert.equal(detailRequests.length, 0);
});

for (const [label, mood, options, excluded] of [
    ["taste example", "I love Lose Control by Teddy Swims and recommend other songs with similar longing.", {}, false],
    ["similar-only", "Only recommend similar songs to Lose Control by Teddy Swims and suggest other songs with soulful intensity.", {}, true],
    ["explicit negative command", "Don't play Lose Control by Teddy Swims and recommend other songs with that intensity.", {}, true],
    ["later current exclusion", naturalSongRequest + " Do not play Lose Control by Teddy Swims.", {}, true],
    ["referential exclusion", naturalSongRequest + " But don't play this song.", {}, true],
    ["later similar-only constraint", naturalSongRequest + " Only recommend similar songs.", {}, true],
    ["continuation exclusion", naturalSongRequest, { existingSongs: [anchor] }, false]
]) test(`follow-on music wording preserves ${label}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, ...options });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.ok(!context.requiredSongs?.length);
    if (label === "taste example") assert.deepEqual(context.tasteSongs, [anchor]);
    if (excluded) assert.deepEqual(context.excludedSongs, [anchor]);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

for (const mood of [
    "I feel overwhelmed by everyone and recommend other songs to my friends, but I need comforting music tonight.",
    "I'm standing by My Friend and recommend other songs when we talk; I'm lonely now.",
    "Play music by Teddy Swims and recommend other songs with that intensity."
]) test(`follow-on wording does not turn ordinary prose or artist preferences into songs: ${mood}`, async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.ok(!context.requiredSongs?.length);
    assert.equal(requests.length, 1);
});

test("follow-on music wording preserves a quoted command-like title and an artist containing But", async () => {
    const requested = { song: "Play Dead", artist: "Nothing But Thieves" };
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'Play "Play Dead" by Nothing But Thieves and recommend other songs with a similar atmosphere.' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], requested);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, [requested]);
    assert.equal(requests.length, 1);
});

for (const title of ["Play Dead", "Find Me", "I Love You"]) test(`follow-on wording leaves a short ambiguous title with the curator: ${title}`, async () => {
    const requested = { song: title, artist: "Fixture Artist" };
    aiReply(playlistFixture({ requestedSongs: [requested], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: `${title} by Fixture Artist and recommend other songs with similar longing.` });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], requested);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.ok(!context.requiredSongs?.length);
    assert.equal(requests.length, 1);
});

for (const mood of [
    "Lose Control by Teddy Swims",
    "Lose Control by Teddy Swims.",
    '"Lose Control" by Teddy Swims',
    'Please find "Lose Control" by Teddy Swims because I miss my ex',
    "Please play Lose Control by Teddy Swims",
    "Lose Control by Teddy Swims\nI'm feeling overwhelmed, and I want comforting music without a forced happy ending.",
    "I feel overwhelmed and relieved. Please include Lose Control by Teddy Swims because I want company in both feelings."
]) test(`an explicit song omitted by the model is recovered without another request: ${mood}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
    const sent = JSON.parse(requests[0][1].body);
    const context = JSON.parse(sent.messages[1].content);
    assert.equal(context.mood, mood);
    assert.equal(context.length, 10);
    assert.deepEqual(context.requiredSongs, [anchor]);
    assert.deepEqual(context.excludedSongs, []);
    assert.equal(result.body.playlist.intro, playlistFixture().intro);
    assert.equal(result.body.playlist.explanation, playlistFixture().explanation);
});

test("a current explicit inclusion overrides only its own historical dislike without changing stored feedback", async () => {
    aiReply(playlistFixture({ requestedSongs: [], songs: recommendations }));
    const body = { mood: "Lose Control by Teddy Swims", avoidSongs: [anchor, other], likedSongs: [other] };
    const before = JSON.stringify(body);
    const result = await invoke(getPlaylist, body);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(JSON.stringify(body), before);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.avoidSongs, [other]);
    assert.deepEqual(context.likedSongs, [other]);
    assert.equal(requests.length, 1);
});

test("a semantically identified model anchor also overrides its historical dislike", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Please include that Teddy Swims song about losing control", avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(requests.length, 1);
});

test("omitted one-song requests are recovered without increasing the requested count", async () => {
    aiReply(playlistFixture({ requestedSongs: [], songs: [other] }));
    const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims", length: 1, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor]);
    assert.equal(requests.length, 1);
});

test("an anchor already present is deduplicated without changing the ten-song count", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: [anchor, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims", avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    assert.equal(result.body.playlist.songs.filter(item => item.song === anchor.song).length, 1);
    assert.equal(requests.length, 1);
});

test("a current exclusion wins over a conflicting inclusion of the same reference", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Don't play Lose Control by Teddy Swims; include Lose Control by Teddy Swims" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
});

test("multiple explicit requests can satisfy a one-song playlist with one requested song", async () => {
    aiReply(playlistFixture({ songs: [recommendations[0]] }));
    const result = await invoke(getPlaylist, {
        mood: 'Play "Lose Control" by "Teddy Swims" and include "Someone Like You" by "Adele"', length: 1
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor]);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
});

test("continuation exclusions still win over explicit inclusion and historical feedback", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, {
        mood: "Lose Control by Teddy Swims", existingSongs: [anchor], avoidSongs: [anchor]
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.equal(requests.length, 1);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.ok(!context.requiredSongs?.length);
    assert.deepEqual(context.existingSongs, [anchor]);
});

for (const mood of [
    "Don't play Lose Control by Teddy Swims",
    'Do not include "Lose Control" by Teddy Swims',
    "Never play Lose Control by Teddy Swims",
    "Exclude Lose Control by Teddy Swims",
    "Only recommend similar songs to Lose Control by Teddy Swims",
    "Songs like Lose Control by Teddy Swims",
    "Recommend songs similar to Lose Control by Teddy Swims",
    'I love "Lose Control" by Teddy Swims because I feel overwhelmed. Only recommend similar songs.',
    "Please play Lose Control by Teddy Swims, but don't play this song",
    "Lose Control by Teddy Swims, but don't include it"
]) test(`current exclusion wins even when the model tries to include the anchor: ${mood}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.excludedSongs, [anchor]);
    assert.deepEqual(context.requiredSongs, []);
    assert.equal(requests.length, 1);
});

test("excluding a different named song does not veto the requested anchor", async () => {
    aiReply(playlistFixture({ requestedSongs: [], songs: recommendations }));
    const mood = 'Play "Lose Control" by Teddy Swims, but do not include "Someone Like You" by Adele';
    const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, [anchor]);
    assert.deepEqual(context.excludedSongs, [other]);
});

for (const mood of [
    "I feel judged by everyone.",
    "I Feel Judged by Everyone",
    "I feel abandoned by My Friends, and I don't want advice.",
    'I feel "judged" by everyone.',
    "Please find comfort by spending time with friends.",
    "I need music to play in the background while I feel supported by my family."
]) test(`ordinary emotional prose does not create a required or excluded song: ${mood}`, async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.requiredSongs, undefined);
    assert.equal(context.excludedSongs, undefined);
    assert.equal(context.mood, mood);
});

for (const mood of ["Songs by Teddy Swims", "Find songs by Teddy Swims", "Music by Teddy Swims", "More Songs by Teddy Swims"]) {
    test(`artist-only preferences do not invent a song: ${mood}`, async () => {
        aiReply(playlistFixture({ songs: recommendations }));
        const result = await invoke(getPlaylist, { mood });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, recommendations);
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.equal(context.requiredSongs, undefined);
        assert.equal(context.excludedSongs, undefined);
    });
}

test("ambiguous double-negation stays with the curator instead of reversing an inclusion", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Don't exclude Lose Control by Teddy Swims", avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
});

test("artist words are not truncated into another recording identity", async () => {
    const requested = { song: "A Test Song", artist: "Nothing But Thieves" };
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "A Test Song by Nothing But Thieves" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], requested);
});

test("an artist initialism retains its meaningful punctuation", async () => {
    const requested = { song: "A Test Song", artist: "R.E.M." };
    aiReply(playlistFixture({ requestedSongs: [requested], songs: [other] }));
    const result = await invoke(getPlaylist, { mood: "A Test Song by R.E.M.", length: 1 });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [requested]);
});

for (const title of ["Play Dead", "Find Me", "I Love You"]) test(`an ambiguous command-like title is never shortened: ${title}`, async () => {
    const requested = { song: title, artist: "Fixture Artist" };
    aiReply(playlistFixture({ requestedSongs: [requested], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: `${title} by Fixture Artist`, avoidSongs: [requested] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], requested);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.equal(context.requiredSongs, undefined);
});

test("quoting a command-like title allows safe omission recovery with its full identity", async () => {
    const requested = { song: "Play Dead", artist: "Fixture Artist" };
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'Please play "Play Dead" by Fixture Artist' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], requested);
});

test("invalid or truncated model output cannot use anchor recovery to bypass response validation or retry", async () => {
    aiReply(playlistFixture({ songs: recommendations }), { finish_reason: "length" });
    const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims" });
    assert.equal(result.status, 502);
    assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined);
    assert.equal(requests.length, 1);
});

test("a shared explicit inclusion cue recovers multiple requested songs and preserves emotional recommendations", async () => {
    const mood = "Please include Lose Control by Teddy Swims and Someone Like You by Adele because I feel overwhelmed and hopeful.";
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor, other] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, other, ...recommendations.slice(0, 8)]);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, [anchor, other]);
    assert.deepEqual(context.avoidSongs, []);
    assert.equal(context.mood, mood);
    assert.equal(result.body.playlist.explanation, playlistFixture().explanation);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
});

test("many explicit requests require at least one rather than displacing all ten emotional recommendations", async () => {
    const requested = Array.from({ length: 12 }, (_, i) => ({ song: `Requested Track ${i + 1}`, artist: `Requested Artist ${i + 1}` }));
    const mood = "Please include " + requested.map(item => `"${item.song}" by "${item.artist}"`).join(" and ");
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [...requested.slice(0, 5), ...recommendations.slice(0, 5)]);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
});

test("one requested song selected by the curator can satisfy a multiple-song request", async () => {
    aiReply(playlistFixture({ songs: [other] }));
    const result = await invoke(getPlaylist, {
        mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele', length: 1
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [other]);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

for (const mood of [
    "I love Lose Control by Teddy Swims because it captures how overwhelmed I've been feeling. Find me more songs that understand that feeling.",
    'I like "Lose Control" by Teddy Swims because I feel lonely.',
    'For example, "Lose Control" by Teddy Swims',
    'Such as "Lose Control" by Teddy Swims'
]) test(`taste references are not mandatory inclusions, even when the model mislabels the reference: ${mood}`, async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.equal(result.body.playlist.requestNotice, undefined);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []);
    assert.deepEqual(context.tasteSongs, [anchor]);
    assert.deepEqual(context.avoidSongs, [anchor]);
    assert.equal(requests.length, 1);
});

test("a shared list of taste examples does not become a list of required songs", async () => {
    const mood = 'For example, "Lose Control" by Teddy Swims and "Someone Like You" by Adele';
    aiReply(playlistFixture({ requestedSongs: [anchor, other], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.equal(result.body.playlist.requestNotice, undefined);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []);
    assert.deepEqual(context.tasteSongs, [anchor, other]);
});

test("taste examples may still appear naturally when the curator selects them", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: [anchor, ...recommendations.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: 'I enjoy "Lose Control" by Teddy Swims' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

test("explicitly asking to include a taste example promotes that reference to an inclusion", async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'I love "Lose Control" by Teddy Swims. Please include it.', avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

test("mixed inclusion, taste and similar-only references have separate roles", async () => {
    const excluded = { song: "Youth", artist: "Daughter" };
    const mood = 'Please include "Lose Control" by Teddy Swims. I like "Someone Like You" by Adele. Only recommend similar songs to "Youth" by Daughter.';
    aiReply(playlistFixture({ requestedSongs: [anchor, other, excluded], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...recommendations.slice(0, 9)]);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, [anchor]);
    assert.deepEqual(context.tasteSongs, [other]);
    assert.deepEqual(context.excludedSongs, [excluded]);
});

test("a remaining eligible explicit request satisfies the request when another recording cannot be recommended", async () => {
    aiReply(playlistFixture({ inclusionRequested: true, unavailableRequestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, {
        mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele', avoidSongs: [other]
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [other, ...recommendations.slice(0, 9)]);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
});

test("excluding one of several requested songs still includes another eligible request", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor, other], songs: recommendations }));
    const result = await invoke(getPlaylist, {
        mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele. Do not play "Lose Control" by Teddy Swims.'
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [other, ...recommendations.slice(0, 9)]);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(requests.length, 1);
});

test("when no requested recording can be recommended, an explicit alternative notice replaces any success claim", async () => {
    aiReply(playlistFixture({ intro: "Every requested song is included.", inclusionRequested: true,
        unavailableRequestedSongs: [anchor, other], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /couldn't include any requested song/);
    assert.equal(result.body.playlist.intro, result.body.playlist.requestNotice);
    assert.doesNotMatch(result.body.choices[0].message.content, /Every requested song is included/);
    assert.match(result.body.choices[0].message.content, /alternative recommendations/);
    assert.equal(requests.length, 1);
});

test("unidentified explicit inclusion receives an explanatory alternative rather than silent satisfaction", async () => {
    aiReply(playlistFixture({ inclusionRequested: true, songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Please include the song from that film; I cannot remember its title or artist." });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /couldn't confidently identify/);
    assert.equal(requests.length, 1);
});

test("continuation explains why none of the already-present requested songs were added again", async () => {
    aiReply(playlistFixture({ inclusionRequested: true, requestedSongs: [anchor, other], songs: recommendations }));
    const result = await invoke(getPlaylist, {
        mood: 'Please include "Lose Control" by Teddy Swims and "Someone Like You" by Adele', existingSongs: [anchor, other]
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /already in your playlist/);
});

test("current exclusions explain an unsatisfied inclusion without playing an excluded song", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'Please include "Lose Control" by Teddy Swims, but do not play this song.' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.match(result.body.playlist.requestNotice, /current exclusions/);
});

test("similar-only requests do not incorrectly announce an unsatisfied inclusion", async () => {
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: 'Only recommend similar songs to "Lose Control" by Teddy Swims' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, recommendations);
    assert.equal(result.body.playlist.requestNotice, undefined);
});

test("recording availability metadata cannot veto another artist's same-title request", async () => {
    aiReply(playlistFixture({ unavailableRequestedSongs: [{ song: "Lose Control", artist: "Another Artist" }], songs: recommendations }));
    const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
});

for (const fields of [{ inclusionRequested: "yes" }, { unavailableRequestedSongs: [{ song: "Bad", artist: "" }] }]) {
    test("invalid inclusion metadata fails closed without a second provider call: " + Object.keys(fields)[0], async () => {
        aiReply(playlistFixture({ songs: recommendations, ...fields }));
        const result = await invoke(getPlaylist, { mood: "Lose Control by Teddy Swims" });
        assert.equal(result.status, 502);
        assert.equal(result.body.reason, "invalid_playlist_response");
        assert.equal(requests.length, 1);
    });
}

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

test("the real homepage default remains ten songs when recovering an omitted, historically disliked anchor", async () => {
    aiReply(playlistFixture({ songs: recommendations }));
    const ui = frontend();
    ui.elements.moodInput.value = "Lose Control by Teddy Swims";
    ui.storage.set("avoidSongs", JSON.stringify([anchor]));
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getPlaylist");
        const body = JSON.parse(options.body);
        assert.equal(body.length, undefined); // Use the real default; do not replace it with a fixture length.
        const result = await invoke(getPlaylist, body);
        return response(result.body, result.status);
    };
    await ui.context.showMood();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.context.currentPlaylist)), [anchor, ...recommendations.slice(0, 9)]);
    assert.equal(ui.storage.get("avoidSongs"), JSON.stringify([anchor]));
    assert.ok(ui.events.includes("playlist_generated"));
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(JSON.parse(requests[0][1].body).messages[1].content).length, 10);
});

test("the homepage visibly explains an alternative when no requested recording can be included", async () => {
    aiReply(playlistFixture({ inclusionRequested: true, unavailableRequestedSongs: [anchor], songs: recommendations }));
    const ui = frontend();
    ui.elements.moodInput.value = "Lose Control by Teddy Swims";
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getPlaylist");
        const result = await invoke(getPlaylist, JSON.parse(options.body));
        return response(result.body, result.status);
    };
    await ui.context.showMood();
    assert.match(textOf(ui.elements.result), /couldn't include any requested song/);
    assert.match(textOf(ui.elements.result), /alternative recommendations/);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.context.currentPlaylist)), recommendations);
    assert.equal(requests.length, 1);
});

test("continuation exposes the request limitation in an accessible status notice", async () => {
    aiReply(playlistFixture({ inclusionRequested: true, requestedSongs: [anchor], songs: recommendations }));
    const ui = frontend();
    ui.elements.moodInput.value = "Lose Control by Teddy Swims";
    ui.context.currentPlaylist = [anchor];
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getPlaylist");
        const result = await invoke(getPlaylist, JSON.parse(options.body));
        return response(result.body, result.status);
    };
    await ui.context.continuePlaylist();
    const notice = ui.elements.result.children.find(element => element.attributes.role === "status");
    assert.ok(notice);
    assert.match(notice.textContent, /already in your playlist/);
    assert.match(notice.textContent, /alternative recommendations/);
    assert.equal(ui.context.currentPlaylist.length, 11);
    assert.equal(requests.length, 1);
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
