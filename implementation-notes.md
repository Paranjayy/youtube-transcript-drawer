# Implementation Notes

This document captures key technical design decisions, tradeoffs, and architectural strategies implemented during the development of the YouTube Auto-Transcript Drawer extension.

## 1. Safari Web Extension Compatibility & URL Resolution
* **Decision:** Format all relative and protocol-relative URLs (`//www.youtube.com/...` or `/api/timedtext/...`) into fully qualified absolute URLs before calling `fetch`.
* **Rationale:** In standard Chrome content scripts, the browser handles relative URLs gracefully by resolving them against the host page's origin (`https://www.youtube.com`). In Safari Web Extensions, however, the execution context of the content script treats these as relative to the extension's sandbox origin (`safari-web-extension://<id>`). This mismatch causes `fetch` to throw a `SyntaxError: The string did not match the expected pattern` (DOM Exception 12) inside WebKit.
* **Tradeoff:** Prepending the explicit protocol `https:` adds slight string manipulation logic, but guarantees absolute compatibility across Safari, Chrome, Firefox, and Arc.

## 2. Native DOM Scraper Fallback (Fail-safe Design)
* **Decision:** Automatically invoke YouTube's native transcript drawer when direct fetch requests fail (or captions are blocked by ad-blockers/CSPs), scrape the segment nodes, and render them in our custom UI.
* **Architecture:**
  1. Trigger `openNativeTranscript()` programmatically.
  2. Poll the DOM at a 400ms interval for `ytd-transcript-segment-renderer` nodes.
  3. Extract timestamps and text using fallback selectors (handling potential class name updates dynamically).
  4. Convert timestamp strings (like `M:SS` or `H:MM:SS`) to raw milliseconds to maintain time-seeking, active row highlighting, and auto-scroll functionality.
* **Visibility Control (Invisible Native Drawer):**
  * We inject a CSS rule under `body.yt-transcript-scraped-active` to make the native YouTube transcript container invisible (`opacity: 0.001`, `height: 0`, `width: 0`) instead of calling `display: none`.
  * **Tradeoff:** If we set the native container to `display: none`, some browsers or frameworks stop updating the element nodes or fail to trigger layout scroll listeners. Keeping it technically "rendered" at `0.001` opacity allows YouTube's internal JS to keep it fully updated in the DOM, allowing our scraper to parse it continuously in real time.
* **Mutation Observer Resyncing:**
  * Added a `MutationObserver` on the native segments container. If the native transcript changes (for example, if the user manually selects another language in the player settings), the changes are detected, parsed, and updated instantly in our panel, keeping them perfectly in sync.

## 3. Bidirectional Main-Isolated Handshake
* **Decision:** Implement a `REQUEST_YOUTUBE_PLAYER_RESPONSE` message handshake between the isolated world (`content.js`) and the main world (`injected.js`).
* **Rationale:** YouTube uses a Single Page Application (SPA) architecture. The initial load events between `document_start` (when `injected.js` extracts `ytInitialPlayerResponse`) and `document_end` (when `content.js` starts listening) are prone to race conditions. The content script now proactively requests the data if it missed the initial post, guaranteeing the panel loads successfully 100% of the time on hard refreshes.
