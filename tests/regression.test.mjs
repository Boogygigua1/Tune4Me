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
        status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed", madeForKids: false },
        contentDetails: { duration: "PT3M",}
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
        explanation: explanationConnections(),
        ...overrides
    };
}

function explanationConnections(songIndex = 0, emotionalTheme = "longing", musicalTrait = "expressive vocals") {
    return { connections: [{ songIndex, emotionalTheme, musicalTrait }] };
}

function connectionText(item, emotionalTheme = "longing", musicalTrait = "expressive vocals") {
    return `${JSON.stringify(item.song)} by ${item.artist} offers a connection through ${emotionalTheme} and ${musicalTrait}.`;
}

function aiReply(playlist = playlistFixture(), overrides = {}) {
    fetchImpl = async (_url, options) => {
        const context = JSON.parse(JSON.parse(options.body).messages[1].content);
        // Fixtures follow the conditional response contract; explicit malformed fit data is never repaired.
        let result = context.musicalReferences && !Object.hasOwn(playlist, "musicalFit")
            ? { ...playlist, musicalFit: musicalFitFixture(playlist.songs, context.musicalReferences[0]) } : playlist;
        // Older ten-song scenarios receive four explicit reserve fixtures for the new contract.
        // Raw-response contract tests use fetchImpl directly; malformed data is never repaired.
        if (context.candidateCount === 14 && result.songs?.length === 10) {
            result = { ...result, songs: [...result.songs, ...reserveFixtures()] };
            if (result.musicalFit && Array.isArray(result.musicalFit.assessments)) {
                result.musicalFit = { ...result.musicalFit, assessments: [...result.musicalFit.assessments,
                    ...[10, 11, 12, 13].map(songIndex => ({ songIndex, kind: "close", judgments: result.musicalFit.priorities?.length === 3 ? ["match", "match", "uncertain"] : ["match", "match"] }))] };
            }
        }
        return response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) }, ...overrides }] });
    };
}

function musicalFitFixture(songs, reference = anchor) {
    return { reference, priorities: [{ dimension: "vocals", character: "powerful gritty vocals" },
        { dimension: "groove", character: "driving soulful groove" }],
        assessments: songs.map((_song, songIndex) => ({ songIndex, kind: "close", judgments: ["match", "match"] })) };
}

function fitConnectionText(item, theme = "longing") {
    return `${JSON.stringify(item.song)} by ${item.artist} may connect through ${theme} and similarities in vocal character, groove and rhythm (an unverified curator judgment).`;
}

function reserveFixtures() {
    return [{ song: "Reserve fixture one", artist: "Reserve performer one" }, { song: "Reserve fixture two", artist: "Reserve performer two" },
        { song: "Reserve fixture three", artist: "Reserve performer three" }, { song: "Reserve fixture four", artist: "Reserve performer four" }];
}

const musicalFitRequest = 'Play "Lose Control" by Teddy Swims and recommend songs with similar vocals, groove and musical energy.';
const musicalFitSongs = () => [anchor, ...Array.from({ length: 9 }, (_, i) => ({ song: `Fit fixture ${i}`, artist: `Fixture artist ${i}` }))];

function fourteenCandidateFixture() {
    const songs = [...musicalFitSongs(), ...reserveFixtures()];
    return playlistFixture({ songs, requestedSongs: [anchor], musicalFit: musicalFitFixture(songs) });
}

function realisticFourteenFixture(variant) {
    const titles = ["Reference Recording", "The Weight of Tomorrow", "When the Rain Comes Down", "Hold the Last Light",
        "River Between Us", "Every Broken Promise", "Stay Until Morning", "Somewhere Past Midnight",
        "A Song for the Leaving", "Turn Back the Tide", "Closer to the Fire", "Nothing Left Unspoken",
        "In Another Lifetime", "The Long Way Home"];
    const artists = ["Synthetic Artist", "The Lanterns", "Marin and the River", "Alex Vale", "The Midnight Choir",
        "Jules Mercer", "Rowan & Co.", "Elena West", "The Hollow Pines", "Sasha Reed", "Riverside Assembly",
        "Cameron Hale", "Lena Sol", "The Northern Lights"];
    const songs = titles.map((title, index) => index === 0 ? { ...anchor } : ({
        song: title + (variant === "representative" ? "" : " (Live at the Riverside Theatre)"),
        artist: artists[index] + (variant === "accented ensemble names" ? " — Ensemble Étoile" : "")
    }));
    return playlistFixture({ intro: "A cohesive set balances expressive vocals, a grounded groove and emotional intensity, with a few thoughtful discoveries.",
        requestedSongs: [anchor], inclusionRequested: true, songs,
        musicalFit: { reference: anchor, priorities: [
            { dimension: "vocals", character: "Expressive vocal character and dynamic delivery" },
            { dimension: "groove", character: "A grounded rhythmic pulse and complementary instrumental texture" },
            { dimension: "energy", character: "A gradual musical build with a reflective atmosphere" }
        ], assessments: songs.map((_item, songIndex) => ({ songIndex, kind: songIndex % 4 === 3 ? "discovery" : "close",
            judgments: songIndex % 4 === 3 ? ["match", "different", "uncertain"] : ["match", "match", "uncertain"] })) },
        explanation: { connections: [
            { songIndex: 0, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
            { songIndex: 8, emotionalTheme: "passion", musicalTrait: "dynamic build-up" },
            { songIndex: 13, emotionalTheme: "hope", musicalTrait: "groove and rhythm" }
        ] } });
}

const featuredSongRequest = "I love 'Lose Control' by Teddy Swims. Create a playlist featuring this song and nine other songs with similarly powerful, gritty vocals, soulful blues and R&B influences, passionate delivery, and driving musical energy. Prioritize musical similarity over shared emotions, while including a few thoughtful discoveries from other artists.";

function omittedFeaturedFixture(reference = anchor) {
    const playlist = fourteenCandidateFixture();
    playlist.songs[0] = { song: "Different recording", artist: reference.artist };
    playlist.requestedSongs = []; playlist.inclusionRequested = true;
    playlist.musicalFit.reference = reference;
    return playlist;
}

for (const [quote, title] of [["single", "'Lose Control'"], ["curly single", "‘Lose Control’"], ["double", '"Lose Control"'],
    ["curly double", "“Lose Control”"], ["unquoted", "Lose Control"]]) for (const modelIdentifies of [false, true]) {
    test(`featured recording: exact request preserves ${quote} identity with historical dislikes (model identifies: ${modelIdentifies})`, async () => {
        const mood = featuredSongRequest.replace("'Lose Control'", title), playlist = omittedFeaturedFixture();
        if (modelIdentifies) playlist.requestedSongs = [anchor];
        aiReply(playlist); const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor], recentSongs: [anchor] });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.deepEqual(result.body.playlist.songs[0], anchor); assert.equal(result.body.playlist.requestNotice, undefined);
        assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
        const sent = JSON.parse(requests[0][1].body), context = JSON.parse(sent.messages[1].content);
        assert.deepEqual(context.requiredSongs, [anchor]); assert.deepEqual(context.tasteSongs, []);
        assert.deepEqual(context.avoidSongs, []); assert.equal(context.recentSongs, undefined);
        assert.deepEqual(context.musicalReferences, [anchor]); assert.equal(context.length, 10); assert.equal(context.candidateCount, 14);
        assert.equal(sent.response_format.json_schema.schema.properties.songs.maxItems, 14);
        assert.equal(sent.max_completion_tokens, 3072); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const reference of [
    { song: "Don't Stop Believin'", artist: "Journey" },
    { song: "I'm on Fire", artist: "Bruce Springsteen" },
    { song: "I Can't Stand the Rain", artist: "Ann Peebles" },
    { song: "Nothin' But a Good Time", artist: "Poison" },
    { song: "Play It Again", artist: "Luke Bryan" },
    { song: "Listen to Your Heart", artist: "Roxette" },
    { song: "Find Me", artist: "Synthetic performer" },
    { song: "I Love You", artist: "Synthetic performer" }
]) test(`single-quoted recording: apostrophes and full command-like title remain intact (${reference.song})`, async () => {
    const playlist = omittedFeaturedFixture(reference);
    if (reference.song === "Play It Again") playlist.requestedSongs = [{ song: "It Again", artist: reference.artist }];
    if (reference.song === "Listen to Your Heart") playlist.requestedSongs = [{ song: "Your Heart", artist: reference.artist }];
    aiReply(playlist); const result = await invoke(getPlaylist, {
        mood: `Play '${reference.song}' by ${reference.artist} and recommend songs with similar sound.`, avoidSongs: [reference] });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs[0], reference);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, [reference]); assert.equal(context.candidateCount, 14);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

for (const command of ["Please create a playlist featuring this track.", "Make me a playlist including that song.",
    "Build the playlist containing the original.", "Create a playlist with this song."]) {
    test(`featured recording: bounded affirmative playlist command promotes one preceding reference (${command})`, async () => {
        aiReply(omittedFeaturedFixture()); const result = await invoke(getPlaylist, {
            mood: `I love 'Lose Control' by Teddy Swims. ${command} Recommend other songs with similar vocals and groove.` });
        assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], anchor);
        assert.deepEqual(JSON.parse(JSON.parse(requests[0][1].body).messages[1].content).requiredSongs, [anchor]);
    });
}

for (const command of ["Don't create a playlist featuring this song.", "Do not make a playlist including this song.",
    "Never build a playlist containing this track.", "Please don't create a playlist featuring this song.",
    "Do not please create a playlist featuring this song.", "I don't want to create a playlist featuring this song.",
    "Create a playlist not featuring this song.", "Create a playlist without this song."]) {
    test(`featured recording: negated playlist instruction cannot become an inclusion (${command})`, async () => {
        const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor]; aiReply(playlist);
        const result = await invoke(getPlaylist, {
            mood: `I love 'Lose Control' by Teddy Swims. ${command} Recommend other songs with similar vocals and groove.` });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.excludedSongs, [anchor]);
        assert.equal(requests.length, 1);
    });
}

for (const exclusion of [" Don't play 'Lose Control' by Teddy Swims.", " Do not include any songs by Teddy Swims.",
    " But do not play this song.", " Only recommend similar songs.", "continuation"]) {
    test(`featured recording: current exclusion or continuation defeats later recovery (${exclusion})`, async () => {
        const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor]; aiReply(playlist);
        const result = await invoke(getPlaylist, { mood: featuredSongRequest + (exclusion === "continuation" ? "" : exclusion),
            ...(exclusion === "continuation" ? { existingSongs: [anchor] } : {}) });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const cue of ["I love", "I like", "For example,"]) test(`single-quoted taste reference remains optional without an inclusion command (${cue})`, async () => {
    const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor]; playlist.inclusionRequested = false; aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: `${cue} 'Lose Control' by Teddy Swims. Recommend songs with similar vocals and groove.` });
    assert.equal(result.status, 200); assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.tasteSongs, [anchor]);
    assert.equal(result.body.playlist.requestNotice, undefined); assert.equal(context.candidateCount, 14);
});

for (const references of [
    "I love 'Lose Control' by Teddy Swims and 'Someone Like You' by Adele.",
    "I love 'Lose Control' by Teddy Swims. I like 'Someone Like You' by Adele.",
    "I love 'Lose Control' by Teddy Swims, 'Someone Like You' by Adele."
]) test(`featured recording: multiple references do not resolve an ambiguous this-song command (${references.slice(0, 6)})`, async () => {
    const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor, other]; aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: `${references} Create a playlist featuring this song. Recommend songs with similar vocals.` });
    assert.equal(result.status, 200);
    assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song || item.song === other.song));
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.tasteSongs, [anchor, other]);
});

test("featured recording: this-song command before a reference cannot retroactively promote it", async () => {
    const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor]; aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: "Create a playlist featuring this song. I love 'Lose Control' by Teddy Swims. Recommend songs with similar vocals." });
    assert.equal(result.status, 200); assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.tasteSongs, [anchor]);
});

test("featured recording: a negated command inside a later quoted title cannot exclude earlier taste references", async () => {
    const reference = { song: "Do Not Create a Playlist Featuring This Song", artist: "Synthetic performer" };
    const playlist = omittedFeaturedFixture(); playlist.requestedSongs = [anchor, reference]; playlist.inclusionRequested = false; aiReply(playlist);
    const result = await invoke(getPlaylist, {
        mood: `I love 'Lose Control' by Teddy Swims. I like '${reference.song}' by Synthetic performer. Recommend songs with similar vocals.` });
    assert.equal(result.status, 200);
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.excludedSongs, []);
    assert.deepEqual(context.tasteSongs, [anchor, reference]);
});

for (const title of ["Create a Playlist Featuring This Song", "Do Not Create a Playlist Featuring This Song"]) {
    test(`featured recording: a command-shaped title is still only a taste reference (${title})`, async () => {
        const reference = { song: title, artist: "Synthetic performer" }, playlist = omittedFeaturedFixture(reference);
        playlist.requestedSongs = [reference]; playlist.inclusionRequested = false; aiReply(playlist);
        const result = await invoke(getPlaylist, { mood: `I love '${title}' by Synthetic performer. Recommend songs with similar vocals.` });
        assert.equal(result.status, 200); assert.ok(!result.body.playlist.songs.some(item => item.song === title));
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.deepEqual(context.requiredSongs, []); assert.deepEqual(context.tasteSongs, [reference]); assert.deepEqual(context.excludedSongs, []);
    });
}

test("featured recording: emotional negation does not negate a later affirmative playlist instruction", async () => {
    aiReply(omittedFeaturedFixture()); const result = await invoke(getPlaylist, {
        mood: "I love 'Lose Control' by Teddy Swims. I'm not okay but create a playlist featuring this song and music with similar vocals." });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], anchor);
});

for (const mood of ["I feel judged by everyone. Create a playlist for how I feel.",
    "I feel 'left behind' by everyone. Create a playlist for how I feel.",
    "I'm overwhelmed by work and need quiet company.", "I love how music helps me feel understood by others."]) {
    test(`featured recording: ordinary emotional prose is not treated as a title-and-artist command (${mood.slice(0, 15)})`, async () => {
        aiReply(playlistFixture({ songs: musicalFitSongs() })); const result = await invoke(getPlaylist, { mood });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.ok(!context.requiredSongs?.length); assert.equal(context.musicalReferences, undefined); assert.equal(context.candidateCount, undefined);
    });
}

for (const mood of ["Play 'Lose Control by Teddy Swims", "Play 'Lose Control\" by Teddy Swims"]) {
    test(`featured recording: unbalanced quoting cannot recover a guessed canonical recording (${mood.length})`, async () => {
        const songs = [{ song: "Different recording", artist: anchor.artist }, ...musicalFitSongs().slice(1)];
        aiReply(playlistFixture({ songs, inclusionRequested: true })); const result = await invoke(getPlaylist, { mood });
        assert.equal(result.status, 200); assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
        const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
        assert.ok(!context.requiredSongs?.length); assert.match(result.body.playlist.requestNotice, /confidently identify/);
    });
}

for (const rejected of [3, 4]) for (const reason of ["primary mismatch", "malformed judgment", "historical dislike", "continuation"]) {
    test(`fourteen reserves: ${rejected} ${reason} candidates leave ten distinct qualified songs`, async () => {
        const playlist = fourteenCandidateFixture(), removed = playlist.songs.slice(1, rejected + 1);
        for (let index = 1; index <= rejected; index += 1) {
            if (reason === "primary mismatch") setPrimaryMismatch(playlist, index);
            if (reason === "malformed judgment") playlist.musicalFit.assessments[index].judgments = ["match", "unknown"];
        }
        const reserveIndex = rejected === 3 ? 12 : 13;
        playlist.explanation = { connections: [
            { songIndex: 1, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
            { songIndex: reserveIndex, emotionalTheme: "passion", musicalTrait: "dynamic build-up" },
            { songIndex: rejected === 3 ? 13 : 0, emotionalTheme: "comfort", musicalTrait: "groove and rhythm" }
        ] };
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest,
            ...(reason === "historical dislike" ? { avoidSongs: [anchor, ...removed] } : {}),
            ...(reason === "continuation" ? { existingSongs: removed } : {}) });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
        assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(rejected + 1)].slice(0, 10));
        const counter = reason === "primary mismatch" ? "primaryMismatch" : reason === "malformed judgment" ? "invalidAssessment" : "excluded";
        assert.equal(fitCounters()[counter], rejected); assert.equal(fitCounters().eligibleCandidates, 14 - rejected);
        assert.equal(fitCounters().notSelected, 4 - rejected); assert.equal(fitCounters().selectedCount, 10);
        assert.ok(result.body.playlist.explanation.includes(playlist.songs[reserveIndex].song));
        assert.ok(!result.body.playlist.explanation.includes(playlist.songs[1].song));
        if (rejected === 3) assert.ok(!result.body.playlist.explanation.includes(playlist.songs[13].song));
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
        assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
    });
}

