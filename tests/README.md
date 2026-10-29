# Regression checks

Current complete suite: **380 tests**: 293 regression checks, 61 security checks,
and 26 homepage/button-theme checks.

```powershell
node --test tests/regression.test.mjs tests/security.test.mjs tests/homepage.test.mjs
```

## Emotional and musical cohesion

The curator connects songs through emotional resonance, vocal expression and intensity,
atmosphere, instrumentation, rhythm and shared influences. A requested song remains an
eligible inclusion anchor while complementary selections come from other artists by default.
Blues, soul, folk, rock and other influences can bridge genres when the connection is natural;
genre variety, a fixed artist roster and a predetermined emotional progression are not imposed.
Explicit single-artist and genre-only requests still take precedence over default variety.
Artist-only references remain context rather than invented song titles. The Teddy Swims and
Big Mama Thornton examples illustrate relationships, not hardcoded recommendation lists.

Six focused mocked checks inspect the instructions and complete context actually sent to
the existing curator, and preserve its returned cross-artist selections and explanation.
They cover an explicit song, an artist reference, single-artist/genre constraints, mixed
feelings, desired intensity and optional taste examples. They preserve the ten-song default,
one provider call and existing output-token bound. These are request-contract and response
preservation tests; they do not establish live model quality, audible similarity or real
catalog validity. No extra generation, audio-analysis service or provider request is added.

## Explicit current-song requests

The local inclusion fix keeps the existing one-call curator and frontend playlist contract. A narrow
server-side reference recognizer handles formal title/artist requests such as
`Lose Control by Teddy Swims`, quoted references, and supported find/play/include and
similar/exclusion wording. Unquoted references require name-style capitalization;
ordinary emotional prose, artist-only preferences and ambiguous references remain with
the curator. The original mood is passed intact, including mixed feelings and circumstances.
This is reference recognition, not independent music-catalog verification. Unusual syntax,
lowercase unquoted references and other languages still depend on semantic model recognition.
Ambiguous titles beginning with command words (such as `Play Dead`) are not shortened;
quoting the title makes the reference eligible for independent omission recovery.

Longer commands such as `Play Lose Control by Teddy Swims and recommend other songs`
end the artist identity at the bounded follow-on music command. The follow-on must ask
to recommend, suggest or find songs, tracks or music; an arbitrary `and` or `by` does not
qualify. Bare `Play` commands also accept a title containing at least two words,
regardless of command capitalization, while retaining the full-title alternative.
Short ambiguous command-like titles still stay with the curator. Quoted titles retain
their full identity.
Twenty-one additional mocked cases cover the exact passion/vulnerability/longing request,
embedded commands, historical dislikes, exclusions, similar-only wording, taste examples,
continuation, ordinary prose, artist-only preferences and ambiguous titles. The provider
omits both the requested recording and inclusion metadata in the positive recovery cases;
each still returns ten songs after one mocked OpenAI call and no YouTube call. These
checks do not validate catalog availability, playback or live recommendation quality.

Full-title conflict handling preserves command words in recordings such as `Play It Again`
and `Listen to Your Heart`. Quoted or otherwise explicitly delimited full titles take
precedence over shortened identities. For ambiguous bare commands, the existing curator
can identify the full title through requested songs, returned recordings or unavailable
recordings; a same-artist shortened form cannot then become a second recovered song.
Pronoun/determiner-led bare commands and `Listen to` constructions require that semantic
identification. If neither reading is identified, alternatives carry a limitation notice.
Quoted full titles can still be independently recovered, and the exact Teddy Swims emotional
request retains its existing independent recovery. Optional `ambiguousSongTitles` context
clarifies the alternative readings without changing the response schema or adding a call.

Twenty-one additional mocked checks cover short `Play Lose Control by Teddy Swims`
commands, casing and quotation variants, historical dislikes, full command-like titles,
current exclusions and unavailable recordings. Informal spelling such as
`Play loose control by Teddy Swim` remains with the same curator for canonical identification;
the server does not fuzzy-match or recover the misspelled identity. If it remains unresolved,
the returned alternatives explicitly explain the limitation, even when the model omits
inclusion metadata. These checks do not establish live typo correction or playback.

Current title-only corrections and artist-wide negative instructions are matched against
known parsed and model-returned identities before recovery. Literal matching preserves
artist identity, avoids title-prefix/artist-prefix matches and does not reverse double
negation. Current exclusions take priority over historical feedback and all recovery paths.
If filtering leaves too few eligible songs, validation fails closed instead of returning
an excluded recording, shortening the playlist or spending on a retry. Fifty additional
regression cases and two privacy/security cases cover these release blockers, quoted titles,
conflicting identities, unresolved ambiguity, changed instructions and literal name matching.

Explicit inclusion references are supplied as `requiredSongs`, taste examples as `tasteSongs`,
and current exclusions as `excludedSongs`. A reference such as "I love Lose Control by Teddy
Swims" is optional musical context unless the user also asks to include it. Similar-only
and excluded originals are not inserted. Taste examples may still appear naturally if the
curator selects them and no exclusion applies. Existing playlist songs and current exclusions
always win. Historical dislikes are overridden only for eligible explicitly requested anchors,
without altering stored feedback.

