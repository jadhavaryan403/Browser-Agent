# Browser Agent (Chat-Driven, Privacy-Preserving)

A Chrome/Chromium Manifest V3 extension that acts as a chatbot-style
browser agent:

- you type a task into a chat-style popup
- it extracts visible, interactive DOM elements
- it detects sensitive information **entirely on-device** (regex/Luhn
  rules + a local NER model running in an offscreen document — see
  [PII Detection](#pii-detection))
- it screenshots the visible viewport and redacts every sensitive
  region with opaque black rectangles, locally, before anything is
  sent anywhere
- it POSTs the **redacted** screenshot + a sanitized element list to a
  backend you configure, and the backend replies with one instruction
  at a time: `{ "action": "click"|"type"|"scroll", "element_id": N, "value": ... }`
- it executes that instruction on the live page, re-analyzes, and
  repeats until the backend says the task is `"done"`

**There is no backend server in this repository.** This project is the
extension-side client only — see [Backend Contract](#backend-contract)
for exactly what it sends and expects back, so you can point it at
your own server.

---

## Project Structure

```
browser-agent/
├── manifest.json
├── background/
│   └── service-worker.js       # inject, screenshot, message relay, offscreen-doc lifecycle
├── content/
│   ├── content.js              # entry point, exposes window.__BA (click/type/scroll/select)
│   ├── domExtractor.js         # orchestrates the (now async) extraction pipeline
│   ├── visibility.js           # "is this actually visible to the user" checks
│   ├── interactiveElements.js  # finds + serializes interactive elements
│   ├── textExtractor.js        # walks visible text nodes with bounding boxes
│   ├── piiDetector.js          # local regex/Luhn rules + async local NER pass
│   ├── coordinateMapper.js     # DOM px -> screenshot px conversion
│   └── redactor.js             # canvas-based black-box redaction (runs in popup)
├── offscreen/
│   ├── offscreen.html          # hosts the NER model (service workers have no WASM-friendly DOM)
│   └── offscreen.js            # message contract scaffold — plug your model's inference in here
├── popup/
│   ├── popup.html / .css / .js # chat UI + backend-endpoint settings panel + agent loop
├── agent/
│   ├── stateManager.js         # IDLE -> ... -> COMPLETED state machine (now loops)
│   ├── taskManager.js          # task text + user-supplied info bookkeeping only
│   ├── agentController.js      # ties state machine + task manager together
│   ├── agentBackend.js         # the ONLY network call in this codebase — POSTs redacted data, parses the action reply
│   └── userInputManager.js     # renders the "additional info needed" form (backend-triggered via "ask_user")
├── utils/
│   ├── geometry.js
│   ├── selectors.js
│   └── logger.js
├── test/
│   └── test-page.html          # demo page for manual verification
└── icons/
```

This project still avoids a bundler. Every file is a plain script
attaching its exports to a shared namespace on `window`/`self`, loaded
in dependency order.

---

## How It Works

1. You type a task into the chat input and hit **Send** (or Enter).
2. `popup.js` starts the agent loop:
   a. `ANALYZE_PAGE` → background injects the content-script bundle
      into the active tab and calls `window.__BA.runFullExtraction()`.
   b. Inside the page, `domExtractor.js` extracts interactive elements
      (`interactiveElements.js`), visible text with bounding boxes
      (`textExtractor.js`), and runs `piiDetector.js` — regex/Luhn
      rules PLUS an async NER pass relayed through the background
      service worker to an **offscreen document** running a local
      model (see [PII Detection](#pii-detection)). Only masked
      previews + bounding boxes ever leave this context — never raw
      matched text.
   c. The background separately calls `chrome.tabs.captureVisibleTab()`.
   d. The popup draws the screenshot to a canvas, maps every sensitive
      item's bbox into screenshot-pixel space (`coordinateMapper.js`),
      and paints black rectangles over it (`redactor.js`). The
      *original* screenshot is discarded immediately.
   e. `agentBackend.js` POSTs `{ task, screenshot: <redacted data URL>,
      elements: <sanitized>, viewport, history }` to your configured
      backend endpoint and awaits `{ action, element_id, value }`.
   f. Depending on `action`:
      - `click`/`type`/`scroll` → executed via `AGENT_ACTION` →
        `window.__BA.click/type/scroll()` in the page, then the loop
        goes back to step (a) to re-analyze the (possibly changed) page.
      - `done` → the loop stops and the chat shows "task complete."
      - `ask_user` → the popup shows a local form (never auto-filled
        from detected PII) and, once submitted, loops back to (a).
   g. A safety cap (`MAX_AGENT_STEPS`, default 15) stops the loop even
      if the backend never says `"done"`.

---

## Backend Contract

**Request** (`POST <your endpoint>`, JSON body):

```json
{
  "task": "Find wireless headphones under ₹5000",
  "screenshot": "data:image/png;base64,....",   // ALREADY REDACTED
  "elements": [ /* the same structured element list from section 6 of the original spec, with any flagged values already replaced by "[REDACTED]" */ ],
  "viewport": { "width": 1440, "height": 900, "scrollX": 0, "scrollY": 0 },
  "history": [ { "action": "click", "elementId": 4, "result": { "success": true } }, ... ]
}
```

**Response** the extension expects back:

```json
{ "action": "click", "element_id": 14, "value": null }
{ "action": "type",  "element_id": 4,  "value": "wireless headphones" }
{ "action": "scroll","element_id": null, "value": "down" }
{ "action": "done",  "element_id": null, "value": null }
```

`click`/`type`/`scroll` were the three actions specified for this
project. Two extensions were added, both optional for a minimal
backend to implement:

- **`"done"`** — without an explicit completion signal the extension
  has no way to know when to stop looping; this was the smallest
  addition that makes the loop well-defined.
- **`"ask_user"`** (`value` = array of `{ key, label, type }` field
  descriptors) — preserves the original human-in-the-loop requirement
  (asking the user for a passenger name, phone number, etc.) from
  inside the new backend-driven flow. A backend that never needs this
  can simply never return it.

`agentBackend.js` validates the response shape client-side (must have
a recognized `action`; `click`/`type` must include an `element_id`)
and surfaces a chat error if the backend returns something malformed
or if the endpoint is unreachable — it never guesses or executes an
unrecognized action.

The backend endpoint is configured per-install via the ⚙️ settings
panel in the popup (persisted in `chrome.storage.local`, not
synced/sensitive) and defaults to `http://localhost:8787/api/agent/decide`
for local development.

---

## PII Detection

Two layers run entirely inside the browser, never touching a network:

1. **Regex + Luhn rules** (`piiDetector.js`) for email, phone, credit
   card (Luhn-checked), and IPv4 — unchanged from the original design.
2. **A local NER pass** for names/organizations/locations that the
   regex rules can't catch. `piiDetector.js` sends each visible text
   run to `background/service-worker.js`, which lazily creates an
   **offscreen document** (`offscreen/offscreen.html`) — a hidden,
   DOM-capable context Manifest V3 provides specifically for work a
   service worker can't do (e.g. WASM-heavy ML inference) — and relays
   the request there. `offscreen/offscreen.js` is shipped as a
   **message-contract scaffold**: it defines the exact request/response
   shape `piiDetector.js` expects and returns an empty result by
   default. Wire your actual model (ONNX Runtime Web,
   transformers.js with a *bundled, local* model, etc.) into
   `runInference()` there — the two `TODO`s mark exactly where.

   **This must stay local.** `offscreen.js` runs inside the extension's
   own origin specifically so PII detection never needs a network
   call. If your model loading requires fetching weights, fetch them
   once from your own hosting into the extension (or bundle them at
   build time) — do not have `offscreen.js` call a remote inference
   API per-request. The one and only intentional network boundary in
   this codebase is `agentBackend.js`, and it only ever sends data
   *after* this local detection + redaction has already run.

Message routing detail: `chrome.runtime.sendMessage()` broadcasts to
every extension context (background, popup, offscreen document), so
`service-worker.js` and `offscreen.js` both check a `target: 'offscreen'`
discriminator before handling a message — otherwise the service
worker's own listener would race against the offscreen document to
answer its own forwarded request. This is the same pattern used in
Chrome's official offscreen-document samples.

---

## Privacy Guarantees

This version intentionally makes **one** outbound network call per
agent step — to the backend endpoint **you** configure — and nowhere
else. Be precise about what that means:

- `agent/agentBackend.js` is the only file in this codebase containing
  `fetch()`. Everywhere else — content scripts, the offscreen NER
  document, background service worker — remains 100% local, exactly as
  before.
- What gets sent to your backend: the **already-redacted** screenshot
  (black boxes painted in, original discarded), the sanitized element
  list (any element whose value was flagged has `value: "[REDACTED]"`),
  the task text you typed, the current viewport size, and a short
  action history (typed text values are stored as `"[REDACTED]"` in
  history too, never the literal string).
- What never gets sent: the original unredacted screenshot, raw PII
  matches (`piiDetector.js` only ever produces masked previews like
  `j***@example.com`), or values from any field flagged as sensitive.
- User answers to an `ask_user` step are kept in memory
  (`TaskManager.collectedInfo`), never pre-filled from detected page
  PII, never written to `chrome.storage`, and wiped when the task
  completes.
- `utils/logger.js` still only logs when a local `DEBUG` flag is
  manually flipped, and scrubs known-sensitive object keys as
  defense-in-depth.

If you don't want *any* network calls at all, you can point the
backend endpoint at nothing and the extension will simply show a
"could not reach backend" chat error after each analysis pass — the
local extraction/detection/redaction pipeline still runs and is fully
visible in the "Latest Page Analysis" panel either way.

---

---

## Coordinate Handling

Screenshots from `chrome.tabs.captureVisibleTab()` are rendered at the
tab's *actual* pixel dimensions, which already bake in
`devicePixelRatio` **and** the page's current zoom level. Rather than
re-deriving that scale factor from `devicePixelRatio` and zoom
separately (fragile — zoom isn't reliably queryable from a content
script), `coordinateMapper.js` measures the **decoded image's actual
width/height** and computes:

```
scaleX = image.width  / viewport.width   (viewport = window.innerWidth at capture time)
scaleY = image.height / viewport.height
```

This self-corrects for DPR, zoom, and OS-level display scaling in one
step, and has been sanity-checked against:
- standard 1x displays
- HiDPI/Retina displays (DPR 2–3)
- browser zoom levels other than 100%
- scrolled pages (all bboxes are viewport-relative at capture time, so
  scroll position doesn't skew them as long as extraction and
  screenshot happen back-to-back, which the service worker guarantees)

A small configurable `padding` (default 4px, scaled proportionally) is
added around every redacted region to avoid partial character leakage
at the edges.

---

## Form-Control Values

Text typed into an `<input>`/`<textarea>`, or the label of a
`<select>`'s currently-chosen `<option>`, is visible on screen — it's
right there in the screenshot — but it is **not** represented as an
ordinary DOM text node. Form controls paint their value using the
browser's native widget rendering, so `textExtractor.js`'s
`TreeWalker` (which only visits `Text` nodes) structurally cannot see
it. An email address sitting in a search box, or a card number sitting
in a "select saved card" dropdown, would otherwise pass straight
through to the screenshot completely unredacted.

To close that gap, `domExtractor.js` separately calls
`piiDetector.scanPlainText(value, fieldLabel)` on every interactive
element's captured value:

- it reuses the same email/phone/card(+Luhn)/IP regexes as the
  text-node scanner
- it also flags a bare name (e.g. `"John Doe"`) if the field's own
  `aria-label`/`placeholder` looks name-ish (`"Full name"`,
  `"Passenger"`, etc.) — this catches values with no in-text label,
  which the text-node NAME heuristic can't do since it looks for a
  `"Name:"` prefix inside the string itself
- `<select>` reports the **visually selected option's text**, not the
  underlying `value=""` attribute, since pages frequently differ
  between the two (`value="opt1"` vs. displayed
  `"John Doe — Visa ending 4111"`)

Because form-control text doesn't expose per-character DOM positions
the way a real text node does via `Range`, there's no reliable way to
sub-locate a match *within* the field the way we do for regular page
text. Instead, when any match is found, the **entire element's
bounding box** is added to `sensitiveItems` and blacked out on the
screenshot — over-redacting a whole field is the safe failure mode
here, not under-redacting part of it. The element's `value` in the
returned JSON is also replaced with `[REDACTED]` at that point, so the
raw text never reaches the popup UI either.

`test/test-page.html` includes a dedicated section ("Pre-filled Form
Values") with a pre-filled email input, a textarea containing a phone
number, a saved-card `<select>`, and a plain "Full name" input with no
label prefix, specifically to exercise this path.

## Handling Dynamic Websites

`content.js` can start a debounced `MutationObserver`
(`window.__BA.startObserving()`) that watches `document.body` and
re-runs the extraction pipeline **at most every 400ms**, never on every
individual mutation. This keeps a fresh cached copy of the DOM registry
for `click()`/`type()`/`select()` to resolve against, without
reprocessing the whole page on every keystroke-driven re-render.

**Known limitation:** Chrome extension popups are destroyed when they
lose focus. That means live UI updates from the observer aren't shown
while the popup is closed — the cache lives in the page's content
script and is picked up the *next* time the popup asks for a fresh
extraction. For a production build, moving the UI to a
`chrome.sidePanel` (which stays open) would let the popup subscribe to
live observer updates instead of only refreshing on demand.

---

## Avoiding Stale Elements

Every extracted element gets a stable CSS selector
(`utils/selectors.js`), preferring `#id` → `data-testid`/`data-test`/
`data-qa` → a short path anchored at the nearest ancestor with an id →
a full `nth-of-type` path as a last resort.

Before any action (`click`, `type`, `select`), `content.js`:
1. Checks whether the originally-registered live element reference is
   still attached to the document (`document.contains(el)`).
2. If not, re-resolves the element via its stored selector.
3. Re-checks visibility (`visibility.js`) before acting.
4. Fails gracefully (`{ success: false, reason: '...' }`) if the
   element genuinely can't be found — the caller (a future agent loop)
   is expected to re-extract and try again.

---

## Manifest V3 / API Limitations (and how this project handles them)

- **Service workers have no DOM/Canvas.** Redaction therefore happens
  in the popup, which does have a `<canvas>`, rather than in the
  background service worker.
- **`chrome.tabs.captureVisibleTab` only captures the visible
  viewport**, not the full scrollable page — which is exactly what the
  spec wants (screenshot must match the same viewport the DOM was
  extracted from).
- **Content scripts aren't statically declared in the manifest.**
  Instead, `chrome.scripting.executeScript` injects them on demand when
  the user clicks "Analyze Page", using the `activeTab` permission
  rather than requesting always-on access to every page. `host_permissions:
  ["<all_urls>"]` is still needed for `captureVisibleTab` to work on any
  site the user chooses to analyze; this could be tightened to
  `activeTab`-only screenshot capture in a stricter build if broad host
  permissions are undesirable for store review.
- **Popups are ephemeral.** See "Handling Dynamic Websites" above —
  this is the main practical constraint of building this as a
  browser-action popup rather than a side panel.

---

## Installation

1. Download or clone this project folder (`browser-agent/`).
2. Open `chrome://extensions` in Chrome or any Chromium-based browser.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `browser-agent/` folder.
5. Pin the extension (puzzle-piece icon → pin) for easy access.

---

## Testing

1. Open `test/test-page.html` directly in the browser
   (`file://.../browser-agent/test/test-page.html`), or serve it
   locally.
2. Click the extension icon, type any task into the chat box (e.g.
   *"Click the search button"*), and press **Send** (or Enter).
3. Verify:
   - **DOM extraction**: the "Latest Page Analysis" panel's element
     count roughly matches the visible buttons/links/inputs on the
     test page, and none of the "Hidden / Off-screen" section's
     controls appear.
   - **PII detection**: "Sensitive Information Detected" shows EMAIL,
     PHONE, CARD, and IP_ADDRESS entries (masked previews only), plus a
     `SENSITIVE_URL_PARAM` entry from the flagged link and entries from
     the "Pre-filled Form Values" section.
   - **Screenshot**: the canvas shows only the current visible
     viewport, not the whole scrollable page.
   - **Redaction**: black rectangles sit directly over "John Doe", the
     email, the phone number, the card number, and the IP address in
     the screenshot — with no partial leakage at the edges.
   - **Coordinate accuracy**: try browser zoom at 90%/110%/150% and
     re-run — the black boxes should still align correctly.
   - **Dynamic content**: click "Add dynamic element", wait, then send
     another task — the new button should now appear in the extracted
     elements list.
   - **Backend contract**: with no backend running, confirm the chat
     shows a clear "could not reach backend" error rather than hanging
     or crashing, and that the local analysis panel still populated
     correctly beforehand. With a stub backend that always replies
     `{"action":"click","element_id":0,"value":null}`, confirm the
     extension clicks element 0, re-analyzes, and asks again.
   - **Network isolation of the local pipeline**: open Chrome DevTools
     → Network tab. During the *analysis* phase (before the backend
     call) you should see zero outgoing requests; the only request
     that appears is the single POST to your configured backend
     endpoint once redaction is complete.
   - **Task requiring info**: point your stub backend at replying
     `{"action":"ask_user","element_id":null,"value":[{"key":"passengerName","label":"Passenger name","type":"text"}]}`
     and confirm the popup shows an inline form, and that submitting it
     resumes the loop.

---

## Building the Backend

This repository intentionally stops at the extension boundary — see
[Backend Contract](#backend-contract) for the exact request/response
shape. A minimal backend just needs to:

1. Accept the POST body (`task`, `screenshot`, `elements`, `viewport`,
   `history`).
2. Optionally feed the redacted screenshot to a VLM alongside the
   element list, or reason over the element list alone (types, labels,
   bounding boxes are usually enough for simple tasks).
3. Reply with exactly one `{ action, element_id, value }` instruction
   per request — this extension calls your backend again after every
   single action, sending the freshly re-analyzed page each time, so
   your backend never needs to plan more than one step ahead.
4. Reply `{ "action": "done" }` once the task is finished.

Nothing else in this codebase needs to change to swap backends or
models — `agent/agentBackend.js` is the entire integration surface.