for (const length of [9, 11, 25]) test(`fourteen reserves: nondefault musical length ${length} retains its original candidate count`, async () => {
    const songs = [anchor, ...Array.from({ length: length - 1 }, (_, i) => ({ song: `Length fixture ${i}`, artist: `Performer ${i}` }))];
    aiReply(playlistFixture({ songs, musicalFit: musicalFitFixture(songs) }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, length, candidateCount: 14 });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, length);
    const sent = JSON.parse(requests[0][1].body), context = JSON.parse(sent.messages[1].content);
    assert.equal(context.length, length); assert.equal(context.candidateCount, undefined);
    assert.equal(sent.response_format.json_schema.schema.properties.songs.maxItems, length);
    assert.equal(sent.response_format.json_schema.schema.properties.musicalFit.properties.assessments.maxItems, length);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(requests.length, 1);
});

for (const variant of ["representative", "long recording titles", "accented ensemble names"]) for (const truncated of [false, true]) {
    test(`fourteen reserves: realistic ${variant} fixture preserves the fixed budget and fails closed on truncation (${truncated})`, async () => {
        const playlist = realisticFourteenFixture(variant);
        aiReply(playlist, { finish_reason: truncated ? "length" : "stop" });
        const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, truncated ? 502 : 200);
        if (truncated) {
            assert.equal(result.body.playlist, undefined); assert.equal(result.body.reason, "invalid_playlist_response");
            assert.equal(validationDiagnostic().category, "completion_incomplete");
            assert.equal(validationDiagnostic().finishReason, "length");
        } else {
            assert.equal(result.body.playlist.songs.length, 10);
            assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
            assert.deepEqual(result.body.playlist.songs[0], anchor);
            for (const item of playlist.songs) if (!result.body.playlist.songs.some(selected => selected.song === item.song))
                assert.ok(!result.body.playlist.explanation.includes(item.song));
        }
        const sent = JSON.parse(requests[0][1].body), context = JSON.parse(sent.messages[1].content);
        assert.equal(context.length, 10); assert.equal(context.candidateCount, 14);
        assert.equal(sent.max_completion_tokens, 3072); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
        // Output sizes are reported separately; character counts are not token measurements.
    });
}
function fitCounters() {
    const calls = console.log.mock.calls.filter(call => call.arguments[0] === "MUSICAL FIT VALIDATION:");
    assert.equal(calls.length, 1);
    return calls[0].arguments[1];
}
function setPrimaryMismatch(playlist, index) {
    Object.assign(playlist.musicalFit.assessments[index], { kind: "weak",
        judgments: playlist.musicalFit.priorities.map((_priority, i) => i === 0 ? "different" : "match") });
}

function priorityWeightedFixture() {
    const playlist = fourteenCandidateFixture();
    playlist.musicalFit.priorities = [
        { dimension: "vocals", character: "distinctive vocal character" },
        { dimension: "energy", character: "listener's requested musical energy" },
        { dimension: "genre", character: "related musical influences" }
    ];
    // Ranking scenarios retain valid but lower-ranked added reserves so their two
    // competing candidates remain observable. General reserve tests use all-close data.
    playlist.musicalFit.assessments.forEach((item, index) => { item.judgments = index >= 12 ? ["match", "different", "uncertain"] : ["match", "match", "match"]; });
    return playlist;
}

function discoveryPreferenceFixture() {
    const playlist = priorityWeightedFixture();
    // Synthetic counterpart of the logged pool shape, not the live provider response.
    playlist.songs[0] = { song: "Synthetic close alternative", artist: "Synthetic performer" };
    playlist.musicalFit.assessments.forEach((item, index) => {
        item.kind = index < 3 ? "discovery" : index >= 4 && index < 8 ? "close" : index < 4 ? "close" : "discovery";
        item.judgments = index < 4 ? ["match", "match", "uncertain"] : ["match", "different", "uncertain"];
    });
    return playlist;
}

test("discovery preference: observed shortage shape backfills to ten without another call or changing fit labels", async () => {
    const playlist = discoveryPreferenceFixture(); aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [anchor], recentSongs: playlist.songs });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(0, 9)]);
    assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
    const counts = fitCounters();
    assert.equal(counts.candidateCount, 14); assert.equal(counts.eligibleCandidates, 14); assert.equal(counts.selectedCount, 10);
    assert.equal(counts.recoveredExplicit, 1); assert.equal(counts.explicitAssessmentBypass, 1);
    assert.equal(counts.discoveryLimit, 7); assert.equal(counts.discoveryBackfill, 2); assert.equal(counts.notSelected, 5);
    assert.equal(counts.labelCorrections, 7); assert.equal(counts.invalidAssessment, 0);
    const sent = JSON.parse(requests[0][1].body);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(sent.response_format.json_schema.schema.properties.songs.maxItems, 14);
    assert.match(sent.messages[0].content, /additional validated discoveries may fill a shortage/);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

test("discovery preference: late close matches are selected ahead of earlier primary-only candidates", async () => {
    const playlist = priorityWeightedFixture();
    playlist.musicalFit.assessments.slice(0, 8).forEach(item => { item.kind = "discovery"; item.judgments = ["match", "different", "different"]; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs.slice(0, 5), [anchor, ...playlist.songs.slice(8, 12)]);
    assert.equal(fitCounters().discoveryBackfill, 2); assert.equal(result.body.playlist.songs.length, 10);
});

test("discovery preference: enough close matches avoid unnecessary deferral or backfill", async () => {
    const playlist = priorityWeightedFixture();
    playlist.musicalFit.assessments.slice(8).forEach(item => { item.kind = "discovery"; item.judgments = ["match", "different", "uncertain"]; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, playlist.songs.slice(0, 10));
    assert.equal(fitCounters().discoveryLimit, 0); assert.equal(fitCounters().discoveryBackfill, 0); assert.equal(fitCounters().notSelected, 4);
});

for (const reverseRows of [false, true]) test(`discovery preference: backfill retains uncertainty and model-order tie breakers (${reverseRows})`, async () => {
    const playlist = discoveryPreferenceFixture();
    playlist.musicalFit.assessments[7].judgments = ["match", "uncertain", "uncertain"];
    if (reverseRows) playlist.musicalFit.assessments.reverse();
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(0, 7), ...playlist.songs.slice(8, 10)]);
    assert.equal(fitCounters().discoveryBackfill, 2);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[7].song));
});

test("discovery preference: only final backfilled recordings supply their declared explanation traits", async () => {
    const playlist = discoveryPreferenceFixture();
    playlist.explanation = { connections: [
        { songIndex: 9, emotionalTheme: "passion", musicalTrait: "high musical energy" },
        { songIndex: 8, emotionalTheme: "longing", musicalTrait: "high musical energy" },
        { songIndex: 0, emotionalTheme: "comfort", musicalTrait: "related genre influences" }
    ] };
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.explanation,
        `${JSON.stringify(playlist.songs[8].song)} by ${playlist.songs[8].artist} may connect through longing and similarities in vocal character (an unverified curator judgment). ` +
        `${JSON.stringify(playlist.songs[0].song)} by ${playlist.songs[0].artist} may connect through comfort and similarities in vocal character, musical energy (an unverified curator judgment).`);
    assert.ok(!result.body.playlist.explanation.includes(playlist.songs[9].song));
    assert.ok(!result.body.playlist.explanation.includes("high musical energy"));
});

for (const exclusion of ["current title", "current artist", "continuation"]) {
    test(`discovery preference: backfill cannot override explicit-anchor ${exclusion} exclusion`, async () => {
        const playlist = discoveryPreferenceFixture(); aiReply(playlist);
        const mood = musicalFitRequest + (exclusion === "current title" ? " Don't play Lose Control."
            : exclusion === "current artist" ? " Do not include any songs by Teddy Swims." : "");
        const result = await invoke(getPlaylist, { mood, ...(exclusion === "continuation" ? { existingSongs: [anchor] } : {}) });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
        assert.equal(fitCounters().recoveredExplicit, 0); assert.equal(fitCounters().explicitAssessmentBypass, 0);
        assert.equal(fitCounters().discoveryBackfill, 3);
    });
}

for (const failure of ["weak", "uncertain", "different primary", "unknown primary", "malformed", "historical dislike"]) {
    test(`discovery preference: deferred backfill cannot resurrect ${failure} candidates`, async () => {
        const playlist = discoveryPreferenceFixture(), row = playlist.musicalFit.assessments[8];
        const counter = { weak: "weakAssessment", uncertain: "uncertainAssessment", "different primary": "primaryMismatch",
            "unknown primary": "primaryUnknown", malformed: "invalidAssessment", "historical dislike": "excluded" }[failure];
        if (["weak", "uncertain"].includes(failure)) row.kind = failure;
        if (failure === "different primary") row.judgments = ["different", "match", "match"];
        if (failure === "unknown primary") row.judgments = ["uncertain", "match", "match"];
        if (failure === "malformed") row.judgments = ["match", "unknown", "uncertain"];
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest,
            ...(failure === "historical dislike" ? { avoidSongs: [playlist.songs[8]] } : {}) });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[8].song));
        assert.equal(fitCounters()[counter], 1); assert.equal(fitCounters().discoveryBackfill, 2);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const badIndex of [8, 9]) test(`discovery preference: conflicting duplicate support stays ineligible during backfill (${badIndex})`, async () => {
    const playlist = discoveryPreferenceFixture(); playlist.songs[9] = { ...playlist.songs[8] };
    playlist.musicalFit.assessments[badIndex].kind = "weak";
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[8].song));
    assert.equal(fitCounters().duplicate, 1); assert.equal(fitCounters().weakAssessment, 1);
});

test("discovery preference: fewer than ten eligible songs still produce the limitation without retry or partial output", async () => {
    const playlist = discoveryPreferenceFixture();
    playlist.musicalFit.assessments.slice(8).forEach(item => { item.judgments = ["different", "match", "match"]; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "insufficient_musical_fit");
    assert.equal(result.body.playlist, undefined); assert.equal(result.body.choices, undefined);
    assert.equal(fitCounters().selectedCount, 9); assert.equal(fitCounters().discoveryBackfill, 1); assert.equal(fitCounters().primaryMismatch, 6);
    assert.equal(validationDiagnostic().category, "insufficient_eligible_songs");
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

for (const explicit of [false, true]) test(`discovery preference: valid primary-only pools may exceed five discoveries without fabricating close matches (${explicit})`, async () => {
    const playlist = discoveryPreferenceFixture(); playlist.requestedSongs = explicit ? [anchor] : [];
    playlist.musicalFit.assessments.forEach(item => { item.kind = "discovery"; item.judgments = ["match", "different", "uncertain"]; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: explicit ? musicalFitRequest : 'Find songs that sound like "Lose Control" by Teddy Swims.' });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
    assert.equal(fitCounters().discoveryBackfill, explicit ? 6 : 7); assert.equal(fitCounters().labelCorrections, 0);
    assert.equal(fitCounters().recoveredExplicit, explicit ? 1 : 0); assert.equal(requests.length, 1);
});

for (const length of [3, 5, 25]) test(`discovery preference: supported nondefault length ${length} still returns exactly that many songs`, async () => {
    const songs = [anchor, ...Array.from({ length: length - 1 }, (_, i) => ({ song: `Alternate fixture ${i}`, artist: `Performer ${i}` }))];
    const fit = musicalFitFixture(songs); fit.assessments.slice(1).forEach(item => { item.kind = "discovery"; item.judgments = ["match", "different"]; });
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, length });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, length);
    assert.equal(fitCounters().discoveryBackfill, length - 1 - Math.max(1, Math.floor(length / 3)));
    assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
});