One eligible explicit request must be included. For multiple requests, at least one must be
included; not every reference is mandatory. Validation prioritizes requested songs already
selected by the curator, then recovers omitted eligible references locally. At most half the
slots (or one in a one-song request) are used for these prioritized anchors; remaining slots
come from the curator's selections. Duplicates are removed and the requested count stays ten
by default. Other requested songs may also appear naturally among the curator's selections.
The compatibility text is generated from the final structured playlist.

The same strict upstream response schema now requires `inclusionRequested` and
`unavailableRequestedSongs`. They distinguish an unidentified inclusion request from ordinary
discovery and let the curator report a recording it cannot confidently recommend. Availability
reports retain exact song/artist identity; they are not a live catalog, regional availability,
or embeddability check. If none of the explicit requests can be included, the API supplies a
fixed, non-sensitive `requestNotice` and replaces the intro with that limitation. The homepage
shows the intro; continuation also exposes the notice in an accessible status element rather
than silently dropping it. A valid alternative playlist still has the requested song count.
No second OpenAI call, provider fallback, automatic retry or YouTube search is introduced.
Invalid/refused/truncated output, malformed inclusion metadata, or insufficient eligible songs
fail closed; recovery cannot bypass the existing validation protections.

Focused regression cases cover single/multiple inclusion, omission recovery, dislike conflicts,
taste examples, current exclusions, similar-only requests, continuation, mixed emotional
context, ordinary prose, artist-only preferences, preserved artist identity, deduplication,
count limits, unresolved/blocked requests, and visible fallback notices. The actual homepage
default is tested without overriding the request length in the fixture. Added security
checks cover parsed-reference and notice privacy, canonical authorization, rejected credentials,
and the absence of retries or calls to other providers. Existing preview identity ranking,
search budgets, bounded caches/trackers, payment shutdown and 100-song save tests remain.
All provider responses are mocked. No live accuracy, quota, credential or embedding claim
is established by these checks. Production is unchanged by this local fix.

The homepage checks cover the required five-line textarea, native multiline Enter behavior,
complete emotional descriptions and the 2,000-character boundary, accessible validation,
primary/secondary action states, preserved legacy allowances, concise favorites counts,
the 100-song boundary, inactive checkout, responsive CSS safeguards, and computed color
contrast (4.5:1 text and 3:1 input/focus indicators). Browser layout and keyboard checks
remain necessary; these tests do not claim a full screen-reader or WCAG conformance audit.
No live provider requests are made. Run files with the default per-file test isolation.
The local browser review also checked 900px desktop and 360px/320px mobile layouts,
native Enter/newline and Tab-to-create behavior, the blue focus indicator, save/clear
actions, saved-song persistence, and upgrade-unavailable messaging with synthetic data.
Production and the protected security Preview were not redeployed for these UI changes.
Button-theme checks cover readable primary/secondary hover and active states, disabled
labels, consistent blue return/admin actions, and the actual generated/continued/saved
song controls' theme classes and behavior hooks. External YouTube buttons no longer
override the shared secondary palette. The theme update changes presentation only.

Original regression suite: **128 tests**. See the Stage 1 search optimization notes at the end for current search-count behavior; earlier sections record previous stages.

Security additions: **56 tests**, run alongside all 128 unchanged original checks (**184 total**):

```powershell
node --test tests/regression.test.mjs tests/security.test.mjs
```

The added checks exercise the actual handlers and inline browser functions with mocked providers.
They cover closed client-side payment grants, preservation of existing saved access, rejection of
client sales claims, production log privacy, safe OpenAI request limits and failure handling,
bounded YouTube caches and concurrency, and safe provider diagnostics. No paid network calls occur.
Detailed preview diagnostics remain available only on exact loopback development origins;
hosted origins log fixed preview event names without listening data.

Eight playlist-tracker checks cover expiry (including the existing exact-boundary behavior),
cleanup of other clients and malformed records, the 1,000-client maximum, existing-client
allowances at capacity, recovery of expired slots, unusual client keys, and response/log privacy.
The tracker retains the existing 12-request/60-second limit. Incoming playlist requests reclaim
expired records; there is no background timer. At capacity, new clients receive the existing
generic 429 response rather than evicting an active client's record. Tracked clients retain
their counters and remaining allowance. These are per-runtime controls, not a distributed
rate limit or an aggregate spending ceiling. All provider calls in these checks are mocked.

## Canonical server-side OpenAI configuration

The playlist handler uses only the server-side `OPENAI_API_KEY` in every environment.
It reads that key once per request, validates its presence, and uses the same value for
its single outgoing authorization header. Missing or blank configuration fails before
any provider request. Rejected credentials and network failures do not trigger retries
or another credential path. Browser request fields and headers cannot supply the key.

Ten permanent mocked checks cover the canonical authorization header, missing/blank
configuration, sanitized HTTP and network failures without retries, warm-runtime key
changes, and rejection of client-supplied credentials. All 200 earlier permanent tests
remain; the retired environment-selection cases have been replaced by these checks.
No real credentials or live provider requests are used.

These tests cannot verify real key permissions, OpenAI project/organization ownership,
usage attribution, enforced spending limits, or deployment protection. Confirm those
using non-secret metadata before release, with any live canary separately authorized.
Retiring obsolete hosted configuration or old deployments also requires separate
authorization; this local cleanup changes neither settings nor existing deployments.

Paid fulfillment is intentionally blocked pending server identity, durable storage and verified
Stripe configuration. See [payment security and migration](../PAYMENT_SECURITY.md). These tests
do not claim to validate an absent Stripe webhook, database transaction or real purchaser migration.

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
