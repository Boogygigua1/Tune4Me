# Regression checks

Current suite: **128 tests**. See the Stage 1 search optimization notes at the end for current search-count behavior; earlier sections record previous stages.

Run with Node.js 24 (no packages or API credentials required):

```powershell
node --test tests/regression.test.mjs
```

If the environment cannot spawn test-worker processes, Node 24 also supports running the same suite in the current process:

```powershell
node --test --test-isolation=none tests/regression.test.mjs
```

The tests run the real API handlers with mocked upstream responses and the actual inline frontend functions with a minimal DOM stub. They disable live network requests. Coverage includes intact emotional context, mixed feelings and musical preferences, canonical song fields, playlist validation, identity ranking, flexible searches, cache expiry, error classification, rendering, previews, continuation exclusions, and the 100-song save boundary.

The emotional tests verify the instructions and data sent to the model, plus preservation of its returned emotional summary. The song-identification fixtures verify what happens after the model recognizes a reference. They do **not** prove that a live model will interpret every description or identify every song correctly.

## Live verification still needed

Use a locally served Vercel development instance with valid `OPENAI_API_KEY` and `YOUTUBE_API_KEY`, without deploying. Check these cases against actual responses:

| Request | Expected behavior |
| --- | --- |
| `I feel abandoned after our breakup.` | Acknowledge loss without interpreting "band" as a music clue. |
| `I feel judged by everyone. I want company, not advice or cheering up.` | No invented song called "I feel judged"; no forced uplifting ending. |
| `I miss my ex and feel relieved it ended. Please let me sit with both feelings.` | Preserve both longing and relief in the explanation and selections. |
| `I want 70s soul. I feel guilty and relieved after leaving; nothing triumphant.` | Honor the musical preference while retaining the emotional conflict and direction. |
| `Please find "Lose Control" by Teddy Swims because I miss my ex.` | Correct canonical song and artist, emotional context retained, correct preview. |
| `Songs like Lose Control by Teddy Swims, but don't include that song.` | Related recommendations without reinserting the excluded song. |
| `Spanish-language songs about being grateful for a new start and homesick at the same time.` | Honor the language preference without flattening mixed emotions. |

For previews, verify that official audio, official video, lyric-video searches, and the bare identity fallback can retrieve real results. Test actual embed playback and regional availability; matching metadata and the embeddability filters cannot guarantee playback in every browser or region. Verify actual quota, permission, and temporary-rate-limit error payloads in the configured Google project.

## Scope

This stage keeps the existing model, serverless handlers, one model call per generation, local saved songs, feedback, continuation, and external YouTube fallback. The server validates structured model output, adds recognized requested songs if omitted, applies existing exclusions, and returns both structured song fields and the existing formatted response for compatibility. It does not verify every generated recommendation against a separate catalog.

Older feedback ordering and persistence of the originating mood across reloads remain outside this stage. No deployment is part of this change.

## Playback corrections

Preview lookup now verifies search candidates with `videos.list` before returning an ID: embedding permission, public/unlisted processed status, age restrictions, and country restrictions when a country is supplied or available from Vercel's country header. Local requests without a country cannot establish the viewer's region. Video metadata is returned under `video` for diagnosis. Search misses return `no_result`; matching but unavailable recordings return `unplayable`. Status API failures remain service errors and are not stored as song misses.

The browser enables the YouTube IFrame API with its origin and an explicit referrer policy. Playback errors clear the browser preview cache. Removed/private videos (100) and embedding restrictions (101/150) advance through up to five distinct identity-matched, status-checked candidates before external fallback. Cached failed IDs are excluded. Reusing the returned candidate pool avoids a separate API lookup for each failed embed. Identification errors (153), player API loading errors, autoplay blocking, and search/service failures have separate handling. Preview IDs are cached in the browser only after playback starts. The cache namespace is `yt_v4_`, preserving saved songs and preference data.

The tests cover these error events with a simulated player. They do not substitute for an actual browser playback check.

### Observed local service responses

The running server at `http://127.0.0.1:3000` returned these IDs for the reported examples. YouTube oEmbed confirmed their titles/uploaders. After the corrections, the additional video-status check accepted all three as embeddable and available under an explicitly requested US-region check:

| Song / artist | Video ID | Lookup/status result |
| --- | --- | --- |
| The Night We Met / Lord Huron | `AKnC-W-JPJk` | HTTP 200; Vibe Music lyric upload |
| Big Black Car / Gregory Alan Isakov | `JgumMOMHpns` | HTTP 200; Gregory Alan Isakov - Topic |
| Youth / Daughter | `JiwCTqYMVWo` | HTTP 200; Aurora Vibes lyric upload |