for (const priorityCount of [2, 3]) test(`ordered judgments: schema and curator request one closed value per priority (${priorityCount})`, async () => {
    const playlist = priorityCount === 2 ? fourteenCandidateFixture() : priorityWeightedFixture();
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    const sent = JSON.parse(requests[0][1].body), assessment = sent.response_format.json_schema.schema.properties.musicalFit.properties.assessments.items;
    assert.deepEqual(assessment.required, ["songIndex", "kind", "judgments"]);
    assert.equal(assessment.additionalProperties, false);
    assert.deepEqual(Object.keys(assessment.properties), ["songIndex", "kind", "judgments"]);
    assert.deepEqual(assessment.properties.judgments, { type: "array", items: { type: "string", enum: ["match", "different", "uncertain"] }, minItems: 2, maxItems: 3 });
    assert.match(sent.messages[0].content, /exactly one value per musical priority, in the SAME order/);
    assert.match(sent.messages[0].content, /Two priorities require two values; three priorities require three/);
    assert.match(sent.messages[0].content, /Do not return priority indexes or separate matches\/differences\/uncertain arrays/);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(sent.model, "gpt-4o-mini");
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

for (const [name, value, counter] of [
    ["null", null, "assessmentInvalidSupport"],
    ["object", { 0: "match", 1: "match" }, "assessmentInvalidSupport"],
    ["string", "match,match", "assessmentInvalidSupport"],
    ["null entry", ["match", null], "assessmentInvalidSupport"],
    ["boolean entry", ["match", true], "assessmentInvalidSupport"],
    ["numeric entry", ["match", 1], "assessmentInvalidSupport"],
    ["object entry", ["match", { state: "match" }], "assessmentInvalidSupport"],
    ["upper case", ["match", "MATCH"], "assessmentInvalidSupport"],
    ["whitespace", ["match", " match"], "assessmentInvalidSupport"],
    ["unknown state", ["match", "similar"], "assessmentInvalidSupport"],
    ["empty state", ["match", ""], "assessmentInvalidSupport"],
    ["empty sequence", [], "assessmentInvalidJudgmentCount"],
    ["missing secondary value", ["match"], "assessmentInvalidJudgmentCount"],
    ["extra third value", ["match", "match", "uncertain"], "assessmentInvalidJudgmentCount"]
]) test(`ordered judgments: ${name} rejects the affected candidate without filling or coercing support`, async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[1].judgments = value;
    playlist.explanation = explanationConnections(1);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
    assert.equal(fitCounters()[counter], 1); assert.equal(fitCounters().invalidAssessment, 1);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

for (const mode of ["legacy only", "legacy overlap", "mixed formats"]) test(`ordered judgments: ${mode} cannot supply guessed musical support`, async () => {
    const playlist = fourteenCandidateFixture();
    const legacy = { songIndex: 1, kind: "close", matches: [0, 1], differences: [], uncertain: [] };
    if (mode === "legacy overlap") legacy.differences = [0];
    playlist.musicalFit.assessments[1] = mode === "mixed formats" ? { ...legacy, judgments: ["match", "match"] } : legacy;
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.equal(fitCounters().assessmentInvalidShape, 1); assert.equal(fitCounters().invalidAssessment, 1);
});

test("ordered judgments: all 144 bounded state/classification combinations preserve existing eligibility", async () => {
    const states = ["match", "different", "uncertain"];
    let cases = 0;
    for (const count of [2, 3]) for (let encoded = 0; encoded < 3 ** count; encoded += 1) {
        const judgments = Array.from({ length: count }, (_, i) => states[Math.floor(encoded / 3 ** i) % 3]);
        for (const kind of ["close", "discovery", "weak", "uncertain"]) {
            delete global.playlistRateLimit;
            const playlist = playlistFixture({ songs: [anchor, other], requestedSongs: [anchor], musicalFit: musicalFitFixture([anchor, other]) });
            if (count === 3) {
                playlist.musicalFit.priorities.push({ dimension: "energy", character: "listener's requested energy" });
                playlist.musicalFit.assessments[0].judgments.push("match");
            }
            playlist.musicalFit.assessments[1] = { songIndex: 1, kind, judgments };
            playlist.explanation = explanationConnections(1);
            aiReply(playlist); const callsBefore = requests.length;
            const result = await invoke(getPlaylist, { mood: musicalFitRequest, length: 2 });
            const eligible = judgments[0] === "match" && ["close", "discovery"].includes(kind);
            assert.equal(result.status, eligible ? 200 : 502, JSON.stringify({ count, judgments, kind }));
            if (eligible) {
                assert.deepEqual(result.body.playlist.songs, [anchor, other]);
                const traits = ["vocal character", "groove and rhythm", "musical energy"].filter((_trait, i) => judgments[i] === "match").slice(0, 2);
                assert.equal(result.body.playlist.explanation, `${JSON.stringify(other.song)} by ${other.artist} may connect through longing and similarities in ${traits.join(", ")} (an unverified curator judgment).`);
            } else {
                assert.equal(result.body.reason, "insufficient_musical_fit"); assert.equal(result.body.playlist, undefined);
            }
            assert.equal(requests.length - callsBefore, 1); cases += 1;
        }
    }
    assert.equal(cases, 144); assert.equal(detailRequests.length, 0);
});

test("ordered judgments: missing third support is not inferred from a strong classification or explanation", async () => {
    const playlist = priorityWeightedFixture();
    for (const index of [1, 2, 3, 4, 5]) playlist.musicalFit.assessments[index].judgments = ["match", "match"];
    playlist.explanation = explanationConnections(1, "passion", "high musical energy");
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "insufficient_musical_fit");
    assert.equal(result.body.playlist, undefined); assert.equal(fitCounters().selectedCount, 9);
    assert.equal(fitCounters().assessmentInvalidJudgmentCount, 5); assert.equal(requests.length, 1);
});

test("ordered judgments: additional validated discoveries fill a shortage after the initial allowance", async () => {
    const playlist = priorityWeightedFixture();
    playlist.musicalFit.assessments.slice(6).forEach(item => { item.judgments = ["match", "different", "uncertain"]; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(fitCounters().selectedCount, 10); assert.equal(fitCounters().discoveryLimit, 5);
    assert.equal(fitCounters().discoveryBackfill, 1); assert.equal(fitCounters().notSelected, 4);
    assert.equal(fitCounters().invalidAssessment, 0); assert.equal(requests.length, 1);
});

for (const higherIndex of [9, 10]) for (const reverseRows of [false, true]) for (const higherUncertain of [false, true]) {
    test(`priority weighting: 0+1 beats 0+2 (index ${higherIndex}, reverse ${reverseRows}, uncertain ${higherUncertain})`, async () => {
        const playlist = priorityWeightedFixture(), lowerIndex = higherIndex === 9 ? 10 : 9;
        Object.assign(playlist.musicalFit.assessments[higherIndex], {
            judgments: ["match", "match", higherUncertain ? "uncertain" : "different"]
        });
        Object.assign(playlist.musicalFit.assessments[lowerIndex], { judgments: ["match", "different", "match"] });
        Object.assign(playlist.musicalFit.assessments[11], { kind: "weak", judgments: ["different", "match", "match"] });
        if (reverseRows) playlist.musicalFit.assessments.reverse();
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [...playlist.songs.slice(0, 9), playlist.songs[higherIndex]]);
        assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
        const sent = JSON.parse(requests[0][1].body), schema = sent.response_format.json_schema.schema.properties.musicalFit;
        assert.equal(sent.max_completion_tokens, 3072);
        assert.deepEqual(schema.properties.assessments.items.required, ["songIndex", "kind", "judgments"]);
        assert.equal(schema.properties.assessments.maxItems, 14);
        assert.equal(result.body.playlist.musicalFit, undefined);
    });
}

for (const certainIndex of [9, 10]) test(`priority weighting: fewer uncertainties break equal weighted support (index ${certainIndex})`, async () => {
    const playlist = priorityWeightedFixture(), uncertainIndex = certainIndex === 9 ? 10 : 9;
    Object.assign(playlist.musicalFit.assessments[certainIndex], { judgments: ["match", "match", "different"] });
    Object.assign(playlist.musicalFit.assessments[uncertainIndex], { judgments: ["match", "match", "uncertain"] });
    Object.assign(playlist.musicalFit.assessments[11], { kind: "weak", judgments: ["different", "match", "match"] });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs.at(-1), playlist.songs[certainIndex]);
});

for (const reverseRows of [false, true]) test(`priority weighting: candidate order breaks exact ties, not assessment row order (${reverseRows})`, async () => {
    const playlist = priorityWeightedFixture();
    for (const index of [9, 10]) Object.assign(playlist.musicalFit.assessments[index], { judgments: ["match", "match", "uncertain"] });
    Object.assign(playlist.musicalFit.assessments[11], { kind: "weak", judgments: ["different", "match", "match"] });
    if (reverseRows) playlist.musicalFit.assessments.reverse();
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs.at(-1), playlist.songs[9]);
});

for (const lowerIndex of [1, 2]) test(`priority weighting: duplicate recording retains lower weighted support regardless of order (${lowerIndex})`, async () => {
    const playlist = priorityWeightedFixture(), higherIndex = lowerIndex === 1 ? 2 : 1;
    playlist.songs[2] = { ...playlist.songs[1] };
    Object.assign(playlist.musicalFit.assessments[lowerIndex], { judgments: ["match", "different", "match"] });
    Object.assign(playlist.musicalFit.assessments[higherIndex], { judgments: ["match", "match", "different"] });
    Object.assign(playlist.musicalFit.assessments[11], { judgments: ["match", "match", "different"] });
    playlist.explanation = { connections: [
        { songIndex: higherIndex, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
        { songIndex: 11, emotionalTheme: "passion", musicalTrait: "high musical energy" }
    ] };
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.deepEqual(result.body.playlist.songs.at(-1), playlist.songs[11]);
    assert.equal(fitCounters().duplicate, 1);
    assert.equal(result.body.playlist.explanation, `${JSON.stringify(playlist.songs[11].song)} by ${playlist.songs[11].artist} may connect through passion and similarities in vocal character, musical energy (an unverified curator judgment).`);
});

for (const uncertainIndex of [1, 2]) test(`priority weighting: equal-score duplicate retains greater uncertainty (${uncertainIndex})`, async () => {
    const playlist = priorityWeightedFixture(); playlist.songs[2] = { ...playlist.songs[1] };
    for (const index of [1, 2, 11]) Object.assign(playlist.musicalFit.assessments[index], { judgments: ["match", "match", "different"] });
    Object.assign(playlist.musicalFit.assessments[uncertainIndex], { judgments: ["match", "match", "uncertain"] });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.deepEqual(result.body.playlist.songs.at(-1), playlist.songs[11]);
});

for (const failure of ["weak", "uncertain", "malformed", "unsupported primary", "unknown primary"]) {
    test(`priority weighting: apparent weighted coverage cannot rescue ${failure} support`, async () => {
        const playlist = priorityWeightedFixture(), assessment = playlist.musicalFit.assessments[1];
        if (["weak", "uncertain"].includes(failure)) assessment.kind = failure;
        if (failure === "malformed") assessment.judgments = ["match", "match", "match", "match"];
        if (failure === "unsupported primary") Object.assign(assessment, { judgments: ["different", "match", "match"] });
        if (failure === "unknown primary") Object.assign(assessment, { judgments: ["uncertain", "match", "match"] });
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    test(`priority weighting: explanation follows declared priority permutation ${order}`, async () => {
        const playlist = priorityWeightedFixture();
        playlist.musicalFit.priorities = order.map(index => playlist.musicalFit.priorities[index]);
        playlist.explanation = explanationConnections(1);
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, 200);
        const traits = ["vocal character", "musical energy", "genre influences"];
        assert.equal(result.body.playlist.explanation, `${JSON.stringify(playlist.songs[1].song)} by ${playlist.songs[1].artist} may connect through longing and similarities in ${order.slice(0, 2).map(index => traits[index]).join(", ")} (an unverified curator judgment).`);
    });
}

for (const exclusion of ["historical", "continuation", "current title", "current artist"]) {
    test(`priority weighting: strongest coverage cannot override ${exclusion} exclusion`, async () => {
        const playlist = priorityWeightedFixture();
        const mood = musicalFitRequest + (exclusion === "current title" ? ` Do not play "${playlist.songs[1].song}" by ${playlist.songs[1].artist}.`
            : exclusion === "current artist" ? ` Do not include any songs by ${playlist.songs[1].artist}.` : "");
        const options = exclusion === "historical" ? { avoidSongs: [anchor, playlist.songs[1]] }
            : exclusion === "continuation" ? { existingSongs: [playlist.songs[1]] } : {};
        aiReply(playlist); const result = await invoke(getPlaylist, { mood, ...options });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.deepEqual(result.body.playlist.songs[0], anchor);
        assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
        assert.equal(fitCounters().excluded, 1);
    });
}

test("priority weighting: gentle reference priorities retain their meaning without a fixed vocal or intensity preference", async () => {
    const playlist = priorityWeightedFixture();
    playlist.musicalFit.priorities = [{ dimension: "energy", character: "quiet, low musical energy" },
        { dimension: "instrumentation", character: "gentle acoustic texture" }, { dimension: "vocals", character: "restrained delivery" }];
    Object.assign(playlist.musicalFit.assessments[9], { judgments: ["match", "different", "match"] });
    Object.assign(playlist.musicalFit.assessments[10], { judgments: ["match", "match", "different"] });
    Object.assign(playlist.musicalFit.assessments[11], { kind: "weak", judgments: ["different", "match", "match"] });
    playlist.explanation = explanationConnections(10, "calm", "acoustic textures");
    aiReply(playlist); const result = await invoke(getPlaylist, {
        mood: 'Play "Lose Control" by Teddy Swims and recommend songs with similar sound. Keep the recommendations quiet, gentle and acoustic.' });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs.at(-1), playlist.songs[10]);
    assert.match(result.body.playlist.explanation, /musical energy, instrumentation/);
    assert.ok(!result.body.playlist.explanation.includes("vocal character"));
});

test("priority weighting: ordinary emotional requests preserve model order and the original response schema", async () => {
    const songs = musicalFitSongs(); aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood: "I want quiet company and gentle music while feeling both lonely and relieved." });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
    const sent = JSON.parse(requests[0][1].body);
    assert.equal(sent.response_format.json_schema.schema.properties.musicalFit, undefined);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(console.log.mock.calls.filter(call => call.arguments[0] === "MUSICAL FIT VALIDATION:").length, 0);
});

for (const [name, change, counters, rejected = [1]] of [
    ["extra field", rows => { rows[1].evidence = "Unsupported evidence"; }, { assessmentInvalidShape: 1 }],
    ["missing field", rows => { delete rows[1].judgments; }, { assessmentInvalidShape: 1 }],
    ["null row", rows => { rows[1] = null; }, { assessmentInvalidShape: 1, assessmentMissingIndex: 1 }],
    ["array row", rows => { rows[1] = []; }, { assessmentInvalidShape: 1, assessmentMissingIndex: 1 }],
    ["string row", rows => { rows[1] = "not an assessment"; }, { assessmentInvalidShape: 1, assessmentMissingIndex: 1 }],
    ["missing index", rows => { delete rows[1].songIndex; }, { assessmentInvalidIndex: 1, assessmentMissingIndex: 1 }],
    ["string index", rows => { rows[1].songIndex = "1"; }, { assessmentInvalidIndex: 1, assessmentMissingIndex: 1 }],
    ["fractional index", rows => { rows[1].songIndex = 1.5; }, { assessmentInvalidIndex: 1, assessmentMissingIndex: 1 }],
    ["negative index", rows => { rows[1].songIndex = -1; }, { assessmentInvalidIndex: 1, assessmentMissingIndex: 1 }],
    ["out-of-range index", rows => { rows[1].songIndex = 14; }, { assessmentInvalidIndex: 1, assessmentMissingIndex: 1 }],
    ["invalid classification", rows => { rows[1].kind = "excellent"; }, { assessmentInvalidClassification: 1 }],
    ["missing classification", rows => { delete rows[1].kind; }, { assessmentInvalidShape: 1 }],
    ["non-array support", rows => { rows[1].judgments = "match,match"; }, { assessmentInvalidSupport: 1 }],
    ["non-string judgment", rows => { rows[1].judgments = ["match", 1]; }, { assessmentInvalidSupport: 1 }],
    ["unknown judgment", rows => { rows[1].judgments = ["match", "unsupported"]; }, { assessmentInvalidSupport: 1 }],
    ["unbounded support", rows => { rows[1].judgments = ["match", "match", "match", "match"]; }, { assessmentInvalidJudgmentCount: 1 }],
    ["legacy grouping mixed with judgments", rows => { rows[1].matches = [0]; rows[1].differences = [1]; }, { assessmentInvalidShape: 1 }],
    ["nested judgment", rows => { rows[1].judgments = [["match"], "match"]; }, { assessmentInvalidSupport: 1 }],
    ["missing priority", rows => { rows[1].judgments = ["match"]; }, { assessmentInvalidJudgmentCount: 1 }],
    ["missing assessment row", rows => { rows.splice(1, 1); }, { assessmentMissingIndex: 1 }],
    ["duplicate index", rows => { rows[1].songIndex = 2; }, { assessmentDuplicateIndex: 1, assessmentMissingIndex: 1 }, [1, 2]],
    ["malformed duplicate index", rows => { rows[1] = { songIndex: 2 }; }, { assessmentDuplicateIndex: 1, assessmentMissingIndex: 1 }, [1, 2]]
]) test(`individual assessments: ${name} rejects affected candidates without repairing support`, async () => {
    const playlist = fourteenCandidateFixture(); change(playlist.musicalFit.assessments);
    playlist.explanation = explanationConnections(1);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    for (const index of rejected) assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[index].song));
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
    const counts = fitCounters();
    assert.equal(counts.invalidAssessment, rejected.length);
    for (const [key, value] of Object.entries(counters)) assert.equal(counts[key], value, key);
    assert.equal(counts.explicitAssessmentBypass, 0); assert.equal(counts.labelCorrections, 0);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
});

for (const reverse of [false, true]) test(`individual assessments: duplicate index is ambiguous regardless of row order (${reverse})`, async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[1] = { songIndex: 2 };
    if (reverse) playlist.musicalFit.assessments.reverse();
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => [playlist.songs[1].song, playlist.songs[2].song].includes(item.song)));
    assert.equal(fitCounters().assessmentDuplicateIndex, 1); assert.equal(fitCounters().assessmentMissingIndex, 1);
});

test("individual assessments: valid out-of-order indexes retain original identity and explanations", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments.reverse();
    playlist.explanation = explanationConnections(1);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, playlist.songs.slice(0, 10));
    assert.equal(result.body.playlist.explanation, fitConnectionText(playlist.songs[1]));
    assert.equal(fitCounters().invalidAssessment, 0);
});

for (const missing of [2, 3, 4, 5]) test(`individual assessments: ${missing} missing rows use only explicitly indexed support`, async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments.splice(1, missing);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, missing <= 4 ? 200 : 502);
    assert.equal(fitCounters().assessmentMissingIndex, missing);
    assert.equal(fitCounters().invalidAssessment, missing);
    if (missing <= 4) {
        assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(missing + 1)].slice(0, 10));
        assert.equal(result.body.playlist.songs.length, 10);
    } else {
        assert.equal(result.body.reason, "insufficient_musical_fit"); assert.equal(result.body.playlist, undefined);
    }
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

test("individual assessments: invalid row does not promote weak primary support in other candidates", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[1].kind = "invalid";
    [2, 3, 4, 5].forEach(index => setPrimaryMismatch(playlist, index));
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "insufficient_musical_fit");
    assert.equal(fitCounters().invalidAssessment, 1); assert.equal(fitCounters().primaryMismatch, 4);
    assert.equal(fitCounters().selectedCount, 9); assert.equal(requests.length, 1);
});

for (const badIndex of [1, 2]) test(`individual assessments: malformed duplicate recording cannot borrow valid support (${badIndex})`, async () => {
    const playlist = fourteenCandidateFixture(); playlist.songs[2] = { ...playlist.songs[1] };
    delete playlist.musicalFit.assessments[badIndex].judgments;
    playlist.explanation = explanationConnections(badIndex === 1 ? 2 : 1);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.equal(fitCounters().invalidAssessment, 1); assert.equal(fitCounters().duplicate, 1);
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
});

for (const failure of ["shape", "missing", "duplicate", "classification", "judgment count"]) {
    test(`individual assessments: explicit anchor with ${failure} is inclusion-only, never a verified fit`, async () => {
        const playlist = fourteenCandidateFixture();
        if (failure === "shape") delete playlist.musicalFit.assessments[0].judgments;
        if (failure === "missing") playlist.musicalFit.assessments.shift();
        if (failure === "duplicate") playlist.musicalFit.assessments[1].songIndex = 0;
        if (failure === "classification") playlist.musicalFit.assessments[0].kind = "excellent";
        if (failure === "judgment count") playlist.musicalFit.assessments[0].judgments.pop();
        playlist.explanation = { connections: [
            { songIndex: 0, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
            { songIndex: 10, emotionalTheme: "passion", musicalTrait: "high musical energy" }
        ] };
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [anchor], recentSongs: [anchor] });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.deepEqual(result.body.playlist.songs[0], anchor);
        assert.ok(!result.body.playlist.explanation.includes(anchor.song));
        assert.equal(fitCounters().explicitAssessmentBypass, 1); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const exclusion of [" Don't play Lose Control.", " Do not include any songs by Teddy Swims.", "continuation"]) {
    test(`individual assessments: invalid explicit anchor cannot bypass current ${exclusion}`, async () => {
        const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[0] = { songIndex: 0 };
        aiReply(playlist);
        const result = await invoke(getPlaylist, { mood: musicalFitRequest + (exclusion === "continuation" ? "" : exclusion),
            ...(exclusion === "continuation" ? { existingSongs: [anchor] } : {}) });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
        assert.equal(fitCounters().explicitAssessmentBypass, 0); assert.equal(fitCounters().excluded, 1);
        assert.ok(!result.body.playlist.explanation.includes(anchor.song));
    });
}

test("individual assessments: similar-only reference never receives an invalid-assessment inclusion exception", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[0] = { songIndex: 0 };
    aiReply(playlist); const result = await invoke(getPlaylist, {
        mood: musicalFitRequest + ' Only recommend similar songs.' });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
    assert.equal(fitCounters().explicitAssessmentBypass, 0);
});

test("individual assessments: unavailable explicit song never receives an invalid-assessment inclusion exception", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[0] = { songIndex: 0 };
    playlist.unavailableRequestedSongs = [anchor];
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === anchor.song));
    assert.equal(fitCounters().explicitAssessmentBypass, 0); assert.match(result.body.playlist.requestNotice, /availability/);
});

test("individual assessments: a one-song explicit request needs no fabricated comparison assessment", async () => {
    const playlist = playlistFixture({ songs: [anchor], requestedSongs: [anchor], musicalFit: musicalFitFixture([anchor]) });
    playlist.musicalFit.assessments = [];
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest, length: 1 });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, [anchor]);
    assert.equal(fitCounters().explicitAssessmentBypass, 1); assert.equal(fitCounters().assessmentMissingIndex, 1);
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

