# Regression checks

Current complete suite: **1,058 tests**: 714 regression checks, 154 security checks,
51 homepage/button-theme checks, and 139 privacy/accessibility/storage checks.

```powershell
node --test tests/regression.test.mjs tests/security.test.mjs tests/homepage.test.mjs tests/privacy-controls.test.mjs
```

## In-place consent withdrawal

The 36 additional mocked checks cover Not now and Escape with existing content,
preservation of the displayed introduction/playlist/explanation and unsaved draft,
player/timer teardown, late request headers and bodies, stale action completion,
shared preview lookup races, old player callbacks, explicit resumption, browser
storage failures, URL/fragment review markers, live analytics opt-out, focus and
status announcements. Abort signals are tested, along with invalidation when abort
support is unavailable or a response ignores cancellation. The music API handlers
remain byte-for-byte unchanged. No live provider requests are part of these tests.

Vercel's [documented HTML beforeSend mechanism](https://vercel.com/docs/analytics/package#beforesend)
is registered before script loading and consults current consent for every event.
Withdrawal does not unload already-executing JavaScript or undo provider requests
or beacons already transmitted. It prevents new app music requests until renewed
agreement and makes old responses/callbacks inert even after reacceptance. A new
request cannot be removed by the cleanup of an older same-song lookup.

Only non-sensitive consent markers are written to the page address; mood text is
never added to storage, URLs, logs, or analytics. A fragment-only fallback is used
if history updates fail. If receipt revocation and both address-update methods all
fail, withdrawal still applies in memory and an explicit warning describes the
remaining reload risk. Other open tabs retain the documented reload requirement.
Actual screen-reader announcements and real analytics-script behavior still need
manual verification; mocked tests do not certify either.

## Conservative recording-duration eligibility

The 60 additional mocked checks exercise duration parsing, the reported 25-second
clip, reuse of full-length alternatives, cache validation, presentation qualifiers,
short recordings, privacy and provider-operation counts. No live provider was used.

The existing `videos.list?part=snippet,status,contentDetails` response already contains
`contentDetails.duration`. The handler now parses its ISO 8601 day/hour/minute/second
form and retains both the original duration and numeric seconds on each candidate.
Missing, malformed, nonpositive, unsafe or inconsistent durations are not guessed.
For ordinary full-song requests the conservative minimum is **30 seconds**. This
rejects the observed 25-second clip while retaining 30–59-second recordings; it does
not impose a multi-minute minimum. Genuine sub-30-second tracks are an acknowledged
limitation: available metadata cannot reliably distinguish those from short clips,
and this implementation does not add a catalog, hardcoded exceptions or a bypass.

Unrequested trailer, teaser, clip, snippet, excerpt and preview labels do not qualify
merely because a title also says Official Audio/Video. A marker already present in
the requested song/artist is not itself an unwanted presentation qualifier, preserving
genuine titles such as Teaser. Existing Shorts exclusions and strict song/artist
identity matching remain unchanged. Duration alone does not prove completeness;
longer unlabelled excerpts can still pass and require listening evaluation.

Filtering and selection use the candidates and batched status response already
retrieved. A qualifying alternative is preferred over a too-short official source;
official-source ordering remains intact among eligible recordings. A new duration
or presentation rejection closes further search stages for that lookup: the server
returns qualified recordings already available or the existing unplayable fallback.
It does not perform replacement searches, add metadata requests, or retry OpenAI.
The prior bounded search behavior for unrelated identity misses/service conditions
and the existing cooldown protections are not expanded.

Server caches, in-page candidate pools and confirmed-playback browser caches validate
the same duration rule. The original duration must agree with numeric seconds. Old
or inconsistent entries cannot authorize an embed or trigger an automatic refresh.
Only an obsolete preview entry is discarded; saved songs, preferences and capacity
remain untouched. A later manual Play can perform the ordinary lookup. Duration is
saved in the browser only after eligible playback starts, under the existing cache
size and seven-day expiry limits. Cached metadata cannot guarantee later availability.

Made-for-Kids restrictions, visibility-gated scripted playback, consent, sanitized
logs, API limits, disabled payments and the 100-song maximum remain enforced. The
playlist handler and musical recommendation algorithm are unchanged. The separate
preview-mode wall-clock timer behavior was not changed by this correction.

## Local pre-release safety corrections

The additional 69 mocked checks cover child-directed video metadata, visibility-gated
scripted playback, application save limits after browser-storage editing, malformed
API input and event-only local diagnostics. No live provider was used.

### YouTube policy basis and conservative behavior