Excluding the first Night We Met and Youth IDs returned alternatives `MwsWKgX2DFs` and `6I1p_sXflQQ`, respectively. The Lose Control / Teddy Swims control returned `FkOpwodhROI` with matching title/artist metadata and passing status checks.

The earlier Big Black Car miss was not reproduced. No connected browser surface was available to retrieve the original console or actual player error code. Embeddable metadata and oEmbed success cannot guarantee browser playback: YouTube may still enforce claims/platform restrictions. See [video status documentation](https://developers.google.com/youtube/v3/docs/videos#status.embeddable) and [player error codes](https://developers.google.com/youtube/iframe_api_reference#onError).

Reload the local page to use the new player handling. In Developer Tools, `youtube_preview_lookup` records lookup status and returned metadata; `youtube_preview_playback_error` records the video ID and actual player error code. Compare these rather than treating an embedded-player error as a failed song search. No API credentials are logged.

## Ten-song alternative audit

The user-supplied playlist was checked against the running local API with `includeAlternatives: true` and `regionCode: "US"`. [local-preview-audit.json](local-preview-audit.json) preserves the per-song responses and candidate IDs. Nine requested song/artist pairs returned five identity-matched, metadata-permitted candidates each during the initial pass. This is not a claim that all nine played in a browser: no browser session or actual playback error codes were accessible.

The Roslyn / Robert Pattinson & St. Vincent request returned no matching result. The [soundtrack catalog](https://music.apple.com/us/song/334818026) credits Rosyln to St. Vincent & Bon Iver. The original label was not silently replaced with that recording. A later corrected-reference check was rate limited, as recorded in the JSON report.

Artist-named and Topic channels now outrank generic lyric uploads, and alternative searches check both audio and video forms before selecting the pool. If only generic sources are found, the search continues through the bare identity query. Search and status checks remain bounded; no unrelated song or artist is added to fill the pool. Unrequested featured-guest versions are rejected. A same-artist live performance may occupy the last fallback position and is labelled in the player caption.

Upstream rate limiting was also observed during follow-up checks. A failure during a later search now preserves any candidates already verified by `videos.list`, with a `warning` describing the interrupted search. It does not mark unchecked candidates as usable or cache a service failure as a song miss.

The suite includes candidate source preference, deduplication, accurate identity across retries, five-attempt exhaustion, success on a later candidate, failed-ID cache filtering, rate-limit recovery of verified candidates, and separate handling of configuration and autoplay events. Emotional recommendations, feedback, and the 100-song save boundary remain covered.

## Preview throttling and player diagnostics

At this stage the suite had **109 tests**, including 25 additional checks for concurrent lookup sharing, safe diagnostics, bounded backoff, Retry-After handling, verified-pool reuse, retry controls, player readiness, and cancellation. The existing emotional interpretation, exact identity, feedback/exclusion, and 100-song save checks remain intact.

API failures expose only allowlisted diagnostics: source, upstream HTTP status, known Google error reason, and search/status operation. Upstream messages, request URLs, headers, and API credentials are excluded. `rate_limited` remains separate from `quota_limited`; local guards, upstream failures, backoff, and quota cooldown have distinct diagnostic sources. Temporary limits include `retryAfterSeconds` and an HTTP `Retry-After` header.

Identical concurrent server lookups share a promise within a warm runtime, keyed by song identity, region, alternative-search mode, and excluded IDs. Verified server cache hits bypass the local lookup allowance. A smaller verified pool is preserved if expanding its alternatives fails. Upstream rate errors start an exponential 5–60 second holdoff; a longer provider Retry-After is honored up to five minutes. The existing six-hour quota cooldown remains separate. The server does not sleep or automatically repeat failing upstream calls.

The browser independently shares pending lookups and reuses verified candidate pools for five minutes, filtering failed IDs. It enforces the same bounded rate backoff even when server invocations have separate memory, while honoring longer service delays. The explicit retry control is enabled after the delay and never automatically submits a request. Stopped or superseded previews cannot restart through stale retry controls. Cached rate warnings stop announcing a pause once their delay expires. Successful-playback ID caching still requires player state 1; lookup success and player readiness do not qualify.

The permanent external action is labelled **Open YouTube**. A failure fallback retains **Listen on YouTube** beside its specific explanation. Browser console events now distinguish:

- `youtube_preview_lookup`: lookup status, candidate IDs, cache source, safe diagnostics, and retry delay.
- `youtube_preview_attempt`: the actual attempted ID, browser/cache/pool source, and attempt number.
- `youtube_preview_player_ready`: the player completed initialization, without claiming playback.
- `youtube_preview_player_state`: reported state; state 1 establishes playback.
- `youtube_preview_playback_error`: the failed ID and actual player error code.

A player that does not become ready within 15 seconds after API attachment has a distinct initialization-timeout message. Its timer is cancelled on readiness, playback, failure, or disposal. Initialization timeouts do not cycle through unrelated recordings or masquerade as embedding prohibitions. The separate 10-second IFrame API loading timeout remains in place.

### Local service observations after this correction

The running local server served the updated HTML exactly as saved on disk. A live Night We Met / Lord Huron lookup returned HTTP 429 with `diagnostics.source: "youtube"`, `upstreamStatus: 429`, `upstreamReason: "rateLimitExceeded"`, and `operation: "search"`. Both the JSON retry delay and Retry-After header were five seconds. This establishes an upstream search rejection, not an attempted embed restriction. Subsequent Google Cloud Console inspection established that the separate daily search allowance was exhausted (100/100), while minute usage and general quota usage were low. The generic `rateLimitExceeded` reason alone did not establish temporary throttling; a five-second retry delay does not restore the daily allowance.

Two direct local Vercel HTTP requests both reached the upstream error path; shared server memory was not retained across those observed requests. Server deduplication/cache/backoff is therefore best effort per runtime, not distributed or durable storage. Running the actual frontend lookup helper against the live local endpoint made only one network request for two logical attempts: the second returned `browser_backoff`. This verifies the helper's live request suppression, not browser rendering or YouTube playback.

No connected browser was available to inspect actual iframe playback in this stage, and the upstream service remained rate limited. Reload the local page before retesting, then inspect the new events after pressing **Play**. Metadata permission, a returned ID, and onReady alone still do not prove playback. No deployment, push, or commit was performed.

## Stage 1 search optimization

The suite now has **128 tests**, including 19 new search-budget and continuation checks. All use mocked upstream services; no live YouTube search allowance is consumed by the tests.

The first search uses the unquoted artist/title identity without a music-category constraint and requests up to 25 results. Canonical song/artist matching, version exclusions, video-status verification, official/artist/Topic-source preference, regional checks, and the five-candidate limit remain in place. One verified artist-source studio match is sufficient to return the first pool; an explicitly requested live version can also qualify. Legacy query-only and non-alternative callers remain supported.

Only when the initial response has no sufficiently strong source does discovery continue through official audio (music category), official video, and lyric-video queries. Generic matching uploads remain usable after those bounded searches; an unrequested live upload cannot stop the search for a studio source. Repeated IDs are status-checked once within a lookup.

The API returns `nextSearchStage` (1–4), with 4 indicating completed discovery. A partial pool remains a usable cache hit even when it contains only one candidate. If playback exhausts that pool with errors 100/101/150, the browser supplies `startSearchStage` and the failed IDs to continue remaining searches. This cursor also works in a new server runtime, where memory from the first lookup is unavailable. Each healthy search variation runs at most once in that preview flow. Existing candidates are attempted before expanding discovery; the five-video playback cap, manual autoplay handling, external fallback, and initialization-error handling remain intact. Older responses without progress fields retain their existing bounded behavior.

Search progress is included in in-flight lookup keys, validated before upstream calls, and cannot regress when reading a cached response. Partial-stage misses do not populate the full identity miss cache. Completed pools can report exhaustion without another search. Cached search results and browser playback IDs retain their existing lifetimes; saved songs are not used as a search cache or altered by this stage.

Measured regression cases:

| Case | Search requests |
| --- | ---: |
| First-search artist-source match, including Lose Control, The Night We Met, and Youth fixtures | 1 |
| Reuse of the verified warm-runtime pool | 0 additional |
| Official-audio fallback success after an empty first response | 2 total |
| Official-video fallback success | 3 total |
| Lyric-video fallback success or complete failed matching | 4 total |
| Try another ID already in the first pool | 0 additional |
| Exhaust a small pool, then find a recording in the next search stage | 2 total |
| Four successive matching recordings fail playback, one discovered per stage | 4 total, then external fallback |
| Ten distinct uncached first-search matches | 10 total |
| Repeat that ten-song fixture in the same warm runtime | 0 additional |

These are deterministic request-count checks, not claims about live YouTube result ordering or playback. Daily search exhaustion remains an external limit. This stage does not add durable storage, change quota accounting/backoff, or guarantee shared caches across Vercel instances. No Redis or other external storage was added. Emotional recommendation generation, feedback, accessibility controls, saved songs, and the 100-song limit remain unchanged. No commit, push, or deployment is part of this stage.