test("individual assessments: exclusions and invalid assessments use reserves before grounded explanation reconstruction", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[1].kind = "invalid";
    playlist.explanation = { connections: [
        { songIndex: 1, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
        { songIndex: 2, emotionalTheme: "heartbreak", musicalTrait: "expressive vocals" },
        { songIndex: 11, emotionalTheme: "passion", musicalTrait: "high musical energy" }
    ] };
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [playlist.songs[2]] });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(result.body.playlist.explanation, fitConnectionText(playlist.songs[11], "passion"));
    assert.equal(fitCounters().invalidAssessment, 1); assert.equal(fitCounters().excluded, 1);
});

for (const mode of ["five invalid", "all invalid", "empty assessments"]) {
    test(`individual assessments: ${mode} yields the existing limitation without partial results or retry`, async () => {
        const playlist = fourteenCandidateFixture();
        if (mode === "five invalid") [1, 2, 3, 4, 5].forEach(index => { playlist.musicalFit.assessments[index].kind = "invalid"; });
        if (mode === "all invalid") playlist.musicalFit.assessments.forEach(item => { delete item.judgments; });
        if (mode === "empty assessments") playlist.musicalFit.assessments = [];
        aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, 502); assert.equal(result.body.reason, "insufficient_musical_fit");
        assert.match(result.body.error, /requested number of distinct songs with sufficiently consistent musical connections/);
        assert.equal(result.body.playlist, undefined); assert.equal(result.body.choices, undefined);
        assert.equal(fitCounters().selectedCount, mode === "five invalid" ? 9 : 1);
        assert.equal(fitCounters().explicitAssessmentBypass, mode === "five invalid" ? 0 : 1);
        assert.equal(validationDiagnostic().category, "insufficient_eligible_songs");
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

function validationDiagnostic() {
    const entries = console.error.mock.calls.filter(call => call.arguments[0] === "PLAYLIST VALIDATION DIAGNOSTIC:");
    assert.equal(entries.length, 1);
    return entries[0].arguments[1];
}

for (const [name, category, alterPlaylist, alterEnvelope] of [
    ["truncation", "completion_incomplete", null, data => { data.choices[0].finish_reason = "length"; }],
    ["missing choice", "completion_missing", null, data => { data.choices = []; }],
    ["missing message", "completion_missing", null, data => { delete data.choices[0].message; }],
    ["missing finish reason", "completion_missing", null, data => { delete data.choices[0].finish_reason; }],
    ["missing content", "completion_missing", null, data => { delete data.choices[0].message.content; }],
    ["refusal", "completion_refused", null, data => { data.choices[0].message.refusal = "Synthetic refusal"; }],
    ["invalid envelope", "invalid_response_structure", null, data => { data.choices = {}; }],
    ["invalid playlist JSON", "invalid_playlist_json", null, data => { data.choices[0].message.content = "not-json"; }],
    ["invalid playlist shape", "invalid_playlist_structure", p => { p.songs[1].artist = ""; }],
    ["candidate count", "candidate_count_mismatch", p => { p.songs.pop(); p.musicalFit.assessments.pop(); }],
    ["assessment count", "assessment_count_mismatch", p => { p.musicalFit.assessments.push({ ...p.musicalFit.assessments[0] }); }],
    ["reference identity", "reference_identity_mismatch", p => { p.musicalFit.reference = { ...anchor, artist: "Different fixture artist" }; }],
    ["priorities", "invalid_musical_priorities", p => { p.musicalFit.priorities[1].dimension = "vocals"; }],
    ["assessment container", "invalid_song_assessments", p => { p.musicalFit.assessments = {}; }],
    ["invalid explanation", "invalid_explanation", p => { p.explanation = "Unsupported explanation"; }],
    ["eligible shortage", "insufficient_eligible_songs", p => { [1, 2, 3, 4, 5].forEach(index => setPrimaryMismatch(p, index)); }]
]) test(`validation diagnostics: ${name} receives a fixed category without changing the public error`, async () => {
    const playlist = fourteenCandidateFixture(); alterPlaylist?.(playlist);
    const data = { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(playlist) } }], usage: { completion_tokens: 1800 } };
    alterEnvelope?.(data); fetchImpl = async () => response(data);
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, name === "invalid envelope" ? 503 : 502);
    assert.equal(result.body.reason, name === "eligible shortage" ? "insufficient_musical_fit"
        : name === "invalid envelope" ? "upstream_error" : "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined); assert.equal(result.body.diagnostics, undefined);
    const diagnostic = validationDiagnostic();
    assert.equal(diagnostic.category, category); assert.equal(diagnostic.expectedSongCount, 10);
    assert.equal(diagnostic.expectedCandidateCount, 14); assert.equal(diagnostic.expectedAssessmentCount, 14);
    assert.equal(diagnostic.completionTokens, 1800);
    assert.equal(diagnostic.refused, name === "refusal");
    assert.equal(diagnostic.finishReason, name === "truncation" ? "length"
        : ["missing choice", "missing finish reason", "invalid envelope"].includes(name) ? "missing" : "stop");
    if (name === "candidate count") assert.equal(diagnostic.receivedCandidateCount, 13);
    if (name === "assessment count") { assert.equal(diagnostic.receivedCandidateCount, 14); assert.equal(diagnostic.receivedAssessmentCount, 15); }
    if (name === "priorities") assert.equal(diagnostic.receivedPriorityCount, 2);
    if (name === "eligible shortage") assert.equal(diagnostic.eligibleSongCount, 9);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
});

test("validation diagnostics: invalid upstream JSON keeps its original response and omits unknown metadata", async () => {
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error("Synthetic private parser exception"); } });
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_upstream_response");
    assert.deepEqual(validationDiagnostic(), { category: "invalid_response_json", finishReason: "missing", refused: false,
        expectedSongCount: 10, expectedCandidateCount: 14, expectedAssessmentCount: 14 });
    assert.equal(requests.length, 1);
});

for (const finish of ["stop", "length", "content_filter", "tool_calls", "function_call", null, "unrecognized-private-finish"]) {
    test(`validation diagnostics: finish-reason allowlist handles ${JSON.stringify(finish)}`, async () => {
        fetchImpl = async () => response({ choices: [{ finish_reason: finish, message: { content: "invalid-json" } }] });
        assert.equal((await invoke(getPlaylist, { mood: musicalFitRequest })).status, 502);
        const diagnostic = validationDiagnostic();
        assert.equal(diagnostic.finishReason, finish === null ? "missing" : finish === "unrecognized-private-finish" ? "unknown" : finish);
        assert.equal(diagnostic.completionTokens, undefined); assert.equal(requests.length, 1);
    });
}

for (const tokens of [0, 3072, undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "private-token-value"]) {
    test(`validation diagnostics: completion-token metadata accepts only nonnegative safe integers (${String(tokens)})`, async () => {
        fetchImpl = async () => response({ choices: [{ finish_reason: "length", message: { content: "incomplete" } }],
            usage: { completion_tokens: tokens, total_tokens: "private-metadata" } });
        assert.equal((await invoke(getPlaylist, { mood: musicalFitRequest })).status, 502);
        assert.equal(validationDiagnostic().completionTokens, Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined);
        assert.equal(requests.length, 1);
    });
}

test("validation diagnostics: success adds no failure event or provider call", async () => {
    aiReply(fourteenCandidateFixture());
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(console.error.mock.calls.filter(call => call.arguments[0] === "PLAYLIST VALIDATION DIAGNOSTIC:").length, 0);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

test("validation diagnostics: ordinary mood shortage preserves the previous public error and ten-song contract", async () => {
    const songs = musicalFitSongs(); songs[2] = songs[1];
    aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood: "Quiet company in grief, with room for mixed feelings." });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    const diagnostic = validationDiagnostic();
    assert.equal(diagnostic.category, "insufficient_eligible_songs"); assert.equal(diagnostic.expectedCandidateCount, 10);
    assert.equal(diagnostic.expectedAssessmentCount, undefined); assert.equal(diagnostic.eligibleSongCount, 9);
    assert.equal(requests.length, 1);
});

for (const length of [undefined, 10]) test(`reserve pool: requests fourteen candidates and returns ten within one call (length: ${length})`, async () => {
    const playlist = fourteenCandidateFixture(); aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, ...(length ? { length } : {}) });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, playlist.songs.slice(0, 10));
    const sent = JSON.parse(requests[0][1].body), schema = sent.response_format.json_schema.schema;
    const context = JSON.parse(sent.messages[1].content);
    assert.equal(context.length, 10); assert.equal(context.candidateCount, 14);
    assert.equal(schema.properties.songs.minItems, 14); assert.equal(schema.properties.songs.maxItems, 14);
    assert.equal(schema.properties.musicalFit.properties.assessments.maxItems, 14);
    assert.equal(schema.properties.explanation.properties.connections.items.properties.songIndex.maximum, 13);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(sent.model, "gpt-4o-mini");
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    const counts = fitCounters();
    assert.equal(counts.candidateCount, 14); assert.equal(counts.selectedCount, 10);
    assert.equal(counts.notSelected, 4); assert.equal(counts.duplicate, 0, "Anchor prepending is not a model duplicate");
});

test("reserve pool: two musically weak candidates are replaced without weakening the primary requirement", async () => {
    const playlist = fourteenCandidateFixture();
    setPrimaryMismatch(playlist, 1); setPrimaryMismatch(playlist, 2);
    playlist.explanation = { connections: [
        { songIndex: 1, emotionalTheme: "passion", musicalTrait: "powerful vocal delivery" },
        { songIndex: 10, emotionalTheme: "vulnerability", musicalTrait: "expressive vocals" }
    ] };
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(3, 12)]);
    assert.equal(result.body.playlist.explanation, fitConnectionText(playlist.songs[10], "vulnerability"));
    const counts = fitCounters(); assert.equal(counts.primaryMismatch, 2); assert.equal(counts.eligibleCandidates, 12);
    assert.equal(counts.selectedCount, 10); assert.equal(counts.notSelected, 2); assert.equal(requests.length, 1);
});

test("reserve pool: duplicates are replaced with distinct reserves and counted once per model occurrence", async () => {
    const playlist = fourteenCandidateFixture(); playlist.songs[2] = playlist.songs[1]; playlist.songs[4] = playlist.songs[3];
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(new Set(result.body.playlist.songs.map(item => JSON.stringify(item))).size, 10);
    assert.equal(fitCounters().duplicate, 2); assert.equal(fitCounters().selectedCount, 10);
});

test("reserve pool: five primary mismatches return a limitation and count the shortage without a retry", async () => {
    const playlist = fourteenCandidateFixture(); [1, 2, 3, 4, 5].forEach(index => setPrimaryMismatch(playlist, index));
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "insufficient_musical_fit");
    assert.equal(result.body.playlist, undefined); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(fitCounters().primaryMismatch, 5); assert.equal(fitCounters().selectedCount, 9);
});

for (const size of [10, 12, 13, 15]) test(`reserve pool: wrong raw model count fails closed, rather than padding or retrying (${size})`, async () => {
    const playlist = fourteenCandidateFixture();
    playlist.songs = playlist.songs.slice(0, size);
    if (size === 15) playlist.songs.push({ song: "Unexpected fifteenth", artist: "Unexpected performer" });
    playlist.musicalFit = musicalFitFixture(playlist.songs);
    fetchImpl = async () => response({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(playlist) } }] });
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined); assert.equal(requests.length, 1);
});

test("reserve pool: malformed reserve assessment disqualifies only its recording", async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[11].judgments = ["match", "unsupported"];
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[11].song));
    assert.equal(fitCounters().assessmentInvalidSupport, 1);
    assert.equal(requests.length, 1);
});

test("reserve pool: stronger declared connections rank above earlier candidates while original explanation indexes remain accurate", async () => {
    const playlist = fourteenCandidateFixture();
    playlist.musicalFit.priorities.push({ dimension: "energy", character: "gradual musical build" });
    playlist.musicalFit.assessments.forEach(item => { item.judgments = ["match", "match", "uncertain"]; });
    for (const index of [10, 11]) Object.assign(playlist.musicalFit.assessments[index], { judgments: ["match", "match", "match"] });
    playlist.explanation = { connections: [
        { songIndex: 10, emotionalTheme: "passion", musicalTrait: "high musical energy" },
        { songIndex: 9, emotionalTheme: "heartbreak", musicalTrait: "expressive vocals" }
    ] };
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...playlist.songs.slice(10, 12), ...playlist.songs.slice(1, 8)]);
    assert.equal(result.body.playlist.explanation, fitConnectionText(playlist.songs[10], "passion"));
    assert.ok(!result.body.choices[0].message.content.includes(playlist.songs[9].song));
});

test("reserve pool: four strong connections mislabeled discovery do not hit the discovery limit", async () => {
    const playlist = fourteenCandidateFixture();
    [1, 2, 3, 4].forEach(index => { playlist.musicalFit.assessments[index].kind = "discovery"; });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, playlist.songs.slice(0, 10));
    assert.equal(fitCounters().labelCorrections, 4); assert.equal(fitCounters().discoveryLimit, 0);
});

test("reserve pool: primary-only connections mislabeled close remain bounded discoveries", async () => {
    const playlist = fourteenCandidateFixture();
    for (const index of [7, 8, 9]) Object.assign(playlist.musicalFit.assessments[index], { judgments: ["match", "different"] });
    [10, 11, 12, 13].forEach(index => setPrimaryMismatch(playlist, index));
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs, playlist.songs.slice(0, 10));
    assert.equal(fitCounters().labelCorrections, 3); assert.equal(fitCounters().primaryMismatch, 4);
});

test("reserve pool: initial discovery preference uses the final ten-song length before bounded backfill", async () => {
    const playlist = fourteenCandidateFixture();
    playlist.musicalFit.assessments.slice(6).forEach(item => Object.assign(item, { kind: "discovery", judgments: ["match", "different"] }));
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(fitCounters().selectedCount, 10); assert.equal(fitCounters().discoveryLimit, 5);
    assert.equal(fitCounters().discoveryBackfill, 1);
});

for (const kind of ["weak", "uncertain"]) test(`reserve pool: contradictory ${kind} labels are counted and never blindly upgraded`, async () => {
    const playlist = fourteenCandidateFixture(); playlist.musicalFit.assessments[1].kind = kind;
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
    assert.equal(fitCounters().classificationConflicts, 1); assert.equal(fitCounters().labelCorrections, 0);
    assert.equal(fitCounters()[kind === "weak" ? "weakAssessment" : "uncertainAssessment"], 1);
});

test("reserve pool: unknown primary support remains disqualifying regardless of close labeling", async () => {
    const playlist = fourteenCandidateFixture();
    Object.assign(playlist.musicalFit.assessments[1], { judgments: ["uncertain", "match"] });
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(fitCounters().primaryUnknown, 1);
    assert.ok(!result.body.playlist.songs.some(item => item.song === playlist.songs[1].song));
});

test("reserve pool: omitted explicit anchor is recovered without an invented assessment or additional call", async () => {
    const playlist = fourteenCandidateFixture(); playlist.songs[0] = { song: "Alternative recording", artist: "Other performer" };
    playlist.requestedSongs = []; playlist.explanation = explanationConnections(0);
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [anchor], recentSongs: [anchor] });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.songs.length, 10); assert.equal(fitCounters().recoveredExplicit, 1);
    assert.equal(fitCounters().explicitAssessmentBypass, 1);
    assert.ok(!result.body.playlist.explanation.includes(anchor.song));
    const context = JSON.parse(JSON.parse(requests[0][1].body).messages[1].content);
    assert.deepEqual(context.avoidSongs, []); assert.equal(context.recentSongs, undefined); assert.equal(requests.length, 1);
});

for (const exclusion of [" Don't play Lose Control.", " Do not include any songs by Teddy Swims."]) {
    test(`reserve pool: current exclusions still defeat explicit recovery:${exclusion}`, async () => {
        const playlist = fourteenCandidateFixture(); aiReply(playlist);
        const result = await invoke(getPlaylist, { mood: musicalFitRequest + exclusion });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.artist === anchor.artist));
        assert.match(result.body.playlist.requestNotice, /current exclusions/); assert.equal(fitCounters().excluded, 1);
    });
}

test("reserve pool: historical and continuation exclusions consume reserves without creating artist bans", async () => {
    const playlist = fourteenCandidateFixture(); playlist.songs[10].artist = playlist.songs[1].artist;
    aiReply(playlist); const result = await invoke(getPlaylist, { mood: musicalFitRequest,
        avoidSongs: [playlist.songs[1]], existingSongs: [playlist.songs[2]] });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(result.body.playlist.songs.some(item => item.song === playlist.songs[10].song));
    assert.equal(fitCounters().excluded, 2); assert.equal(fitCounters().eligibleCandidates, 12);
});

test("reserve pool: ordinary mood requests cannot opt themselves into larger output through client fields", async () => {
    const songs = musicalFitSongs(); aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood: "I feel lonely and relieved, and want quiet company.", candidateCount: 14 });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
    const sent = JSON.parse(requests[0][1].body);
    assert.equal(sent.response_format.json_schema.schema.properties.songs.maxItems, 10);
    assert.equal(JSON.parse(sent.messages[1].content).candidateCount, undefined);
    assert.equal(console.log.mock.calls.filter(call => call.arguments[0] === "MUSICAL FIT VALIDATION:").length, 0);
});