Reviewed the current official [Developer Policies, III.E.4.j](https://developers.google.com/youtube/terms/developer-policies)
and [Made-for-Kids status guide](https://developers.google.com/youtube/data/guides/made_for_kids_status).
Embedded videos require a Made-for-Kids status check; child-directed players require
special tracking/data handling. The existing `videos.list` request already retrieves
`status`. The API now returns its exact boolean `madeForKids`, or `null` when absent or
invalid, without adding a request or changing search queries, matching or ranking.
Tune4Me conservatively does not embed child-directed or unknown-status recordings.
It may reuse a non-child-directed alternative already in the returned pool, but does
not search again merely because of a policy restriction. An explicit external YouTube
button remains available; it does not open automatically. Playback analytics is
recorded once only after an eligible player actually starts.

Confirmed-playback browser caches now retain the checked `madeForKids: false` value.
An older ID-only entry cannot authorize an embed and does not trigger an automatic
status-refresh request. Only that obsolete preview-cache entry is discarded; favorites
and preferences are untouched. A later explicit Play can perform the normal bounded
lookup, or the visitor can choose external YouTube. No background refresh is added.
Existing cache bounds and seven-day expiration remain unchanged. Cached status is
not a guarantee against subsequent publisher changes.

The [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#autoplay-and-scripted-playbacks)
requires more than half the player to be visible before scripted playback, and only
one simultaneous autoplaying player. Embeds now load with `autoplay=0`. At readiness,
the app makes at most one scripted start attempt, requiring a visible document,
visible/nontransparent player style, a viewport of at least 200 by 200 pixels and
more than half the player's area inside the viewport. Missing measurement APIs,
hidden/offscreen players, blocked starts and disposed players do not cause retries,
candidate cycling or extra lookups. Native controls and a short Play instruction
remain available. Existing disposal prevents simultaneous app preview players.
These technical checks do not certify all YouTube policies or legal compliance;
real-device visibility, native player accessibility and third-party behavior still
require manual review.

### Other narrow corrections

All application save entry points clamp the effective allowance to 100 at write time,
including after a post-initialization edit to `saveLimit`. Lower legacy allowances
and existing saved records are preserved. This is an application limit, not trusted
payment enforcement: users control browser storage and can directly edit their data.

Playlist/preview handlers validate request body and scalar field types before
conversion; malformed preference identities are ignored safely. Analytics similarly
requires a string event. Invalid request shapes return 400 without provider requests
or raw exception logging. Valid recommendation inputs, the single OpenAI call,
3,072-token ceiling, rate guards and musical-selection rules are unchanged.

Local and hosted preview diagnostics now share the same fixed event-name allowlist.
Neither logs song/artist identities, video IDs, provider metadata, credentials or
untrusted event names. API keys, cloud settings, checkout, unpaid-grant protections
and spending controls were not changed.

## Privacy agreement, accessible controls, and resilient storage

The earlier November 1 privacy-agreement correction did not change either API handler.
The later safety corrections above change input validation and return child-directed
metadata while preserving the successful musical-selection, search/matching and
YouTube-cooldown algorithms. Existing frontend tests use an agreed-visit fixture; the privacy suite
boots all real inline scripts, including initialization, with no preaccepted fixture
unless a test explicitly supplies a valid versioned receipt.

YouTube's [Developer Policies, section III.A](https://developers.google.com/youtube/terms/developer-policies#api-client-terms-of-use-and-privacy-policies)
require privacy-policy agreement before feature access, accessible disclosures, and
YouTube/Google policy references. They do not mandate a particular checkbox or certify
a website's compliance. The homepage is browseable without an arrival gate. Typing
does not automatically save or transmit the description. The first active music
action or support submission reveals a short inline agreement near its trigger,
with four policy links and an action-specific Agree label. Create uses Agree and
create playlist; saved playback uses Agree and play YouTube preview. Not now and
Escape cancel the waiting action and restore focus without clearing the draft.
A separate, unchecked optional-analytics choice in the persistent privacy controls is not required to
use music features. No application YouTube script loads until an agreed user requests
a preview, and optional browser analytics does not load until separately enabled.
Hosting and Vercel protection still necessarily handle page requests. The receipt
stores only the current policy version, acceptance time and optional-analytics choice.

Withdraw stops playback and invalidates/aborts pending music work in place. It removes
the receipt where possible and sets a non-sensitive, same-page review marker so a
blocked storage deletion cannot silently reauthorize active actions on reload. The
draft and the complete rendered playlist remain untouched; no mood text is saved.
Optional analytics uses Vercel's documented live-consent `beforeSend` predicate.
The homepage stays browseable and no notice opens automatically.
Withdrawal clears any waiting action, preserves songs and preferences and cannot undo completed provider
processing. If the browser blocks both address changes and persistent receipt
revocation, a warning explains the remaining reload risk rather than claiming durable
withdrawal. This is a browser interface agreement mechanism, not API authentication,
a legal-compliance certificate or jurisdiction-specific cookie clearance.

Ninety-five privacy-suite offline checks cover browseable first visits, direct action guards, optional
analytics, invalid/old/future-dated receipts, reload/withdrawal, shared on-demand
YouTube script loading, native labels/focus/live regions, Label in Name in initial
and changing button states, explicit Remove and avoid behavior, preference-reset
confirmation/cancellation and storage failures. Clearing likes/dislikes/avoidance
removes only `songFeedback`, `likedSongs` and `avoidSongs`; favorites, allowance,
current playlist and recent recommendation memory remain intact. A failed persistent
clear is reported as visit-only rather than falsely reporting durable deletion.

The inline-flow extension adds 25 cases for unsent drafts, action-specific labels,
Not now/Escape and focus restoration, request idempotence, competing activations,
latest draft validation (including current exclusions), failed callbacks, saved
playback, external YouTube navigation, native support resubmission, stale triggers,
withdrawal, receipts and policy versions. One visit-memory pending slot retains only
the first action. Agreement consumes it before invocation and never resumes anything
from a reload or restored receipt. Callback errors are sanitized and never retried.
Playlist creation revalidates the current textarea on agreement, so edits and current
exclusions are not replaced with a stale captured description. Hidden panels return
to a stable DOM location before an action can rerender the triggering controls.
This ordinary inline section does not make the rest of the page inert or trap Tab.

Whole-page boot checks exercise invalid JSON, wrong shapes, invalid entries, blocked
storage getters/reads/writes, full storage and preservation of valid legacy records.
Unreadable song records are not automatically erased or overwritten. Affected writes
use visit-memory with an accessible warning; successful explicit deletion can clear
the old record. Expendable playback-ID caches do not gain an additional unbounded
memory copy. Existing cache TTL, size and cooldown tests continue to run unchanged.

The historical `tests/local-preview-audit.json` real-provider response artifact was
removed and explicitly excluded from future Vercel uploads. Operational caches and
sanitized diagnostics were not removed. Existing immutable deployments still contain
their historical uploaded files; this local change does not purge deployed copies.

All provider, DOM and storage effects in the new tests are mocked. These checks do
not establish live model quality, actual playback, WCAG conformance or legal approval.
Manual NVDA/VoiceOver/Dragon/read-aloud testing, keyboard traversal through the native
player, mobile/zoom/reflow, media alternatives, autoplay visibility/branding and
jurisdiction-specific privacy/consent requirements still need review. Do not use this
suite to infer that cloud spending, credentials or firewall settings were changed.

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
the existing curator, preserve its returned cross-artist selections, and render grounded explanations.
They cover an explicit song, an artist reference, single-artist/genre constraints, mixed
feelings, desired intensity and optional taste examples. They preserve the ten-song default,
one provider call and existing output-token bound. These are request-contract and response
preservation tests; they do not establish live model quality, audible similarity or real
catalog validity. No extra generation, audio-analysis service or provider request is added.

The recording-specific instructions now balance emotional themes and lyrical meaning
with primary genre and secondary influences, vocal character and delivery, tempo feel,
groove, rhythm, instrumentation, musical energy and overall sonic similarity. Most
complementary selections should stay musically close, with fewer thoughtful cross-genre
discoveries, subject to the listener's artist/genre restrictions. Energy is separate from
emotional intensity. Qualitative descriptions must acknowledge uncertainty rather than
invent precise BPM, audio measurements or verified listening/analysis results.

Ten additional mocked checks inspect this single-call instruction contract and the
unchanged public playlist contract, preserve the exact Teddy Swims request even when omitted or
historically disliked, retain artist/genre restrictions and current exclusions, preserve
lower-energy mixed feelings and ordinary emotional discovery, and retain the ten-song
default and output-token ceiling. Artist variety and emotional/musical explanation fixtures
test selection preservation and grounded rendering, not live generation quality. No audio similarity scoring or
hard genre/artist quota is implemented; real musical fit still needs an authorized live review.

The curator now prioritizes the two or three most distinctive traits of each reference,
including vocal power and delivery, intensity and dynamic build-up, groove, instrumentation
and genre influences. Matching every trait is unnecessary; cross-genre discoveries may
connect through different combinations. Explicit preferences and desired energy retain
priority. The listener's example recommendations are not hardcoded into application logic.

### Explanations grounded in the final playlist

The same single OpenAI call now returns structured `explanation.connections` internally:
up to three original, zero-based song indexes, each with one allowlisted emotional theme
and qualitative musical trait. Arbitrary explanation prose is no longer accepted from the
model. The server resolves each index to its original song/artist identity, retains only
identities present in the final validated playlist, deduplicates them, and constructs up to
two short sentences. References to excluded, trimmed or replaced recordings are discarded;
attributes are never reassigned merely because recovery changed a song's array position.
Recovered songs receive no invented explanation if they had no original connection data.

The public `playlist.explanation` remains a string, including in the legacy formatted
response. If no connection survives, it explicitly states that a song-specific explanation
is unavailable. Malformed data, free-form legacy explanations, extra fields, out-of-range
indexes and unrecognized labels receive the existing sanitized `invalid_playlist_response`
error without retries or additional provider calls. This is an intentional change to the
internal structured model response, not a second generation or a browser API change.

Twenty-four new mocked regression checks cover distinctive-trait guidance, the supplied
ten-song example, omission recovery and trimming, current title/artist exclusions,
historical dislikes, continuation exclusions, duplicate removal, command-like title
identity, quoted titles, empty connection data and malformed responses. Two additional
security checks ensure rejected explanation content is not exposed or logged and removed
private recording references cannot survive reconstruction. Existing tests retain default
ten-song behavior, exact anchors, user restrictions, optional cross-genre discovery,
single-call and token limits, zero YouTube calls from playlist generation, disabled checkout,
legacy allowances and the 100-song maximum.

These checks establish reference accuracy, not factual musical analysis: emotional themes
and musical traits are still model inferences. The bounded vocabulary and short templates
offer less nuance than unconstrained prose. Live recommendation quality and provider
acceptance of the revised internal response format require separately authorized testing.
No live provider requests, commit, push or deployment are part of these local changes.

### Conditional musical-fit consistency checks

Explicit sound-similarity requests with a narrowly recognized title/artist reference now
use a compact additional `musicalFit` object in the SAME OpenAI response. The server
recognizes explicit cues such as similar vocals/genres/groove, musical similarity, sound
like, and sonically similar to. It does not activate this contract for ordinary moods,
emotion-only comparisons, or requests without an identifiable reference. Recognition is
conservative and English-cue-based; this is not a general semantic intent classifier.
The existing title recognizer and its full-title alternatives are reused, never a broad
split at `by`. Up to three bounded reference identities are sent; the curator selects one
primary reference, while the existing explicit-inclusion rules remain unchanged.

The object contains two or three distinct musical dimensions with short qualitative
characters (80 characters maximum), ordered by importance to the listener, and exactly
one assessment per ORIGINAL song index. Each assessment now has only `songIndex`, `kind`
and `judgments`. `judgments` is an ordered array of `match`, `different` or `uncertain`:
position 0 judges priority 0, position 1 judges priority 1, and position 2 judges priority 2
when present. Its length must equal the actual priority count, not merely fit the schema's
two-to-three-item bound. Repeated values such as `["match", "match"]` are valid judgments
of different priorities. Kinds are `close`, `discovery`,
`weak`, or `uncertain`. These are unverified model judgments, not audio measurements,
verified lyrical analysis, probabilities, or independent evidence. The same model can
still mischaracterize a recording or choose inappropriate priorities; human listening
remains necessary. User restrictions remain in the full request and curator instructions.

The model no longer returns separate `matches`, `differences` or `uncertain` index arrays.
Only after the row's exact shape, classification, judgment type, count and closed values
are validated does the server translate each judgment into its existing internal support
arrays. This is a one-to-one translation, not inferred support: missing judgments are never
filled, strings are not trimmed or coerced, unknown labels are not repaired, and legacy or
mixed formats are rejected per candidate. Malformed rows continue to consume reserves;
explicit requested-anchor exceptions never fabricate a musical assessment or explanation.

The new schema uses a string enum array bounded to two or three judgments, with required
fields and `additionalProperties: false`. The server enforces the cross-field length
relationship; no conditional schema feature is introduced. The configured model and
single-call API remain unchanged. Live provider acceptance still needs a separately
authorized test; mocked success is not evidence of live generation quality.

A close recommendation must match at least two priorities, including the first (most
important). A discovery must still match the first priority; other priorities can differ
or be uncertain. The server derives close/discovery status from the support arrays:
a strong connection labeled discovery is treated as close; a primary-only connection
labeled close is treated as discovery. This corrects only close/discovery labels, never
adds evidence or promotes an explicitly weak/uncertain judgment. Unsupported or unknown
first priorities remain disqualifying regardless of the model's label. One third of the
requested count (rounded down, minimum one) is an initial discovery preference, not a hard
restriction. Additional validated discoveries may fill a shortage after close matches
are exhausted; no primary requirement, classification or assessment is relaxed.
Eligible explicit inclusions bypass this fit gate; current exclusions, unavailable
identities and continuation exclusions still win. Duplicate identities cannot conceal
a weak assessment behind a stronger duplicate. Full-title resolution also applies to
the reference: an incorrect shortened identity cannot stand in for the resolved title.

Default ten-song musical-similarity requests now ask for EXACTLY fourteen candidate songs
and fourteen original-index assessments within the same response. The user-facing length
remains ten; `candidateCount: 14` is derived on the server, not accepted from the client.
`playlistCandidateCount` is the shared source for the prompt context, response schema,
validation and expected diagnostic counts. Four reserves can absorb three or four
unusable candidates without weakening eligibility; five rejections still cause a shortage
when the explicit anchor is already among the candidates. Missing anchors retain the
existing recovery rule without an extra model call.
The schema bounds song arrays, assessment arrays and explanation indexes to this pool.
Ordinary mood requests and other supported playlist lengths keep their original counts.
Eligible explicit anchors retain precedence, then otherwise eligible candidates rank by
weighted declared support: priorities 0, 1 and 2 carry weights 4, 2 and 1 respectively.
Fewer uncertainties break equal weighted-support ties; original candidate order breaks
remaining ties. These are qualitative
model judgments, not measured audio scores. Strong cross-genre connections can rank as
close; primary-only discoveries can fill remaining places using the initial preference
and the shortage-only backfill described below.
Excluded and duplicate candidates never fill slots; the weakest duplicate assessment
is retained for both eligibility and explanation data. Only the final ten songs reach
the public response, formatted playlist, and browser history.

The same comparison retains the least-supportive eligible assessment for duplicate
recording identities, using greater uncertainty when weighted support ties. Invalid,
weak, uncertain or unsupported-primary duplicate judgments still disqualify that identity
and cannot be replaced by a stronger duplicate. Weights never change eligibility, correct
missing support or supply independent audio evidence. They follow the declared priority
order without imposing particular dimensions, artists, genres, intensity or tempo. Thus
quiet, gentle musical priorities remain quiet and gentle; ordinary emotional-only requests
do not use this ranking at all. Cross-genre and discovery rules remain unchanged.

For example, support for priorities 0 and 1 ranks ahead of support for 0 and 2 even when
the former is later in the model array or has more uncertainty on its remaining priority.
Explanation traits are sorted into declared priority order before retaining at most two;
only surviving final identities with eligible assessments can supply these traits.
The priority-weighting change itself added no prompt, response-schema, provider-call,
output-token or diagnostic fields. The subsequent ordered-judgment change updates the
conditional instructions and internal response schema, while retaining the call and token
limits. The weights are
selection preferences, not confidence scores or measured musical-similarity values.

Thirty-three focused regression checks cover priority/order permutations, uncertainty
and stable model-order tie breakers, conservative duplicate support and uncertainty,
rejection of invalid/weak/uncertain/unsupported assessments, final-selection explanations
and all six declared-priority permutations, explicit exclusions, historical-dislike precedence,
ten distinct songs, gentle-reference priorities, and unchanged ordinary mood behavior.
One additional security check verifies private characteristics, discarded identities and
dummy credentials stay out of logs and explanations, client-supplied weights are ignored,
and generation retains one mocked OpenAI call and the 3,072-token ceiling. The original
coverage from the original 634 checks is retained with fixtures migrated to the new internal
response format. These tests cannot prove audible resemblance or correct
model-chosen priorities; live musical quality still requires authorized human listening.

No refill calls or automatic retries are introduced. Successful default responses still
contain ten distinct eligible songs. If filtering leaves too few, HTTP
502 with reason `insufficient_musical_fit` returns a fixed, clear limitation and no partial
playlist. Both fresh and continuation screens display safe, fixed wording, without
rendering upstream error text. Existing playlist state and recent history are not
replaced by a failed result. Unusable global reference/priority data, a non-array
assessment container or an oversized assessment array still fails closed with sanitized
`invalid_playlist_response`. Truncation/refusal still fails closed.

Individual assessment rows are now validated independently. Invalid shape, classification,
judgment values or judgment-count mismatches disqualify the affected recording without repairing
any musical support. Index claims are counted before row validation: repeated claims
invalidate that index even if one duplicate is otherwise valid. Missing, noninteger and
out-of-range indexes are never guessed from array position. Unclaimed candidate indexes
are ineligible, including when the assessment array is shorter than requested. The model
schema still requests exactly fourteen assessments; the server tolerates omissions only by
rejecting their unassessed candidates and using qualified reserves. More assessment rows
than candidates remain a global count error. Duplicate recording identities retain their
least supportive judgment, so a valid duplicate cannot conceal an invalid assessment.

An identifiable, eligible current explicit request is an inclusion-only exception to this
fit gate, including when its assessment is invalid, missing or ambiguous. This does not
make it a verified musical match: its invalid assessment remains null, no support is
invented, and it cannot supply a musical-fit explanation. Current exclusions, unavailable
recordings and continuation exclusions still prevent insertion. Historical dislikes and
soft recency do not override an eligible current explicit request. Reference-only and
similar-only mentions receive no inclusion exception. The remaining slots still require
valid musical support and use the discovery preference followed by validated backfill. Ten-song default success
requires ten distinct selected songs; insufficient reserves return the existing limitation
without a partial playlist or additional provider call.

For fit-enabled explanations, only surviving original identities with eligible
assessments can be explained. The server uses matched dimension labels, not arbitrary
character prose or the model's separate explanation musical label. It identifies the
connection as a possibility and an unverified curator judgment. A recovered anchor with
no original assessment gets no invented musical description. The public explanation
remains a string; internal fit assessments are neither returned nor logged. The ordinary
mood-only explanation contract is unchanged. No new browser history is stored.

`MUSICAL FIT VALIDATION` logs fixed numeric counters on completed selection, including
shortages: `candidateCount`, `eligibleCandidates`, `selectedCount`, `recoveredExplicit`,
`excluded`, `duplicate`, `primaryMismatch`, `primaryUnknown`, `weakAssessment`,
`uncertainAssessment`, `discoveryLimit`, `discoveryBackfill`, `notSelected`, `labelCorrections` and
`classificationConflicts`. These last two describe assessments; they are not additional
rejection totals. Exclusion takes precedence over duplicate and fit rejection when
counting. Artificial anchor prepending is not a duplicate; unselected eligible reserves
are not musically rejected. No identities, musical characteristics, moods, IPs, raw
responses or credentials enter these counters. Globally malformed responses still fail before
selection with the generic sanitized validation event; no unsupported diagnosis is
inferred from missing counters. No new analytics endpoint or persistent telemetry store
is introduced.

`discoveryLimit` retains its existing name but now counts discoveries deferred at the
initial preference; it is not a permanent rejection count. `discoveryBackfill` counts
deferred discoveries subsequently selected to complete the requested length. Any deferred
reserves left unused count toward `notSelected`. These are fixed numeric counters only;
no song identities, judgments or user text are added to diagnostics.

Additional fixed numeric fields are `invalidAssessment`, `explicitAssessmentBypass`,
`assessmentInvalidShape`, `assessmentInvalidIndex`, `assessmentDuplicateIndex`,
`assessmentMissingIndex`, `assessmentInvalidClassification`, `assessmentInvalidSupport`
and `assessmentInvalidJudgmentCount`. `invalidAssessment` counts unique nonexcluded candidates rejected
for an unusable assessment; `explicitAssessmentBypass` counts selected explicit inclusions without an
eligible assessment (including recovered omissions). Shape/index counters count unusable
unindexable rows, or the first applicable defect of a uniquely indexed row. Duplicate and
missing counters count affected candidate-index slots. A malformed unindexable row can
also leave an unclaimed slot, so these counters must not be added as a rejection total.
Exclusion/duplicate filtering can likewise make candidate counts differ from row counts.
No row indexes or arbitrary model properties are logged.

The former `assessmentInvalidPartition` counter is retired because the new representation
cannot place one priority in overlapping groups. `assessmentInvalidSupport` now counts
non-array judgments or values outside the closed enum. `assessmentInvalidJudgmentCount`
counts sequence lengths that differ from the actual priority count. Judgment lengths are
checked before values, so oversized arrays are rejected without traversing them.

### Privacy-safe validation failure diagnostics

Failures now also emit `PLAYLIST VALIDATION DIAGNOSTIC` before the existing generic
validation event (or alongside the existing upstream JSON/structure event). Curator
prompts, schemas, single-call behavior and token ceiling are unchanged by individual-row
validation. Public success/error formats are unchanged; qualified reserves can now prevent
an unnecessary failure. The fixed category allowlist is:

- `completion_incomplete`: a non-stop finish reason, including length truncation;
- `completion_missing`: missing choice, message, finish reason or content;
- `completion_refused`: a truthy refusal, without retaining its text;
- `invalid_response_json` / `invalid_response_structure`: unusable upstream envelope;
- `invalid_playlist_json` / `invalid_playlist_structure`: unusable playlist content;
- `candidate_count_mismatch` / `assessment_count_mismatch`: wrong candidate count or oversized assessment array;
- `reference_identity_mismatch`: malformed or unrecognized reference identity;
- `invalid_musical_priorities`: malformed, repeated or unsupported priorities;
- `invalid_song_assessments`: unusable non-array assessment container;
- `invalid_explanation`: invalid structured explanation data;
- `insufficient_eligible_songs`: a shortage after filtering;
- `unexpected_validation_failure`: an exception without a recognized internal tag.

Each event includes only a fixed category, allowlisted `finishReason`, boolean `refused`,
and available nonnegative safe-integer counts. Allowed finish reasons are `stop`, `length`,
`content_filter`, `tool_calls`, `function_call`, with fixed `missing`/`unknown` placeholders.
Unknown provider strings are never copied. Numeric fields are `expectedSongCount`,
`expectedCandidateCount`, `receivedCandidateCount`, `expectedAssessmentCount`,
`receivedAssessmentCount`, `receivedPriorityCount`, `eligibleSongCount` and optional
`completionTokens`. Counts are derived from server configuration and parsed array lengths;
client-supplied diagnostic fields are ignored. Unknown counts/tokens are omitted, not
invented or coerced from strings. Token usage comes only from the existing response's
numeric `usage.completion_tokens`, without an extra provider call.

No exceptions, raw responses, musical characteristics, titles, artists, mood text,
prompts, refusal text, credentials, IP addresses or identifying request metadata enter
this event. Diagnostics are internal logs, never added to the public JSON response.
Successful playlists emit no failure event. Existing aggregate selection counters remain
available on completed selection, including shortages. For an ordinary non-fit shortage,
the new tag is still `insufficient_eligible_songs` but the public error remains the
previous `invalid_playlist_response`. Explicit provider HTTP errors retain their existing
sanitized classification rather than being mislabeled as validation failures.

Mocked regression checks cover fixed categories, finish-reason normalization,
missing/invalid completion-token metadata, expected/received counts, unchanged public
responses, ordinary mood behavior, success, one call and the unchanged token ceiling.
Fifteen security checks exercise every category with private markers, malformed data and
an injected unexpected exception. They assert a closed diagnostic field set and prevent
leakage of titles, artists, prompts, refusal text, raw parser errors, keys, headers or IPs.
These diagnostics cannot reconstruct the cause of older requests: only a future
separately authorized test on code containing them can establish the live failure tag.

Regression checks cover activation boundaries, close matches, meaningful
discoveries, weak primary connections (including the context-specific Teddy Swims / Ed
Sheeran example), uncertainties, exclusions, historical-dislike overrides, recovery,
reference identity, malformed assessments, duplicate handling, token truncation and the
existing 25-song upper bound. The Ed Sheeran recording remains eligible for ordinary
emotional discovery; there is no song ban or recommendation roster. Two security checks
verify that raw characteristics, extra private evidence and credentials cannot enter
responses or logs. Two browser checks verify safe limitation messages, unchanged history
and saved capacity, and no automatic requests.

The reserve-pool regression checks cover the fourteen-to-ten contract, replacement
of weak/duplicate/excluded candidates, insufficient reserves, raw count failures,
malformed reserve assessments, fit ranking, original explanation indexes, corrected
labels, the final-length discovery preference, conservative weak/uncertain handling, explicit
anchor recovery, exclusion precedence, ordinary mood behavior and truncation without
retry. Three security checks cover fixed numeric-only diagnostics on success/shortage,
no diagnostic leakage on malformed data, canonical credentials, ignored client overrides,
one provider call and the unchanged token ceiling. Older ten-song mock scenarios now
explicitly supply four reserve fixtures when the new contract applies; raw-response tests
bypass that helper to prove that incomplete model output is never padded by the server.

Forty-five focused individual-assessment regression checks cover malformed/missing rows,
unknown classifications, invalid/duplicate/missing indexes, index-order independence,
legacy mixed formats, invalid or missing priority judgments, conservative duplicate identities, explicit
anchor exceptions, unavailable/current/continuation exclusions, historical dislikes,
similar-only requests, final-identity explanation accuracy, insufficient reserves and
one-song behavior. Seven additional security checks exercise every assessment rejection
subcategory with private markers and dummy credentials, asserting numeric-only counters,
sanitized shortage diagnostics, one mocked OpenAI call, zero other provider calls and the
unchanged 3,072-token ceiling. These checks do not establish how many candidates from the
October 30 live response would have survived; raw response contents were not retained.

Twenty-two additional ordered-judgment regression tests cover the closed schema and
instruction contract, malformed/non-string/unknown/missing judgments, rejection of legacy
and mixed formats, insufficient reserves without invented support, and discovery selection.
One of these exhaustively checks all 144 judgment/classification combinations
for two and three priorities through the real handler with mocked responses. It checks
eligibility and explanation traits independently of the model's classification label.
Three further privacy checks ensure invalid judgment values, missing judgments and private
legacy fields cannot leak into logs or explanations. Existing ranking, recovery, exclusions,
history, security and ordinary emotional-request tests use the new model response format;
no test helper silently converts or repairs legacy assessment data.

### Discovery preference and shortage-only backfill

Eligible explicit requests retain precedence. The existing 4/2/1 comparison puts close
matches before primary-only discoveries, then uses fewer uncertainties and original model
order as tie breakers. For default ten-song requests, the first selection pass admits up
to three non-required discoveries. If that pass selects fewer than ten, it fills only the
missing places from deferred discoveries in the same ranking order. All deferred entries
were already validated, deduplicated and checked against exclusions. The same relative
initial preference applies to other existing supported lengths.

Every discovery still needs primary support and an eligible classification. Weak,
uncertain-classified, malformed, excluded, primary-mismatched or primary-unknown entries
never enter backfill. There is no new universal five-discovery cap: when close matches
are scarce, the final playlist may contain more than five validated discoveries. Secondary
priorities may differ or be uncertain, as already permitted for discoveries; primary-only
support does not become a close match or evidence of measured musical similarity.

Explanations are constructed after final selection and use only each surviving recording's
actual declared support. If fewer than the requested number of distinct eligible songs
exist after both passes, the existing limitation remains; no partial playlist, refill
model call, automatic retry or YouTube request is introduced. The fourteen-candidate schema,
single OpenAI call, model and 3,072-token ceiling remain fixed. Conditional instructions
now describe the soft preference; their input-token footprint can change.

Twenty-three new regression tests cover the observed numeric shortage pattern, recovered
anchors and historical feedback, late close matches, ranked/tied discovery backfill,
final-recording explanations, current exclusions, continuation, weak/uncertain/invalid
support, conservative duplicate conflicts, genuine shortages, discovery-heavy pools and
supported nondefault lengths. Three former hard-cap cases now verify the authorized soft
preference and backfill behavior. Two additional privacy tests verify fixed numeric
backfill diagnostics and sanitized success/shortage responses, ignored client overrides,
canonical credentials, one mocked OpenAI call and no extra provider requests. Existing
history, YouTube cooldown, rate-limit, disabled-payment and 100-song-limit tests still pass.

### Fourteen-candidate reserve expansion

Only default ten-song musical-similarity requests use fourteen candidates. Ordinary mood
requests keep ten, and other supported musical playlist lengths keep their original
candidate counts. Client-supplied candidate counts are ignored. The curator's existing
candidateCount instruction now receives fourteen through the same helper that sets schema
and validation bounds; final length remains ten. Raw twelve-, thirteen- or fifteen-song
responses fail rather than being padded or retried. The single-call architecture, model,
timeout, 3,072-token ceiling, fit judgments, exclusions, 4/2/1 ranking, discovery backfill,
explicit-song recovery and final-identity explanations remain unchanged.

Existing fixtures and counter expectations have been migrated to four reserves. Shortage
tests now reject five candidates where appropriate; three or four valid rejections must
not cause an unnecessary failure. Ranking-specific fixtures keep added reserves eligible
but lower-ranked so they cannot hide the candidates whose relative order is being tested.
Seventeen dedicated regression checks cover three/four primary, malformed-judgment,
historical-dislike and continuation rejections, selected/trimmed reserve explanations,
nondefault lengths, and representative/long-title/accented-name fourteen-candidate
responses with both complete and truncated completions. Two further missing-index cases
and one extra raw-count case retain boundary coverage. Two new privacy checks verify
fourteen-candidate diagnostics and discarded identities remain redacted after three/four
primary rejections, with no additional provider calls.

Before application changes, three realistic synthetic fourteen-candidate outputs were
checked for size; the permanent realistic fixtures exercise the same format through the
mocked handler. Compact and pretty JSON lengths are reported as character counts, not
measured tokens. No tokenizer is installed locally, and no tokenizer package or model
endpoint was installed/called. Planning estimates for these mostly Latin-text fixtures
showed no blocking concern under 3,072 tokens, but are not upper bounds or guarantees for
other languages, longer identities, verbose generation or live behavior. Fourteen entries
add two song/assessment pairs over twelve, so output usage and latency can increase.
Truncated completions still fail closed with no partial playlist or automatic retry;
neither the token ceiling nor spending limits were raised.

The model, endpoint, 15-second timeout, single-call architecture and 3,072 output-token
ceiling remain unchanged. The schema and conditional instructions add input tokens, and
qualifying requests require more output tokens than before. An offline 25-song compact
fit fixture is under 3,000 JSON characters, but character count is NOT a tokenizer or a
guarantee of live success. Large responses can still reach the ceiling; they fail rather
than dropping assessments or weakening validation. Live schema acceptance, latency,
token usage and listening quality remain unverified until separately authorized testing.

## Recent recommendation memory

Fresh Create Playlist requests now include optional `recentSongs` context from a separate
`tune4meRecentRecommendations` localStorage entry. It retains at most 30 distinct title/artist
pairs, newest first, with one `recommendedAt` timestamp per pair for 30-day expiration.
Only titles, artists and that timestamp are stored; mood text, ratings, video IDs and other
fields are discarded. Expired, future-dated and malformed entries are pruned when history
is read or updated. A closed browser does not run background deletion. Re-recommending
a recording refreshes its own position and expiry without refreshing older recommendations.

Successful fresh playlists and newly added continuation recommendations update history.
Continuation keeps its existing hard `existingSongs` context; this new soft context is
sent only on fresh requests. Neither failed generations nor clearing the current playlist
erase or fabricate recent recommendations. Clear Recent History independently clears this
store without changing favorites, likes, dislikes, current playlists or saved capacity.
The control uses the existing blue secondary-button styling and accessible status messages.

The server accepts at most 30 well-formed, deduplicated identities and discards timestamps
and extra fields. Recognized current required anchors are removed from the soft context.
Recent songs are never inserted into `avoidSongs`, `existingSongs` or the validator's hard
exclusion sets. They are not dislikes or artist/genre bans. The same single curator call
prefers equally fitting fresh music but may repeat recordings to satisfy narrow preferences
or preserve emotional and musical fit. Exact-song recovery, current exclusions, continuation
exclusions, historical-dislike precedence and structured final-playlist explanations are unchanged.
No new candidate-selection or musical similarity-scoring mechanism is introduced.

The new history helpers tolerate corrupt, oversized or unavailable history storage. Bounded
in-memory history remains available during the visit if persistence fails; reload persistence
then cannot be guaranteed. Readable updates and clears from other tabs replace stale local
snapshots when history is next accessed. A failed persistent clear announces that it applies
only to this visit. Existing unrelated storage-dependent features are not rewritten here.

Forty new mocked checks cover reload persistence, 30-entry bounds, identity deduplication,
expiry boundaries, recency refresh, malformed data, privacy allowlists, independent clearing,
blocked/quota-limited storage, other-tab changes, success/failure/continuation recording,
fresh request context, repeated narrow-preference playlists, explicit anchor recovery,
current and continuation exclusions, ten-song defaults, explanation preservation, no added
provider calls, and sanitized success/error logs. Existing security and payment checks remain.

History is per browser origin and is not shared across devices or different staging URLs.
The visible notice and privacy page disclose sharing recent song/artist pairs with the
playlist service and OpenAI; expiration timestamps are not sent or logged. Musical identities
can reveal listening preferences even without mood descriptions. Bounded context adds input
tokens to the existing call, but no extra OpenAI or YouTube calls. Soft avoidance improves
context, not guaranteed novelty or independently verified musical quality.

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

### Balanced title quotes and explicit playlist inclusion

Formal recording references support balanced straight/curly single and double title quotes.
A single-quoted title closes only at a quote followed by the artist separator, so internal
apostrophes and a trailing contraction in a title such as `Don't Stop Believin'` remain
part of the identity. Unbalanced quotations do not supply a guessed canonical recording.
The existing title/artist character and length checks, narrow music cues and full-title
alternatives still apply; ordinary emotional prose is not split at a generic `by`.

Bounded create/make/build playlist commands featuring, including, containing or with
this/that song/track, it or the original can promote exactly one preceding identified
recording from taste context to explicit inclusion. References must precede the command;
commands embedded inside parsed title/artist identities are ignored. Multiple references
remain ambiguous rather than guessing which recording a pronoun means. Negated playlist
commands, current title/artist exclusions, similar-only constraints, unavailable recordings
and continuation exclusions retain precedence. Negation of an emotional state does not
by itself negate a later affirmative playlist command.

Promotion occurs before required/taste context is sent and before model-request filtering
and recovery. Thus `I love 'Lose Control' by Teddy Swims. Create a playlist featuring this
song...` protects the recording even when the model omits it or historical dislikes name
it; the title is no longer an optional example. Taste-only examples remain optional, even
if model inclusion metadata incorrectly names them. Recognition also lets explicit musical
similarity wording activate the fourteen-candidate structured-fit path that was previously
bypassed for this single-quoted request. Successful final output remains ten songs.

The parser uses temporary numeric reference ranges only to resolve order and distinguish
instructions from recording names. These offsets are neither sent as preference metadata,
returned, logged nor persisted. Existing full mood context and bounded song identities are
sent through the same one-call interface. Schema, ranking, eligibility, backfill, token
ceiling, YouTube and browser storage behavior are unchanged; correctly recognized requests
now use the intended musical-fit response format rather than the ordinary ten-candidate path.

Fifty-two new regression tests cover the exact request, model omission and supplied identity,
historical dislikes/recency, quote variants, internal apostrophes, conflicting shortened
command-like titles, affirmative and negated playlist wording, current exclusions,
continuation, optional tastes, multiple references, command order, instructions inside
literal recording names, emotional negation, ordinary prose and unbalanced quoting. Six
security checks confirm canonical credentials, fixed private-data-free diagnostics, no
internal parser offsets in context, ignored client overrides, fourteen candidates, ten final
songs, one mocked OpenAI call and the unchanged 3,072-token ceiling. All original 740 checks
remain passing. No live recognition, listening or playback claim follows from these mocks.

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

Reload the local page to use the new player handling. In Developer Tools, preview diagnostics now record fixed event names only, on localhost as well as hosted pages. They do not expose returned metadata, video IDs, song/artist identities or raw player errors. Sanitized API response categories distinguish lookup and player failures; no API credentials are logged.

## Ten-song alternative audit

The user-supplied playlist was checked against the running local API with `includeAlternatives: true` and `regionCode: "US"`. The historical real-provider response artifact has been removed from the release source and explicitly excluded by `.vercelignore`; it is not retained as a public metadata cache. Only synthetic provider responses belong in permanent regression fixtures. Nine requested song/artist pairs returned five identity-matched, metadata-permitted candidates each during the initial pass. This is not a claim that all nine played in a browser: no browser session or actual playback error codes were accessible.

The Roslyn / Robert Pattinson & St. Vincent request returned no matching result. The [soundtrack catalog](https://music.apple.com/us/song/334818026) credits Rosyln to St. Vincent & Bon Iver. The original label was not silently replaced with that recording. A later corrected-reference check was rate limited, as recorded in the JSON report.

Artist-named and Topic channels now outrank generic lyric uploads, and alternative searches check both audio and video forms before selecting the pool. If only generic sources are found, the search continues through the bare identity query. Search and status checks remain bounded; no unrelated song or artist is added to fill the pool. Unrequested featured-guest versions are rejected. A same-artist live performance may occupy the last fallback position and is labelled in the player caption.

Upstream rate limiting was also observed during follow-up checks. A failure during a later search now preserves any candidates already verified by `videos.list`, with a `warning` describing the interrupted search. It does not mark unchecked candidates as usable or cache a service failure as a song miss.

The suite includes candidate source preference, deduplication, accurate identity across retries, five-attempt exhaustion, success on a later candidate, failed-ID cache filtering, rate-limit recovery of verified candidates, and separate handling of configuration and autoplay events. Emotional recommendations, feedback, and the 100-song save boundary remain covered.

## Preview throttling and player diagnostics

At this stage the suite had **109 tests**, including 25 additional checks for concurrent lookup sharing, safe diagnostics, bounded backoff, Retry-After handling, verified-pool reuse, retry controls, player readiness, and cancellation. The existing emotional interpretation, exact identity, feedback/exclusion, and 100-song save checks remain intact.

API failures expose only allowlisted diagnostics: source, upstream HTTP status, known Google error reason, and search/status operation. Upstream messages, request URLs, headers, and API credentials are excluded. `rate_limited` remains separate from `quota_limited`; local guards, upstream failures, backoff, and quota cooldown have distinct diagnostic sources. Temporary limits include `retryAfterSeconds` and an HTTP `Retry-After` header.

Identical concurrent server lookups share a promise within a warm runtime, keyed by song identity, region, alternative-search mode, and excluded IDs. Verified server cache hits bypass the local lookup allowance. A smaller verified pool is preserved if expanding its alternatives fails. Upstream rate errors start an exponential 5–60 second holdoff; a longer provider Retry-After is honored up to five minutes. The existing six-hour quota cooldown remains separate. The server does not sleep or automatically repeat failing upstream calls.

The browser independently shares pending lookups and reuses verified candidate pools for five minutes, filtering failed IDs. It enforces the same bounded rate backoff even when server invocations have separate memory, while honoring longer service delays. The explicit retry control is enabled after the delay and never automatically submits a request. Stopped or superseded previews cannot restart through stale retry controls. Cached rate warnings stop announcing a pause once their delay expires. Successful-playback ID caching still requires player state 1; lookup success and player readiness do not qualify.

A successful in-flight lookup now clears prior backoff state only when the pause has
expired. It cannot discard or extend a newer active deadline in either the browser or
server. Cached candidate access remains ahead of the cooldown gate. Eight focused mocked
regression checks cover overlapping server/browser requests, five-second and longer
Retry-After pauses, the browser's six-hour quota pause and partial-result warnings,
cached candidates during the pause, the exact expiration boundary, manual Retry controls,
and the integrated browser/server path. Advancing time alone makes no request. Existing
backoff durations, cache limits, matching, eligibility checks and privacy logging are unchanged.
This fix adds no persistence or request cancellation and does not identify which Google
quota bucket caused a live rejection. No live provider requests were used.

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
