# Tune4Me Early Public Beta Analytics Events

Tune4Me analytics are aggregate, count-only product events. Events must not include song titles, artist names, prompts, mood text, IP addresses, names, contact information, or other personally identifying information.

## Events

| Event | Trigger location | What it counts |
| --- | --- | --- |
| `home_page_loaded` | `index.html` `window.onload` | Home page loads |
| `playlist_generated` | `index.html` `showMood()` after a valid playlist response | Successful playlist generations |
| `continue_playlist` | `index.html` `continuePlaylist()` | Continue Playlist button usage |
| `song_preview_opened` | `index.html` `playSong()` | Preview button opens |
| `youtube_search_opened` | `index.html` YouTube search buttons and preview fallback button | Clicks that open YouTube search |
| `song_saved` | `index.html` `saveSong()`, `saveSongWithVideo()`, and `savePlaylist()` per newly saved song | Saved-song actions |
| `song_liked` | `index.html` `saveFeedback()` when rating is good | Positive feedback clicks |
| `song_disliked` | `index.html` `saveFeedback()` when rating is bad | Negative feedback clicks |
| `playlist_deleted` | `index.html` `clearNewList()` | Current playlist clears |
| `philosophy_opened` | `index.html` `togglePhilosophy()` when opened | Philosophy panel opens |
| `upgrade_dialog_viewed` | `index.html` `showUpgradeBox()` and save-limit path | Upgrade prompt views |
| `upgrade_completed` | `success.html` first successful upgrade page visit and `index.html` `handleUpgrade()` | Upgrade completions |
| `support_form_submitted` | `index.html` support form submit and Enter-to-submit path | Support submissions |
| `playlist_generation_failure` | `index.html` playlist response parse, invalid response, and request catch paths | Playlist generation failures |
| `youtube_preview_failure` | `index.html` YouTube preview missing/error/catch paths | YouTube preview failures |
| `rate_limit_event` | `api/getPlaylist.js` and `api/getYouTubeVideo.js` rate-limit branches | API rate-limit responses |

## Admin Summary

The admin dashboard lives at `admin-analytics.html` and fetches aggregate counts from `/api/analytics`.

Set `ANALYTICS_ADMIN_TOKEN` in the hosting environment. The dashboard accepts the token in the page input or as `?token=...`.

The summary is intentionally lightweight and in-memory. It is useful for Early Public Beta directional counts, but it is not a durable analytics warehouse.