test("reserve pool: truncation never returns a partial playlist or retries within the unchanged budget", async () => {
    aiReply(fourteenCandidateFixture(), { finish_reason: "length" });
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
});

test("musical-fit: close matches retain the default ten songs, bounded schema and one-call budget", async () => {
    const songs = musicalFitSongs();
    aiReply(playlistFixture({ songs, requestedSongs: [anchor], musicalFit: musicalFitFixture(songs) }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, recentSongs: songs, avoidSongs: [anchor] });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
    const sent = JSON.parse(requests[0][1].body), context = JSON.parse(sent.messages[1].content);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    assert.equal(requests[0][0], "https://api.openai.com/v1/chat/completions");
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(sent.model, "gpt-4o-mini");
    assert.deepEqual(context.musicalReferences, [anchor]); assert.deepEqual(context.avoidSongs, []);
    assert.deepEqual(context.recentSongs, songs.slice(1));
    const schema = sent.response_format.json_schema.schema.properties.musicalFit;
    assert.equal(schema.properties.priorities.minItems, 2); assert.equal(schema.properties.priorities.maxItems, 3);
    assert.equal(schema.properties.priorities.items.properties.character.maxLength, 80);
    assert.equal(schema.properties.assessments.minItems, 14); assert.equal(schema.properties.assessments.maxItems, 14);
    assert.match(sent.messages[0].content, /unverified model judgments/);
    assert.match(sent.messages[0].content, /Do not invent BPM, measured audio features, verified lyrical analysis/);
    assert.equal(result.body.playlist.musicalFit, undefined, "Internal judgments are not an audio-analysis API");
});

for (const phrase of [
    'Find songs that sound like "Lose Control" by Teddy Swims.',
    'Find songs that sound similar to "Lose Control" by Teddy Swims.',
    'Find music sonically similar to "Lose Control" by Teddy Swims.',
    'Find music similar in sound to "Lose Control" by Teddy Swims.'
]) test(`musical-fit: recognizes a sound reference without making it a mandatory inclusion: ${phrase}`, async () => {
    const songs = musicalFitSongs().slice(1); songs.push({ song: "Another fixture", artist: "Another artist" });
    aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood: phrase });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(JSON.parse(requests[0][1].body).messages[1].content).musicalReferences, [anchor]);
    assert.equal(result.body.playlist.songs.some(item => item.song === anchor.song), false);
});

test("musical-fit: thoughtful discovery can differ in genre while sharing the primary vocal connection", async () => {
    const songs = [anchor, other], fit = musicalFitFixture(songs);
    fit.priorities[1] = { dimension: "genre", character: "soul and blues influences" };
    fit.assessments[1] = { songIndex: 1, kind: "discovery", judgments: ["match", "different"] };
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, length: 2 });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
});

for (const kind of ["weak", "close", "discovery", "uncertain"]) {
    test(`musical-fit: emotional overlap cannot rescue a mismatched primary vocal requirement (${kind})`, async () => {
        const songs = musicalFitSongs(); songs[1] = { song: "Supermarket Flowers", artist: "Ed Sheeran" };
        const fit = musicalFitFixture(songs);
        fit.assessments[1] = { songIndex: 1, kind, judgments: ["different", "match"] };
        aiReply(playlistFixture({ songs, musicalFit: fit, explanation: explanationConnections(1, "passion", "powerful vocal delivery") }));
        const result = await invoke(getPlaylist, { mood: musicalFitRequest });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.ok(!result.body.playlist.songs.some(item => item.song === songs[1].song && item.artist === songs[1].artist));
        assert.doesNotMatch(result.body.playlist.explanation, /Supermarket Flowers|powerful vocal delivery/);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

test("musical-fit: the same Ed Sheeran recording remains eligible for an ordinary emotional request", async () => {
    const songs = musicalFitSongs(); songs[1] = { song: "Supermarket Flowers", artist: "Ed Sheeran" };
    aiReply(playlistFixture({ songs }));
    const result = await invoke(getPlaylist, { mood: "I want quiet company in grief, with room for tenderness." });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
    const sent = JSON.parse(requests[0][1].body);
    assert.equal(sent.response_format.json_schema.schema.properties.musicalFit, undefined);
    assert.equal(JSON.parse(sent.messages[1].content).musicalReferences, undefined);
});

for (const mood of [
    "I feel judged by everyone and want a similar feeling of companionship, with quiet vocals.",
    "Play Lose Control by Teddy Swims and find similar emotions, even across different genres.",
    "I love Lose Control by Teddy Swims. I do not want musically similar songs, only the feeling.",
    "Find music with similar groove and energy. I'm lonely, without a particular recording in mind.",
    "I feel lonely. I want similar energy to yesterday, but don't play Lose Control by Teddy Swims."
]) test(`musical-fit: emotional or reference-free requests keep the flexible response contract: ${mood}`, async () => {
    aiReply(playlistFixture({ songs: [...musicalFitSongs().slice(1), { song: "Another fixture", artist: "Another artist" }] }));
    assert.equal((await invoke(getPlaylist, { mood })).status, 200);
    assert.equal(JSON.parse(requests[0][1].body).response_format.json_schema.schema.properties.musicalFit, undefined);
});

test("musical-fit: an omitted explicit anchor overrides historical dislike and weak fit without inventing an explanation", async () => {
    const songs = musicalFitSongs().slice(1); songs.push({ song: "Trimmed fixture", artist: "Fixture artist" });
    const fit = musicalFitFixture(songs); fit.assessments[9] = { songIndex: 9, kind: "weak", judgments: ["different", "different"] };
    aiReply(playlistFixture({ songs, musicalFit: fit, explanation: explanationConnections(9) }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [anchor], recentSongs: [anchor] });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, [anchor, ...songs.slice(0, 9)]);
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
});

test("musical-fit: a present explicit anchor cannot be vetoed by an uncertain musical assessment", async () => {
    const songs = musicalFitSongs(), fit = musicalFitFixture(songs);
    fit.assessments[0] = { songIndex: 0, kind: "uncertain", judgments: ["uncertain", "uncertain"] };
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, avoidSongs: [anchor] });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.explanation, "A song-specific explanation is unavailable for this final playlist.");
});

for (const exclusion of [" Don't play Lose Control.", " Do not include any songs by Teddy Swims."]) {
    test(`musical-fit: current exclusion defeats automatic anchor recovery:${exclusion}`, async () => {
        const songs = musicalFitSongs().slice(1); songs.push({ song: "Another fixture", artist: "Another artist" });
        aiReply(playlistFixture({ songs, requestedSongs: [anchor], musicalFit: musicalFitFixture(songs) }));
        const result = await invoke(getPlaylist, { mood: musicalFitRequest + exclusion });
        assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
        assert.match(result.body.playlist.requestNotice, /current exclusions/);
    });
}

test("musical-fit: exclusion cannot be ignored merely because a recommended candidate is a close match", async () => {
    const songs = musicalFitSongs(); songs[1] = { song: "Excluded fixture", artist: "Excluded artist" };
    aiReply(playlistFixture({ songs, musicalFit: musicalFitFixture(songs) }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest + ' Do not play "Excluded fixture" by Excluded artist.' });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === "Excluded fixture"));
    assert.equal(requests.length, 1);
});

test("musical-fit: unsupported explanation labels and raw character claims are never rendered", async () => {
    const songs = musicalFitSongs(), fit = musicalFitFixture(songs);
    fit.priorities[0].character = "VERIFIED 999 BPM PRIVATE-UNSUPPORTED-CLAIM";
    fit.priorities.push({ dimension: "energy", character: "driving build" });
    fit.assessments.forEach(item => { item.judgments = ["match", "match", "uncertain"]; });
    aiReply(playlistFixture({ songs, musicalFit: fit, explanation: explanationConnections(1, "passion", "high musical energy") }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.explanation, fitConnectionText(songs[1], "passion"));
    assert.doesNotMatch(JSON.stringify(result.body), /999|VERIFIED|PRIVATE-UNSUPPORTED|high musical energy/);
});

test("musical-fit: uncertain-only connections cannot qualify, even if labeled close", async () => {
    const songs = musicalFitSongs(), fit = musicalFitFixture(songs);
    fit.assessments[1] = { songIndex: 1, kind: "close", judgments: ["uncertain", "uncertain"] };
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === songs[1].song));
});

test("musical-fit: validated primary-only discoveries can fill the playlist without being relabeled close", async () => {
    const songs = musicalFitSongs(), fit = musicalFitFixture(songs);
    fit.assessments.slice(1).forEach(item => { item.kind = "discovery"; item.judgments = ["match", "different"]; });
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.equal(fitCounters().discoveryBackfill, 2); assert.equal(fitCounters().labelCorrections, 0);
    assert.equal(requests.length, 1);
});

test("musical-fit: duplicate identities cannot conceal an earlier weak assessment", async () => {
    const songs = musicalFitSongs(); songs[2] = songs[1];
    const fit = musicalFitFixture(songs);
    fit.assessments[1] = { songIndex: 1, kind: "weak", judgments: ["different", "match"] };
    aiReply(playlistFixture({ songs, musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.ok(!result.body.playlist.songs.some(item => item.song === songs[1].song));
});

for (const [name, alter] of [
    ["missing fit", p => { p.musicalFit = undefined; }],
    ["wrong reference artist", p => { p.musicalFit.reference = { ...anchor, artist: "Wrong artist" }; }],
    ["only one priority", p => { p.musicalFit.priorities.pop(); }],
    ["too many priorities", p => { p.musicalFit.priorities.push(...p.musicalFit.priorities); }],
    ["duplicate priority dimensions", p => { p.musicalFit.priorities[1].dimension = "vocals"; }],
    ["unknown dimension", p => { p.musicalFit.priorities[0].dimension = "__proto__"; }],
    ["overlong character", p => { p.musicalFit.priorities[0].character = "x".repeat(81); }],
    ["non-array assessments", p => { p.musicalFit.assessments = null; }]
]) test(`musical-fit: malformed assessments fail closed without retry (${name})`, async () => {
    const songs = musicalFitSongs(), playlist = playlistFixture({ songs, musicalFit: musicalFitFixture(songs) });
    alter(playlist); aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(result.body.playlist, undefined); assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
});

test("musical-fit: truncation at the unchanged token ceiling fails without fallback or another call", async () => {
    aiReply(playlistFixture({ songs: musicalFitSongs() }), { finish_reason: "length" });
    const result = await invoke(getPlaylist, { mood: musicalFitRequest });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(requests.length, 1); assert.equal(JSON.parse(requests[0][1].body).max_completion_tokens, 3072);
});

for (const mood of [
    'Play "Play It Again" by Luke Bryan and recommend songs with similar sound.',
    'Play It Again by Luke Bryan and recommend songs with similar sound.',
    'Please play "Listen to Your Heart" by Roxette and recommend songs with similar sound.'
]) test(`musical-fit: full command-like titles retain their identity: ${mood}`, async () => {
    const reference = mood.includes("Luke Bryan") ? { song: "Play It Again", artist: "Luke Bryan" }
        : { song: "Listen to Your Heart", artist: "Roxette" };
    const songs = [reference, ...musicalFitSongs().slice(1)];
    aiReply(playlistFixture({ songs, requestedSongs: [reference], musicalFit: musicalFitFixture(songs, reference) }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], reference);
});

test("musical-fit: maximum existing playlist length remains supported by the compact conditional schema", async () => {
    const songs = [anchor, ...Array.from({ length: 24 }, (_, i) => ({ song: `Track ${i}`, artist: `Artist ${i}` }))];
    const playlist = playlistFixture({ songs, musicalFit: musicalFitFixture(songs) });
    aiReply(playlist);
    const result = await invoke(getPlaylist, { mood: musicalFitRequest, length: 25 });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 25);
    assert.ok(JSON.stringify(playlist.musicalFit).length < 3000, "Compact fixture size is not a live tokenizer or success guarantee");
    const sent = JSON.parse(requests[0][1].body);
    assert.equal(sent.max_completion_tokens, 3072); assert.equal(requests.length, 1);
});

test("musical-fit: a resolved full title cannot be assessed using its incorrect shortened identity", async () => {
    const reference = { song: "Play It Again", artist: "Luke Bryan" }, songs = [reference, ...musicalFitSongs().slice(1)];
    const fit = musicalFitFixture(songs, { song: "It Again", artist: "Luke Bryan" });
    aiReply(playlistFixture({ songs, requestedSongs: [reference], musicalFit: fit }));
    const result = await invoke(getPlaylist, { mood: 'Play It Again by Luke Bryan and recommend songs with similar sound.' });
    assert.equal(result.status, 502); assert.equal(result.body.reason, "invalid_playlist_response");
    assert.equal(requests.length, 1);
});

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
        assert.equal(result.body.playlist.explanation, connectionText(anchor));
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
    const explanation = explanationConnections();
    aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
    assert.equal(new Set(result.body.playlist.songs.map(item => item.artist)).size, 10);
    assert.equal(result.body.playlist.explanation, connectionText(complementaryRecordings[0]));
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
    const explanation = { connections: [
        { songIndex: 0, emotionalTheme: "longing", musicalTrait: "restrained vocals" },
        { songIndex: 1, emotionalTheme: "relief", musicalTrait: "groove and rhythm" }
    ] };
    aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
    const result = await invoke(getPlaylist, { mood, likedSongs: [other], avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.explanation, connectionText(complementaryRecordings[0], "longing", "restrained vocals") + " " +
        connectionText(complementaryRecordings[1], "relief", "groove and rhythm"));
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

const balancedSongRequest = "Play Lose Control by Teddy Swims and recommend songs with similar emotions, genres, vocal intensity, and soulful musical style.";

test("the existing curator receives balanced criteria and indexed explanation data without adding calls", async () => {
    aiReply(playlistFixture({ songs: [anchor, ...complementaryRecordings.slice(0, 9)] }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(assertCohesiveCuratorRequest(balancedSongRequest).requiredSongs, [anchor]);
    const sent = JSON.parse(requests[0][1].body);
    const instructions = sent.messages[0].content;
    for (const criterion of [
        /When a specific recording guides the request/,
        /emotional themes and lyrical meaning/,
        /primary genre and secondary genre influences/,
        /vocal characteristics and expressive delivery/,
        /tempo feel, groove, rhythm and instrumentation/,
        /musical energy and emotional intensity/,
        /overall sonic similarity/,
        /both the emotional feeling and musical character/,
        /shared lyrical themes alone are insufficient/,
        /most complementary recommendations musically close/,
        /smaller number of thoughtful cross-genre discoveries/,
        /Do not let variety override explicit artist or genre restrictions/,
        /repetitive or redundant recommendations in the supplied context/,
        /briefly explain both the emotional and musical connection/,
        /qualitative descriptions and acknowledge uncertainty/,
        /do not invent precise BPM values, audio measurements/,
        /or claim verified musical characteristics from listening or analysis that has not occurred/,
        /soulful vocals, blues and R&B influences, passionate delivery, emotional vulnerability and musical intensity/
    ]) assert.match(instructions, criterion);
    const schema = sent.response_format.json_schema.schema;
    assert.deepEqual(Object.keys(schema.properties.songs.items.properties).sort(), ["artist", "song"]);
    assert.deepEqual(schema.required, ["intro", "requestedSongs", "inclusionRequested", "unavailableRequestedSongs", "songs", "explanation", "musicalFit"]);
    assert.equal(schema.properties.songs.minItems, 14);
    assert.equal(schema.properties.songs.maxItems, 14);
    assert.equal(schema.properties.explanation.type, "object");
    assert.deepEqual(schema.properties.explanation.required, ["connections"]);
    assert.equal(schema.properties.explanation.properties.connections.maxItems, 3);
    assert.equal(schema.properties.explanation.properties.connections.items.properties.songIndex.maximum, 13);
    assert.equal(schema.properties.explanation.additionalProperties, false);
});

for (const modelIncludesAnchor of [true, false]) {
    test(`balanced music guidance preserves the explicit anchor despite a historical dislike (model inclusion: ${modelIncludesAnchor})`, async () => {
        const explanation = explanationConnections(0, "vulnerability", "powerful vocal delivery");
        aiReply(playlistFixture({
            requestedSongs: modelIncludesAnchor ? [anchor] : [],
            songs: modelIncludesAnchor ? [anchor, ...complementaryRecordings.slice(0, 9)] : complementaryRecordings,
            explanation
        }));
        const body = { mood: balancedSongRequest, avoidSongs: [anchor], likedSongs: [other] };
        const original = JSON.stringify(body);
        const result = await invoke(getPlaylist, body);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
        assert.equal(new Set(result.body.playlist.songs.map(item => item.artist)).size, 10);
        assert.equal(result.body.playlist.explanation, fitConnectionText(modelIncludesAnchor ? anchor : complementaryRecordings[0], "vulnerability"));
        assert.equal(result.body.playlist.requestNotice, undefined);
        const context = assertCohesiveCuratorRequest(balancedSongRequest);
        assert.deepEqual(context.requiredSongs, [anchor]);
        assert.deepEqual(context.avoidSongs, []);
        assert.deepEqual(context.likedSongs, [other]);
        assert.equal(JSON.stringify(body), original);
    });
}

for (const restriction of ["Keep every song by Teddy Swims.", "Only soul and blues; no genre excursions."]) {
    test(`balanced music guidance leaves the listener's explicit restriction intact: ${restriction}`, async () => {
        const mood = balancedSongRequest + " " + restriction;
        const complements = restriction.startsWith("Keep every")
            ? complementaryRecordings.map(item => ({ ...item, artist: anchor.artist })) : complementaryRecordings;
        const songs = [anchor, ...complements.slice(0, 9)];
        aiReply(playlistFixture({ requestedSongs: [anchor], songs }));
        const result = await invoke(getPlaylist, { mood });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, songs);
        assertCohesiveCuratorRequest(mood);
    });
}

for (const mood of [
    balancedSongRequest + " Do not include any songs by Teddy Swims.",
    balancedSongRequest + " Don't play Lose Control.",
    "Only recommend similar songs to Lose Control by Teddy Swims, with similar emotions, genres, vocal intensity, and soulful musical style."
]) {
    test(`balanced music guidance cannot reinsert a currently excluded reference: ${mood}`, async () => {
        aiReply(playlistFixture({ requestedSongs: [anchor], songs: complementaryRecordings }));
        const result = await invoke(getPlaylist, { mood, avoidSongs: [anchor] });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, complementaryRecordings);
        assertCohesiveCuratorRequest(mood);
    });
}

test("similarity guidance preserves mixed feelings and a request for lower musical energy", async () => {
    const mood = balancedSongRequest + " I miss someone and feel relieved. Keep the music quieter and less energetic; no forced hopeful ending.";
    const explanation = explanationConnections(0, "mixed feelings", "low musical energy");
    aiReply(playlistFixture({ requestedSongs: [anchor], songs: [anchor, ...complementaryRecordings.slice(0, 9)], explanation }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.equal(result.body.playlist.explanation, fitConnectionText(anchor, "mixed feelings"));
    assertCohesiveCuratorRequest(mood);
    assert.match(JSON.parse(requests[0][1].body).messages[0].content, /Treat musical energy and emotional intensity separately/);
    assert.match(JSON.parse(requests[0][1].body).messages[0].content, /Honor requests for a quieter or less energetic experience/);
});

test("recording-specific similarity guidance does not turn ordinary emotional discovery into a song request", async () => {
    const mood = "I feel lonely and relieved after leaving, and want quiet company in both feelings.";
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, complementaryRecordings);
    assert.equal(result.body.playlist.requestNotice, undefined);
    assert.equal(assertCohesiveCuratorRequest(mood).requiredSongs, undefined);
});

test("the curator prioritizes distinctive reference traits without fixed artists or an all-traits requirement", async () => {
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
    assertCohesiveCuratorRequest(balancedSongRequest);
    const instructions = JSON.parse(requests[0][1].body).messages[0].content;
    assert.match(instructions, /two or three most distinctive musical characteristics/);
    assert.match(instructions, /vocal power and expressive delivery/);
    assert.match(instructions, /musical intensity and dynamic build-up/);
    assert.match(instructions, /Do not require every recommendation to match every characteristic/);
    assert.match(instructions, /cross-genre discoveries can connect through different combinations/);
    assert.match(instructions, /listener's preferences and desired energy still take priority/);
    assert.doesNotMatch(instructions, /Tennessee Whiskey|Chris Stapleton|Rag.n.Bone Man|Train Wreck|James Arthur/);
});

test("the reported ten-song example renders only final song references, never an invented Need You Now reference", async () => {
    const songs = [anchor,
        { song: "I Can't Stand the Rain", artist: "Ann Peebles" },
        { song: "Love on the Brain", artist: "Rihanna" },
        { song: "Come Away With Me", artist: "Norah Jones" },
        { song: "Ain't No Sunshine", artist: "Bill Withers" },
        { song: "Cry For Me", artist: "Julia Michaels" },
        { song: "Back to Black", artist: "Amy Winehouse" },
        { song: "The Thrill Is Gone", artist: "B.B. King" },
        { song: "Electric Field", artist: "Dámaso Pérez Prado" },
        { song: "I'll Be Around", artist: "The Spinners" }];
    aiReply(playlistFixture({ songs, explanation: { connections: [
        { songIndex: 0, emotionalTheme: "vulnerability", musicalTrait: "powerful vocal delivery" },
        { songIndex: 2, emotionalTheme: "passion", musicalTrait: "dynamic build-up" }
    ] } }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, songs);
    assert.equal(result.body.playlist.explanation,
        fitConnectionText(anchor, "vulnerability") + " " + fitConnectionText(songs[2], "passion"));
    assert.doesNotMatch(result.body.choices[0].message.content, /Need You Now/);
    assertCohesiveCuratorRequest(balancedSongRequest);
});

test("recovery resolves explanation indexes against original identities and discards a trimmed-out song", async () => {
    aiReply(playlistFixture({ songs: complementaryRecordings, explanation: { connections: [
        { songIndex: 9, emotionalTheme: "heartbreak", musicalTrait: "dynamic build-up" },
        { songIndex: 0, emotionalTheme: "vulnerability", musicalTrait: "expressive vocals" }
    ] } }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest, avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
    assert.equal(result.body.playlist.explanation, fitConnectionText(complementaryRecordings[0], "vulnerability"));
    assert.doesNotMatch(result.body.playlist.explanation, /Synthetic Complement 10|dynamic build-up|Lose Control/);
    assertCohesiveCuratorRequest(balancedSongRequest);
});

for (const exclusion of ["current title", "current artist", "historical dislike", "continuation"]) {
    test(`explanation connections to a removed recording are discarded after ${exclusion} filtering`, async () => {
        const mood = balancedSongRequest + (exclusion === "current title" ? ' Do not play "Someone Like You" by Adele.'
            : exclusion === "current artist" ? " Do not include any songs by Adele." : "");
        const options = exclusion === "historical dislike" ? { avoidSongs: [other] }
            : exclusion === "continuation" ? { existingSongs: [other] } : {};
        aiReply(playlistFixture({ songs: [other, ...complementaryRecordings.slice(0, 9)], explanation: { connections: [
            { songIndex: 0, emotionalTheme: "heartbreak", musicalTrait: "powerful vocal delivery" },
            { songIndex: 1, emotionalTheme: "longing", musicalTrait: "groove and rhythm" }
        ] } }));
        const result = await invoke(getPlaylist, { mood, ...options });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
        assert.equal(result.body.playlist.explanation, fitConnectionText(complementaryRecordings[0]));
        assert.doesNotMatch(result.body.playlist.explanation, /Someone Like You|Adele|heartbreak|powerful vocal delivery/);
        assertCohesiveCuratorRequest(mood);
    });
}

test("duplicate removal does not repeat explanations or transfer their traits to another song", async () => {
    aiReply(playlistFixture({ songs: [other, other, ...complementaryRecordings.slice(0, 8)], explanation: { connections: [
        { songIndex: 0, emotionalTheme: "longing", musicalTrait: "expressive vocals" },
        { songIndex: 1, emotionalTheme: "hope", musicalTrait: "dynamic build-up" },
        { songIndex: 2, emotionalTheme: "relief", musicalTrait: "restrained vocals" }
    ] } }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, other, ...complementaryRecordings.slice(0, 8)]);
    assert.equal(result.body.playlist.explanation, fitConnectionText(other) + " " +
        fitConnectionText(complementaryRecordings[0], "relief"));
    assert.equal(result.body.playlist.explanation.match(/Someone Like You/g).length, 1);
    assert.doesNotMatch(result.body.playlist.explanation, /hope|dynamic build-up/);
    assertCohesiveCuratorRequest(balancedSongRequest);
});

test("explanation identity never transfers attributes from a shortened command-like title", async () => {
    const full = { song: "Play It Again", artist: "Luke Bryan" };
    const shortened = { song: "It Again", artist: "Luke Bryan" };
    aiReply(playlistFixture({ requestedSongs: [full], songs: [shortened, ...complementaryRecordings.slice(0, 9)],
        explanation: { connections: [
            { songIndex: 0, emotionalTheme: "passion", musicalTrait: "powerful vocal delivery" },
            { songIndex: 1, emotionalTheme: "longing", musicalTrait: "groove and rhythm" }
        ] } }));
    const mood = "Play It Again by Luke Bryan and recommend songs with related emotion and sound.";
    const result = await invoke(getPlaylist, { mood });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [full, ...complementaryRecordings.slice(0, 9)]);
    assert.equal(result.body.playlist.explanation, connectionText(complementaryRecordings[0], "longing", "groove and rhythm"));
    assertCohesiveCuratorRequest(mood);
});

for (const explanation of [{ connections: [] }, explanationConnections(9)]) {
    test(`uncertain or entirely trimmed explanation data receives an honest fallback: ${JSON.stringify(explanation)}`, async () => {
        aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
        const result = await invoke(getPlaylist, { mood: balancedSongRequest });
        assert.equal(result.status, 200);
        assert.equal(result.body.playlist.songs.length, 10);
        assert.deepEqual(result.body.playlist.songs[0], anchor);
        assert.equal(result.body.playlist.explanation,
            "A song-specific explanation is unavailable for this final playlist.");
        assertCohesiveCuratorRequest(balancedSongRequest);
    });
}

test("song indexes preserve the exact artist, case and punctuation of the final recording", async () => {
    const recording = { song: 'A "Quoted" Song', artist: "Synthetic Artist & Guest" };
    aiReply(playlistFixture({ songs: [recording], explanation: explanationConnections(0, "mixed feelings", "contrasting dynamics") }));
    const result = await invoke(getPlaylist, { mood: "I want company in conflicting feelings.", length: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.body.playlist.explanation,
        '"A \\"Quoted\\" Song" by Synthetic Artist & Guest offers a connection through mixed feelings and contrasting dynamics.');
    assert.equal(typeof result.body.playlist.explanation, "string");
    assert.equal(requests.length, 1);
    assert.equal(detailRequests.length, 0);
});

for (const explanation of [
    "Need You Now captures this playlist's longing.",
    { connections: [ { songIndex: 0, emotionalTheme: "Need You Now", musicalTrait: "expressive vocals" } ] },
    { connections: [ { songIndex: 0, emotionalTheme: "longing", musicalTrait: "verified 87 BPM" } ] },
    { connections: [ { songIndex: 0, emotionalTheme: "longing", musicalTrait: "expressive vocals", song: "Need You Now" } ] },
    { ...explanationConnections(), text: "Need You Now belongs in this playlist." },
    ...[-1, 14, 0.5, "0"].map(index => explanationConnections(index)),
    { connections: [null] },
    { connections: Array.from({ length: 4 }, () => explanationConnections().connections[0]) },
    { connections: [] , untrusted: true }
]) {
    test(`malformed or ungrounded explanation data fails closed without a retry: ${JSON.stringify(explanation)}`, async () => {
        aiReply(playlistFixture({ songs: complementaryRecordings, explanation }));
        const result = await invoke(getPlaylist, { mood: balancedSongRequest });
        assert.equal(result.status, 502);
        assert.equal(result.body.reason, "invalid_playlist_response");
        assert.equal(result.body.playlist, undefined);
        assert.doesNotMatch(JSON.stringify(result.body), /Need You Now|87 BPM/);
        assert.equal(requests.length, 1);
        assert.equal(detailRequests.length, 0);
    });
}

test("recent-song context is capped, sanitized, and kept separate from hard exclusions", async () => {
    const recentSongs = Array.from({ length: 35 }, (_, index) => ({ song: ` Recent ${index} `, artist: " Recent Artist ",
        recommendedAt: 1800000000000, mood: "DO-NOT-FORWARD", extra: "discard" }));
    const original = JSON.stringify(recentSongs);
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest, recentSongs });
    assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
    assert.deepEqual(result.body.playlist.songs[0], anchor);
    const context = assertCohesiveCuratorRequest(balancedSongRequest);
    assert.equal(context.recentSongs.length, 30);
    assert.deepEqual(context.recentSongs[0], { song: "Recent 0", artist: "Recent Artist" });
    assert.deepEqual(context.recentSongs[29], { song: "Recent 29", artist: "Recent Artist" });
    assert.ok(context.recentSongs.every(item => Object.keys(item).sort().join(",") === "artist,song"));
    assert.deepEqual(context.existingSongs, []); assert.deepEqual(context.avoidSongs, []);
    assert.equal(JSON.stringify(recentSongs), original);
    assert.doesNotMatch(JSON.stringify(context), /recommendedAt|DO-NOT-FORWARD|discard/);
    const instructions = JSON.parse(requests[0][1].body).messages[0].content;
    assert.match(instructions, /not dislikes or hard exclusions/);
    assert.match(instructions, /allow repeats when needed/);
    assert.match(instructions, /Explicit current inclusions override recency/);
    assert.match(instructions, /Never turn recentSongs into artist-wide or genre-wide bans/);
    assert.match(instructions, /do not sacrifice the listener's preferences or the requested playlist length for novelty/);
});

for (const recentSongs of [null, "not an array", {}, [null, { song: {}, artist: "Artist" }],
    [{ song: "Bad\nTitle", artist: "Artist" }, { song: "x".repeat(121), artist: "Artist" }, { song: " ", artist: "Artist" }]]) {
    test(`malformed optional recent context is ignored without blocking a valid playlist: ${JSON.stringify(recentSongs)}`, async () => {
        aiReply(playlistFixture({ songs: complementaryRecordings }));
        const result = await invoke(getPlaylist, { mood: balancedSongRequest, recentSongs });
        assert.equal(result.status, 200); assert.equal(result.body.playlist.songs.length, 10);
        assert.equal(assertCohesiveCuratorRequest(balancedSongRequest).recentSongs, undefined);
    });
}

test("recent identities deduplicate by title and artist without banning other recordings by that artist", async () => {
    const recentSongs = [{ song: " Ｒｅｃｅｎｔ ", artist: " Artist " }, { song: "recent", artist: "artist" },
        { song: "Recent", artist: "Other Artist" }, { song: "Another Recording", artist: anchor.artist }];
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest, recentSongs });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs[0], anchor);
    assert.deepEqual(assertCohesiveCuratorRequest(balancedSongRequest).recentSongs, [recentSongs[0], recentSongs[2], recentSongs[3]]
        .map(item => ({ song: item.song.trim(), artist: item.artist.trim() })));
});

test("narrow artist and genre preferences may repeat recent recordings without rejection or a second call", async () => {
    const mood = balancedSongRequest + " Only Teddy Swims, in soul and blues styles.";
    const songs = [anchor, ...complementaryRecordings.slice(0, 9).map(item => ({ ...item, artist: anchor.artist }))];
    aiReply(playlistFixture({ requestedSongs: [anchor], songs, explanation: explanationConnections(1, "vulnerability", "groove and rhythm") }));
    const result = await invoke(getPlaylist, { mood, recentSongs: songs });
    assert.equal(result.status, 200); assert.deepEqual(result.body.playlist.songs, songs);
    assert.equal(result.body.playlist.explanation, fitConnectionText(songs[1], "vulnerability"));
    const context = assertCohesiveCuratorRequest(mood);
    assert.deepEqual(context.recentSongs, songs.slice(1));
    assert.deepEqual(context.avoidSongs, []); assert.deepEqual(context.existingSongs, []);
});

test("current explicit inclusion overrides both recency and historical dislike when the model omits the anchor", async () => {
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest, recentSongs: [anchor, complementaryRecordings[0]], avoidSongs: [anchor] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(0, 9)]);
    const context = assertCohesiveCuratorRequest(balancedSongRequest);
    assert.deepEqual(context.recentSongs, [complementaryRecordings[0]]);
    assert.deepEqual(context.avoidSongs, []);
});

test("historical dislikes of non-requested songs retain precedence independently of recency", async () => {
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const result = await invoke(getPlaylist, { mood: balancedSongRequest,
        recentSongs: [anchor, complementaryRecordings[0]], avoidSongs: [complementaryRecordings[0]] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.playlist.songs, [anchor, ...complementaryRecordings.slice(1)]);
    assert.deepEqual(assertCohesiveCuratorRequest(balancedSongRequest).avoidSongs, [complementaryRecordings[0]]);
});

for (const kind of ["current title exclusion", "current artist exclusion", "similar-only", "continuation"]) {
    test(`recent context cannot weaken ${kind} precedence`, async () => {
        const mood = kind === "current title exclusion" ? balancedSongRequest + " Don't play Lose Control."
            : kind === "current artist exclusion" ? balancedSongRequest + " Do not include any songs by Teddy Swims."
            : kind === "similar-only" ? "Only recommend similar songs to Lose Control by Teddy Swims." : balancedSongRequest;
        const options = kind === "continuation" ? { existingSongs: [anchor] } : {};
        aiReply(playlistFixture({ requestedSongs: [anchor], songs: complementaryRecordings }));
        const result = await invoke(getPlaylist, { mood, recentSongs: [anchor, ...complementaryRecordings], ...options });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.playlist.songs, complementaryRecordings);
        const context = assertCohesiveCuratorRequest(mood);
        assert.deepEqual(context.avoidSongs, []);
        assert.deepEqual(context.existingSongs, kind === "continuation" ? [anchor] : []);
    });
}

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
    assert.equal(result.body.playlist.explanation, connectionText(recommendations[0]));
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
    assert.equal(result.body.playlist.explanation, connectionText(recommendations[0]));
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
    assert.equal(result.body.playlist.explanation, connectionText(recommendations[0]));
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
    vm.runInContext(functionSource("const PRIVACY_POLICY_VERSION", "function trackTune4Me("), context);
    vm.runInContext("privacyAccepted = true;", context); // Existing musical/playback tests use an agreed visit.
    vm.runInContext(functionSource("async function showMood(button)", "async function continuePlaylist()"), context);
    vm.runInContext(functionSource("const RECENT_RECOMMENDATION_KEY", "// AI"), context);
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
    assert.ok(textOf(ui.elements.result).includes(connectionText(anchor)));
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

test("two fresh homepage generations share bounded recent context but retain one-call ten-song behavior", async () => {
    aiReply(playlistFixture({ songs: complementaryRecordings }));
    const ui = frontend();
    ui.elements.moodInput.value = balancedSongRequest;
    const received = [];
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getPlaylist");
        const body = JSON.parse(options.body); received.push(body);
        const result = await invoke(getPlaylist, body);
        return response(result.body, result.status);
    };
    await ui.context.showMood();
    await ui.context.showMood();
    const expected = [anchor, ...complementaryRecordings.slice(0, 9)];
    assert.deepEqual(received[0].recentSongs, []);
    assert.deepEqual(received[1].recentSongs, expected);
    assert.equal(received[0].existingSongs, undefined); assert.equal(received[1].existingSongs, undefined);
    assert.deepEqual(received[1].avoidSongs, []);
    assert.equal(received[0].length, undefined); assert.equal(received[1].length, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.context.currentPlaylist)), expected);
    assert.equal(requests.length, 2); assert.equal(detailRequests.length, 0);
    assert.ok(requests.every(([url]) => url === "https://api.openai.com/v1/chat/completions"));
    assert.deepEqual(JSON.parse(JSON.parse(requests[1][1].body).messages[1].content).recentSongs, expected.slice(1));
    assert.deepEqual(JSON.parse(ui.storage.get("tune4meRecentRecommendations")).map(({song, artist}) => ({song, artist})), expected);
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
    ui.context.fetch = async (url, options) => { sent = [url, JSON.parse(options.body)]; return response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: "correct____" }); };
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
    ui.context.saveCachedVideo(anchor.song, anchor.artist, "correct____", { madeForKids: false, duration: "PT3M", durationSeconds: 180 });
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
        status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed", madeForKids: false },
        contentDetails: { duration: "PT3M",}, ...overrides };
}

for (const [label, overrides] of [
    ["embedding prohibited", { status: { embeddable: false, privacyStatus: "public", uploadStatus: "processed" } }],
    ["private video", { status: { embeddable: true, privacyStatus: "private", uploadStatus: "processed" } }],
    ["deleted upload", { status: { embeddable: true, privacyStatus: "public", uploadStatus: "deleted" } }],
    ["age restriction", { contentDetails: { duration: "PT3M", contentRating: { ytRating: "ytAgeRestricted" } } }],
    ["blocked region", { contentDetails: { duration: "PT3M", regionRestriction: { blocked: ["US"] } } }],
    ["region not allowed", { contentDetails: { duration: "PT3M", regionRestriction: { allowed: ["CA"] } } }],
    ["blocked everywhere", { contentDetails: { duration: "PT3M", regionRestriction: { allowed: [] } } }]
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
    detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, { contentDetails: { duration: "PT3M", regionRestriction: { blocked: ["US"] } } })] });
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
    ui.context.fetch = async () => response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: exactVideo.id.videoId });
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
    ui.context.saveCachedVideo(anchor.song, anchor.artist, exactVideo.id.videoId, { madeForKids: false, duration: "PT3M", durationSeconds: 180 });
    let sent;
    ui.context.fetch = async (url, options) => {
        sent = JSON.parse(options.body);
        return response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: idFor("alternate") });
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
    ui.context.fetch = async () => response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: requests++ ? idFor("alternate") : exactVideo.id.videoId });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 100 });
    await ui.players[1].events.onError({ data: 100 });
    assert.equal(requests, 2);
    assert.match(textOf(ui.slot), /no longer available/);
});

test("player identification errors do not masquerade as lookup misses or retry songs", async () => {
    const ui = playerFrontend();
    let requests = 0;
    ui.context.fetch = async () => { requests++; return response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: exactVideo.id.videoId }); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 153 });
    assert.equal(requests, 1);
    assert.match(textOf(ui.slot), /verify this player/);
    assert.doesNotMatch(textOf(ui.slot), /find a reliable preview/);
});

test("autoplay blocking keeps the player available and asks the user to press Play", async () => {
    const ui = playerFrontend();
    ui.context.fetch = async () => response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: exactVideo.id.videoId });
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
    finish(response({ video: { madeForKids: false, duration: "PT3M", durationSeconds: 180 }, videoId: exactVideo.id.videoId }));
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
        video: { title: "Teddy Swims - Lose Control", channelTitle: "Teddy Swims", embeddable: true, version: "studio", madeForKids: false, duration: "PT3M", durationSeconds: 180 } }));
    return { ...candidates[0], candidates };
}

for (const [label, duration, seconds] of [
    ["reported 25-second clip", "PT25S", null],
    ["below the minimum", "PT29.9S", null],
    ["30-second short recording", "PT30S", 30],
    ["45-second short recording", "PT45S", 45],
    ["59-second short recording", "PT59S", 59],
    ["minutes and seconds", "PT3M31S", 211],
    ["hours", "PT1H2M3S", 3723],
    ["days", "P1DT1S", 86401],
    ["fractional seconds", "PT30.5S", 30.5],
    ["missing", undefined, null],
    ["null", null, null],
    ["zero", "PT0S", null],
    ["empty", "", null],
    ["empty time", "PT", null],
    ["dangling time", "P1DT", null],
    ["negative", "PT-30S", null],
    ["ambiguous month", "P1M", null],
    ["unsafe number", "PT9007199254740992S", null],
    ["wrong type", { toString: null }, null]
]) {
    test(`duration eligibility uses existing status data without replacement searches: ${label}`, async () => {
        fetchImpl = async () => response({ items: [exactVideo] });
        detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, { contentDetails: { duration } })] });
        const result = await invoke(getYouTubeVideo, anchor);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
        if (seconds === null) {
            assert.equal(result.status, 404); assert.equal(result.body.reason, "unplayable");
            assert.equal(result.body.nextSearchStage, 4); assert.equal(result.body.videoId, undefined);
        } else {
            assert.equal(result.status, 200); assert.equal(result.body.duration, seconds);
            assert.equal(result.body.video.duration, duration); assert.equal(result.body.video.durationSeconds, seconds);
            const cached = await invoke(getYouTubeVideo, anchor);
            assert.equal(cached.body.cacheSource, "server_cache");
            assert.equal(cached.body.duration, seconds); assert.equal(cached.body.video.duration, duration);
            assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
        }
    });
}

test("the existing search/status pool selects a full recording over a 25-second artist-source clip", async () => {
    const clip = video("clip25", "Teddy Swims - Lose Control (Official Audio)");
    const full = video("complete", "Teddy Swims - Lose Control (Official Audio)", "Licensed Music");
    fetchImpl = async () => response({ items: [clip, full] });
    detailsImpl = async () => response({ items: [verifiedVideo(clip, { contentDetails: { duration: "PT25S" } }),
        verifiedVideo(full, { contentDetails: { duration: "PT3M31S" } })] });
    const result = await invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
    assert.equal(result.status, 200); assert.equal(result.body.videoId, full.id.videoId);
    assert.equal(result.body.candidates.length, 1); assert.equal(result.body.video.durationSeconds, 211);
    assert.equal(result.body.nextSearchStage, 4);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
});

test("reported James Arthur request rejects the 25-second result and reuses an existing full recording", async () => {
    const requested = { song: "Say You Won't Let Go", artist: "James Arthur" };
    const clip = video("reported25", "James Arthur - Say you won't let go (Official Audio)", requested.artist);
    const full = video("reportedfull", "James Arthur - Say You Won't Let Go (Official Audio)", requested.artist);
    fetchImpl = async () => response({ items: [clip, full] });
    detailsImpl = async () => response({ items: [verifiedVideo(clip, { contentDetails: { duration: "PT25S" } }),
        verifiedVideo(full, { contentDetails: { duration: "PT3M31S" } })] });
    const result = await invoke(getYouTubeVideo, { ...requested, includeAlternatives: true });
    assert.equal(result.status, 200); assert.equal(result.body.videoId, full.id.videoId);
    assert.equal(result.body.video.durationSeconds, 211);
    assert.equal(result.body.candidates.some(item => item.videoId === clip.id.videoId), false);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
});

test("missing duration is not inferred when a qualified reserve already exists", async () => {
    const reserve = video("reserve", exactVideo.snippet.title);
    fetchImpl = async () => response({ items: [exactVideo, reserve] });
    detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, { contentDetails: {} }), verifiedVideo(reserve)] });
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 200); assert.equal(result.body.videoId, reserve.id.videoId);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
});

for (const label of ["Official Trailer", "Official Teaser", "Official Clip", "Official Preview", "Official Video Excerpt"]) {
    test(`unrequested incomplete presentation cannot masquerade as official audio: ${label}`, async () => {
        fetchImpl = async () => response({ items: [video("present", `Teddy Swims - Lose Control (${label})`)] });
        const result = await invoke(getYouTubeVideo, anchor);
        assert.equal(result.status, 404); assert.equal(result.body.reason, "unplayable");
        assert.equal(result.body.nextSearchStage, 4);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 0);
    });
}

for (const songName of ["Teaser", "Movie Trailer", "A Short Clip", "Preview"]) {
    test(`a genuine short recording keeps a requested title containing presentation words: ${songName}`, async () => {
        const item = video("genuine", `Fixture Artist - ${songName} (Official Audio)`, "Fixture Artist");
        fetchImpl = async () => response({ items: [item] });
        detailsImpl = async () => response({ items: [verifiedVideo(item, { contentDetails: { duration: "PT45S" } })] });
        const result = await invoke(getYouTubeVideo, { song: songName, artist: "Fixture Artist" });
        assert.equal(result.status, 200); assert.equal(result.body.video.durationSeconds, 45);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
    });
}

test("labelled Shorts remain excluded while the same response's ordinary recording is reused", async () => {
    const shorts = video("shorts", "Teddy Swims - Lose Control #Shorts");
    fetchImpl = async () => response({ items: [shorts, exactVideo] });
    const result = await invoke(getYouTubeVideo, anchor);
    assert.equal(result.status, 200); assert.equal(result.body.videoId, exactVideo.id.videoId);
    assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
    assert.ok(!String(detailRequests[0][0]).includes(shorts.id.videoId));
});

test("browser eligibility reuses a full-length returned candidate without another endpoint call", async () => {
    const ui = playerFrontend(); let calls = 0;
    const data = candidateResponse(2); Object.assign(data.candidates[0].video, { duration: "PT25S", durationSeconds: 25 });
    const fullId = data.candidates[1].videoId;
    ui.context.fetch = async () => { calls++; return response(data); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(calls, 1); assert.equal(ui.players.length, 1);
    assert.ok(ui.players[0].iframe.src.includes(fullId));
    assert.equal(ui.context.window.tune4mePreviewLookups.pools.get(ui.context.getVideoCacheKey(anchor.song, anchor.artist)).data.nextSearchStage, 4);
});

test("an embed error after duration backfill cannot reopen replacement searches", async () => {
    const ui = playerFrontend(); let calls = 0;
    const data = candidateResponse(2); Object.assign(data.candidates[0].video, { duration: "PT25S", durationSeconds: 25 });
    data.nextSearchStage = 1;
    ui.context.fetch = async () => { calls++; return response(data); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    await ui.players[0].events.onError({ data: 101 });
    assert.equal(calls, 1); assert.equal(ui.players.length, 1);
    assert.match(textOf(ui.slot), /Listen on YouTube/);
});

test("a duration-rejected browser response ends in the existing fallback without retries", async () => {
    const ui = playerFrontend(); let calls = 0;
    const data = candidateResponse(1); Object.assign(data.video, { duration: "PT25S", durationSeconds: 25 });
    ui.context.fetch = async () => { calls++; return response(data); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(calls, 1); assert.equal(ui.players.length, 0);
    assert.match(textOf(ui.slot), /cannot play here/); assert.match(textOf(ui.slot), /Listen on YouTube/);
    assert.ok(!ui.events.includes("song_preview_opened"));
});

for (const metadata of [{}, { duration: "PT25S", durationSeconds: 25 }, { duration: "PT25S", durationSeconds: 180 }]) {
    test(`a confirmed-playback cache cannot bypass duration checks (${JSON.stringify(metadata)})`, async () => {
        const ui = playerFrontend(); let calls = 0;
        ui.storage.set("savedSongs", JSON.stringify([anchor]));
        ui.storage.set(ui.context.getVideoCacheKey(anchor.song, anchor.artist), JSON.stringify({
            videoId: exactVideo.id.videoId, madeForKids: false, cachedAt: Date.now(), ...metadata }));
        ui.context.fetch = async () => { calls++; throw new Error("No automatic cache refresh"); };
        await ui.context.playSong(anchor.song, anchor.artist, ui.button);
        assert.equal(calls, 0); assert.equal(ui.players.length, 0);
        assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
        assert.deepEqual(JSON.parse(ui.storage.get("savedSongs")), [anchor]);
    });
}

test("confirmed playback retains duration and reuses it without a provider lookup", async () => {
    const ui = playerFrontend(); let calls = 0;
    ui.context.fetch = async () => { calls++; return response(candidateResponse(1)); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.players[0].events.onStateChange({ data: 1 });
    const entry = JSON.parse(ui.storage.get(ui.context.getVideoCacheKey(anchor.song, anchor.artist)));
    assert.equal(entry.duration, "PT3M"); assert.equal(entry.durationSeconds, 180); assert.equal(entry.madeForKids, false);
    ui.button.disabled = false; await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(calls, 1); assert.equal(ui.players.length, 2);
});

test("warm browser pools with no verified duration fail without an endpoint request", async () => {
    const ui = playerFrontend(); let calls = 0;
    const data = candidateResponse(1); delete data.video.duration; delete data.video.durationSeconds;
    ui.context.window.tune4mePreviewLookups = { pools: new Map([[ui.context.getVideoCacheKey(anchor.song, anchor.artist),
        { data, cachedAt: Date.now() }]]), pending: new Map(), limited: null, attempt: 0 };
    ui.context.fetch = async () => { calls++; throw new Error("No refresh request"); };
    const result = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    assert.equal(result.status, 404); assert.equal(result.data.reason, "unplayable"); assert.equal(calls, 0);
});

// Policy checks use only mocked metadata and players; no provider is contacted.
for (const flag of [false, true, undefined, null, "false", 0]) {
    test(`existing video-status request preserves child-directed status without extra calls (${String(flag)})`, async () => {
        fetchImpl = async () => response({ items: [exactVideo] });
        detailsImpl = async () => response({ items: [verifiedVideo(exactVideo, {
            status: { embeddable: true, privacyStatus: "public", uploadStatus: "processed", madeForKids: flag }
        })] });
        const result = await invoke(getYouTubeVideo, anchor);
        const expected = typeof flag === "boolean" ? flag : null;
        assert.equal(result.status, 200); assert.equal(result.body.video.madeForKids, expected);
        assert.equal(result.body.candidates[0].video.madeForKids, expected);
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
        assert.match(detailRequests[0][0], /part=snippet,status,contentDetails/);
        const cached = await invoke(getYouTubeVideo, anchor);
        assert.equal(cached.body.video.madeForKids, expected);
        assert.equal(cached.body.cacheSource, "server_cache");
        assert.equal(requests.length, 1); assert.equal(detailRequests.length, 1);
    });
}

for (const flag of [true, undefined, null, "false", 0]) {
    test(`child-directed or unknown metadata cannot create a player, track playback or trigger another lookup (${String(flag)})`, async () => {
        const ui = playerFrontend(); let lookups = 0;
        ui.context.fetch = async () => {
            lookups++; const data = candidateResponse(1); data.video.madeForKids = flag;
            return response(data);
        };
        await ui.context.playSong(anchor.song, anchor.artist, ui.button);
        assert.equal(lookups, 1); assert.equal(ui.players.length, 0);
        assert.ok(!ui.events.includes("song_preview_opened"));
        assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
        assert.match(textOf(ui.slot), flag === true ? /marked Made for Kids/ : /status could not be verified/);
        assert.match(textOf(ui.slot), /Listen on YouTube/);
    });
}

test("a returned non-child-directed alternative can be reused without another lookup", async () => {
    const ui = playerFrontend(); let lookups = 0;
    const data = candidateResponse(3); data.candidates[0].video.madeForKids = true;
    data.candidates[1].video.madeForKids = null;
    ui.context.fetch = async () => { lookups++; return response(data); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(lookups, 1); assert.equal(ui.players.length, 1);
    assert.ok(ui.players[0].iframe.src.includes(idFor("candidate2")));
    assert.ok(!ui.events.includes("song_preview_opened"));
    ui.players[0].events.onStateChange({ data: 1 });
    ui.players[0].events.onStateChange({ data: 1 });
    assert.equal(ui.events.filter(event => event === "song_preview_opened").length, 1);
});

for (const flag of [undefined, true]) {
    test(`an older cached ID with missing or child-directed status cannot bypass policy or start verification (${String(flag)})`, async () => {
        const ui = playerFrontend(); let lookups = 0;
        ui.storage.set(ui.context.getVideoCacheKey(anchor.song, anchor.artist),
            JSON.stringify({ videoId: exactVideo.id.videoId, cachedAt: Date.now(), madeForKids: flag }));
        ui.context.fetch = async () => { lookups++; throw new Error("No automatic policy-refresh request allowed"); };
        await ui.context.playSong(anchor.song, anchor.artist, ui.button);
        assert.equal(lookups, 0); assert.equal(ui.players.length, 0);
        assert.ok(!ui.events.includes("song_preview_opened"));
    });
}

test("confirmed non-child-directed playback remains reusable without a lookup", async () => {
    const ui = playerFrontend();
    ui.context.saveCachedVideo(anchor.song, anchor.artist, exactVideo.id.videoId, { madeForKids: false, duration: "PT3M", durationSeconds: 180 });
    ui.context.fetch = async () => { throw new Error("Cache playback cannot fetch"); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(ui.players.length, 1);
    assert.equal(ui.context.cachedMadeForKidsStatus(anchor.song, anchor.artist), false);
    assert.ok(ui.players[0].iframe.src.includes(exactVideo.id.videoId));
});

test("discarding an obsolete cached ID preserves favorites and allows only a later manual lookup", async () => {
    const ui = playerFrontend(); let lookups = 0;
    const saved = JSON.stringify([anchor]); ui.storage.set("savedSongs", saved);
    ui.storage.set(ui.context.getVideoCacheKey(anchor.song, anchor.artist),
        JSON.stringify({ videoId: exactVideo.id.videoId, cachedAt: Date.now() }));
    ui.context.fetch = async () => { lookups++; return response(candidateResponse(1)); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(lookups, 0); assert.equal(ui.players.length, 0);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.equal(ui.storage.get("savedSongs"), saved);
    ui.button.disabled = false; // The user chooses Play again after the ordinary button debounce.
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.equal(lookups, 1); assert.equal(ui.players.length, 1);
});

for (const flag of [true, null, undefined]) {
    test(`unverified playback metadata cannot be written as a confirmed cache (${String(flag)})`, () => {
        const ui = playerFrontend();
        ui.context.saveCachedVideo(anchor.song, anchor.artist, exactVideo.id.videoId, { madeForKids: flag });
        assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    });
}

const visibleRect = { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200 };
for (const [label, rect, visibility, css, expected] of [
    ["fully visible", visibleRect, "visible", {}, 1],
    ["more than half visible", { ...visibleRect, left: -190, right: 210 }, "visible", {}, 1],
    ["exactly half visible", { ...visibleRect, left: -200, right: 200 }, "visible", {}, 0],
    ["less than half visible", { ...visibleRect, top: -110, bottom: 90 }, "visible", {}, 0],
    ["offscreen", { ...visibleRect, top: 800, bottom: 1000 }, "visible", {}, 0],
    ["hidden tab", visibleRect, "hidden", {}, 0],
    ["unknown tab state", visibleRect, undefined, {}, 0],
    ["hidden style", visibleRect, "visible", { visibility: "hidden" }, 0],
    ["transparent", visibleRect, "visible", { opacity: "0" }, 0],
    ["display none", visibleRect, "visible", { display: "none" }, 0],
    ["undersized", { ...visibleRect, width: 199, right: 199 }, "visible", {}, 0]
]) {
    test(`scripted YouTube playback requires confirmed visibility: ${label}`, async () => {
        const ui = playerFrontend(); let lookups = 0, scriptedPlays = 0;
        ui.context.fetch = async () => { lookups++; return response(candidateResponse(1)); };
        await ui.context.playSong(anchor.song, anchor.artist, ui.button);
        const player = ui.players[0];
        assert.match(player.iframe.src, /autoplay=0/);
        player.iframe.getBoundingClientRect = () => rect;
        ui.context.document.visibilityState = visibility;
        Object.assign(ui.context.window, { innerWidth: 800, innerHeight: 600,
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", ...css }) });
        player.instance.playVideo = () => { scriptedPlays++; };
        player.events.onReady({ target: player.instance });
        player.events.onReady({ target: player.instance });
        assert.equal(scriptedPlays, expected); assert.equal(lookups, 1);
        assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
        if (!expected) assert.match(textOf(ui.slot), /Press Play in the video/);
        assert.equal(player.instance.destroyed, undefined);
    });
}

test("unknown viewport APIs keep native controls without scripted playback or retries", async () => {
    const ui = playerFrontend(); let starts = 0;
    ui.context.fetch = async () => response(candidateResponse(1));
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    ui.players[0].instance.playVideo = () => { starts++; };
    ui.players[0].events.onReady({ target: ui.players[0].instance });
    assert.equal(starts, 0); assert.equal(ui.players.length, 1);
    assert.match(textOf(ui.slot), /Press Play in the video/);
});

test("a blocked or throwing scripted start does not cycle candidates or retry playback", async () => {
    const ui = playerFrontend(); let starts = 0, lookups = 0;
    ui.context.fetch = async () => { lookups++; return response(candidateResponse()); };
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const player = ui.players[0]; player.iframe.getBoundingClientRect = () => visibleRect;
    ui.context.document.visibilityState = "visible";
    Object.assign(ui.context.window, { innerWidth: 800, innerHeight: 600,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) });
    player.instance.playVideo = () => { starts++; throw new Error("Synthetic player refusal"); };
    player.events.onReady({ target: player.instance });
    player.events.onAutoplayBlocked(); player.events.onReady({ target: player.instance });
    assert.equal(starts, 1); assert.equal(lookups, 1); assert.equal(ui.players.length, 1);
    assert.match(textOf(ui.slot), /Press Play in the video/);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
});

test("a disposed player cannot start scripted playback even when fully visible", async () => {
    const ui = playerFrontend(); let starts = 0;
    ui.context.fetch = async () => response(candidateResponse(1));
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const player = ui.players[0]; player.iframe.getBoundingClientRect = () => visibleRect;
    ui.context.document.visibilityState = "visible";
    Object.assign(ui.context.window, { innerWidth: 800, innerHeight: 600,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) });
    player.instance.playVideo = () => { starts++; };
    ui.context.destroyYouTubePreview(ui.slot.children[0]);
    player.events.onReady({ target: player.instance });
    assert.equal(starts, 0);
});

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

for (const seconds of [5, 90]) {
    test(`YouTube cooldown race: older server success preserves the ${seconds}-second pause, cache reuse and manual retry`, async () => {
        let now = 1800000000000;
        mock.method(Date, "now", () => now);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const fresh = { song: "Fresh Track", artist: "Fixture Artist" };
        const freshVideo = video("freshmatch", "Fixture Artist - Fresh Track (Official Audio)", "Fixture Artist");
        fetchImpl = async url => {
            const query = new URL(url).searchParams.get("q");
            if (query === `${anchor.artist} ${anchor.song}`) { await gate; return response({ items: [exactVideo] }); }
            if (query === `${other.artist} ${other.song}`) return { ...response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429),
                headers: { get: () => String(seconds) } };
            assert.equal(query, `${fresh.artist} ${fresh.song}`);
            return response({ items: [freshVideo] });
        };
        const older = invoke(getYouTubeVideo, { ...anchor, includeAlternatives: true });
        const limited = await invoke(getYouTubeVideo, other);
        assert.equal(limited.status, 429);
        assert.equal(limited.body.retryAfterSeconds, seconds);
        const pause = global.youtubeRateBackoff;
        assert.equal(pause.until, now + seconds * 1000);
        release();
        assert.equal((await older).status, 200);
        assert.strictEqual(global.youtubeRateBackoff, pause, "a fresh success cannot discard or extend a newer pause");
        const cached = await invoke(getYouTubeVideo, anchor);
        assert.equal(cached.status, 200); assert.equal(cached.body.cacheSource, "server_cache");
        assert.equal(cached.body.videoId, exactVideo.id.videoId);
        const blocked = await invoke(getYouTubeVideo, fresh);
        assert.equal(blocked.status, 429); assert.equal(blocked.body.diagnostics.source, "backoff");
        assert.equal(blocked.body.retryAfterSeconds, seconds);
        assert.equal(requests.length, 2); assert.equal(detailRequests.length, 1);
        now = pause.until - 1;
        const boundary = await invoke(getYouTubeVideo, fresh);
        assert.equal(boundary.status, 429); assert.equal(boundary.body.retryAfterSeconds, 1);
        assert.strictEqual(global.youtubeRateBackoff, pause);
        now = pause.until;
        await Promise.resolve();
        assert.equal(requests.length, 2, "expiration alone must not launch a request");
        assert.equal((await invoke(getYouTubeVideo, fresh)).status, 200);
        assert.equal(global.youtubeRateBackoff, null);
        assert.equal(requests.length, 3); assert.equal(detailRequests.length, 2);
        assert.equal(global.youtubeLookups.size, 0);
    });
}

test("YouTube cooldown race: a late server success may clear an already expired pause", async () => {
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fetchImpl = async url => {
        if (new URL(url).searchParams.get("q") === `${anchor.artist} ${anchor.song}`) {
            await gate; return response({ items: [exactVideo] });
        }
        return response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429);
    };
    const older = invoke(getYouTubeVideo, anchor);
    await invoke(getYouTubeVideo, other);
    now = global.youtubeRateBackoff.until;
    release();
    assert.equal((await older).status, 200);
    assert.equal(global.youtubeRateBackoff, null);
    assert.equal(requests.length, 2); assert.equal(detailRequests.length, 1);
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

test("attempt, readiness and playback-state logs are event-only without caching readiness", async () => {
    const ui = playerFrontend();
    const logs = [];
    ui.context.console = { log: (event, data) => logs.push({ event, data }), warn() {}, error() {} };
    ui.context.fetch = async () => response({ ...candidateResponse(), cacheSource: "server_cache" });
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const attempt = logs.find(log => log.event === "youtube_preview_attempt");
    assert.equal(attempt.data, undefined);
    ui.players[0].events.onReady();
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null);
    assert.ok(logs.some(log => log.event === "youtube_preview_player_ready" && log.data === undefined));
    ui.players[0].events.onStateChange({ data: 1 });
    assert.ok(logs.some(log => log.event === "youtube_preview_player_state" && log.data === undefined));
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), idFor("candidate0"));
    ui.button.disabled = false;
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    assert.ok(logs.filter(log => log.event === "youtube_preview_attempt" && log.data === undefined).length >= 2);
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

for (const [reason, seconds, warning] of [["rate_limited", 5, false], ["quota_limited", 21600, false], ["rate_limited", 10, true]]) {
    test(`YouTube cooldown race: older fresh browser success preserves ${reason}${warning ? " warning" : ""}`, async () => {
        const ui = playerFrontend();
        let now = 1800000000000;
        ui.context.Date = { now: () => now };
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let calls = 0, reportedLimit = false;
        ui.context.fetch = async (url, options) => {
            assert.equal(url, "/api/getYouTubeVideo"); calls++;
            const song = JSON.parse(options.body).song;
            if (song === anchor.song) { await gate; return response(candidateResponse()); }
            if (song === other.song && !reportedLimit) {
                reportedLimit = true;
                return warning ? response({ ...candidateResponse(), warning: reason, retryAfterSeconds: seconds })
                    : response({ reason, retryAfterSeconds: seconds }, 429);
            }
            return response(candidateResponse());
        };
        const older = ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
        const limited = await ui.context.lookupYouTubePreview(other.song, other.artist, []);
        assert.equal(limited.status, warning ? 200 : 429);
        const state = ui.context.window.tune4mePreviewLookups;
        const pause = state.limited;
        assert.equal(pause.until, now + seconds * 1000);
        release();
        assert.equal((await older).status, 200);
        assert.strictEqual(state.limited, pause);
        assert.equal(state.attempt, 1);
        const cached = await ui.context.lookupYouTubePreview(anchor.song, anchor.artist, [idFor("candidate0")]);
        assert.equal(cached.status, 200); assert.equal(cached.data.cacheSource, "browser_candidates");
        assert.equal(cached.data.videoId, idFor("candidate1"));
        const blocked = await ui.context.lookupYouTubePreview("Fresh Track", "Fixture Artist", []);
        assert.equal(blocked.status, 429); assert.equal(blocked.data.reason, reason);
        assert.equal(blocked.data.cacheSource, "browser_backoff");
        assert.equal(calls, 2);
        now = pause.until - 1;
        const boundary = await ui.context.lookupYouTubePreview("Fresh Track", "Fixture Artist", []);
        assert.equal(boundary.status, 429); assert.equal(boundary.data.retryAfterSeconds, 1);
        assert.strictEqual(state.limited, pause);
        now = pause.until;
        await Promise.resolve();
        assert.equal(calls, 2, "expiration alone must not launch a browser request");
        const retried = await ui.context.lookupYouTubePreview("Fresh Track", "Fixture Artist", []);
        assert.equal(retried.status, 200); assert.equal(calls, 3);
        assert.equal(state.limited, null); assert.equal(state.attempt, 0); assert.equal(state.pending.size, 0);
        assert.equal(requests.length, 0); assert.equal(detailRequests.length, 0);
    });
}

test("YouTube cooldown race: the actual Retry button remains manual after an overlapping fresh success", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    ui.context.Date = { now: () => now };
    const timers = [];
    ui.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0, reportedLimit = false;
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getYouTubeVideo"); calls++;
        if (JSON.parse(options.body).song === other.song) { await gate; return response(candidateResponse()); }
        if (!reportedLimit) { reportedLimit = true; return response({ reason: "rate_limited", retryAfterSeconds: 5 }, 429); }
        return response(candidateResponse());
    };
    const older = ui.context.lookupYouTubePreview(other.song, other.artist, []);
    await ui.context.playSong(anchor.song, anchor.artist, ui.button);
    const pause = ui.context.window.tune4mePreviewLookups.limited;
    const retry = ui.slot.children[0].children.find(child => child.className === "retryPreviewBtn");
    assert.equal(retry.disabled, true); assert.equal(ui.players.length, 0);
    release(); await older;
    assert.strictEqual(ui.context.window.tune4mePreviewLookups.limited, pause);
    await retry.events.click(); assert.equal(calls, 2);
    now = pause.until;
    timers.find(timer => timer.delay === 1000).callback();
    timers.find(timer => timer.delay === 5000).callback();
    assert.equal(retry.disabled, false); assert.equal(calls, 2); assert.equal(ui.players.length, 0);
    await retry.events.click();
    assert.equal(calls, 3); assert.equal(ui.players.length, 1);
    assert.equal(ui.context.window.tune4mePreviewLookups.limited, null);
    assert.equal(ui.context.getCachedVideo(anchor.song, anchor.artist), null, "a resumed lookup is not confirmed playback");
});

test("YouTube cooldown race: integrated browser and server keep both gates until manual retry", async () => {
    const ui = playerFrontend();
    let now = 1800000000000;
    mock.method(Date, "now", () => now);
    ui.context.Date = { now: () => now };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fresh = { song: "Fresh Track", artist: "Fixture Artist" };
    const freshVideo = video("freshmatch", "Fixture Artist - Fresh Track (Official Audio)", "Fixture Artist");
    fetchImpl = async url => {
        const query = new URL(url).searchParams.get("q");
        if (query === `${anchor.artist} ${anchor.song}`) { await gate; return response({ items: [exactVideo] }); }
        if (query === `${other.artist} ${other.song}`) return response({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 429);
        assert.equal(query, `${fresh.artist} ${fresh.song}`);
        return response({ items: [freshVideo] });
    };
    let endpoints = 0;
    ui.context.fetch = async (url, options) => {
        assert.equal(url, "/api/getYouTubeVideo"); endpoints++;
        const result = await invoke(getYouTubeVideo, JSON.parse(options.body));
        return response(result.body, result.status);
    };
    const older = ui.context.lookupYouTubePreview(anchor.song, anchor.artist, []);
    assert.equal((await ui.context.lookupYouTubePreview(other.song, other.artist, [])).status, 429);
    const browserPause = ui.context.window.tune4mePreviewLookups.limited;
    const serverPause = global.youtubeRateBackoff;
    release(); assert.equal((await older).status, 200);
    assert.strictEqual(ui.context.window.tune4mePreviewLookups.limited, browserPause);
    assert.strictEqual(global.youtubeRateBackoff, serverPause);
    assert.equal((await ui.context.lookupYouTubePreview(fresh.song, fresh.artist, [])).status, 429);
    assert.equal(endpoints, 2); assert.equal(requests.length, 2); assert.equal(detailRequests.length, 1);
    assert.equal((await invoke(getYouTubeVideo, fresh)).status, 429);
    assert.equal(requests.length, 2);
    now = serverPause.until;
    assert.equal((await ui.context.lookupYouTubePreview(fresh.song, fresh.artist, [])).status, 200);
    assert.equal(endpoints, 3); assert.equal(requests.length, 3); assert.equal(detailRequests.length, 2);
    assert.equal(global.youtubeRateBackoff, null); assert.equal(ui.context.window.tune4mePreviewLookups.limited, null);
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
        status: { embeddable: false, privacyStatus: "public", uploadStatus: "processed" }, contentDetails: { duration: "PT3M",} }] });
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
