/**
 * background/service-worker.js
 *
 * Chrome-Extension-API plumbing:
 *   - inject the content-script bundle into the active tab
 *   - ask it to run the (entirely local) extraction pipeline
 *   - capture the visible-tab screenshot
 *   - lazily create + relay messages to the offscreen document that
 *     hosts the local NER model (see offscreen/offscreen.js)
 *   - forward click/type/scroll action requests into the page
 *   - hand results back to the popup, which renders/redacts them and
 *     talks to the backend agent API (agent/agentBackend.js)
 *
 * The ONLY outbound network call anywhere in this extension happens in
 * agent/agentBackend.js, and only ever carries already-redacted data.
 * Nothing in this file makes a network request.
 */

const CONTENT_SCRIPT_FILES = [
  'utils/logger.js',
  'utils/geometry.js',
  'utils/selectors.js',
  'content/visibility.js',
  'content/interactiveElements.js',
  'content/textExtractor.js',
  'content/piiDetector.js',
  'content/coordinateMapper.js',
  'content/domExtractor.js',
  'content/content.js'
];

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab found.');
  if (!/^https?:/.test(tab.url || '')) {
    throw new Error('This page cannot be analyzed (unsupported URL scheme).');
  }
  return tab;
}

async function ensureContentScriptInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES
  });
}

async function runExtractionInTab(tabId) {
  // chrome.scripting.executeScript automatically awaits a Promise
  // returned from the injected function, so domExtractor.js's now-async
  // pipeline (NER round-trip included) works transparently here.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__BA.runFullExtraction()
  });
  return result;
}

async function captureScreenshot(tab) {
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

async function performAnalysis() {
  const tab = await getActiveTab();
  await ensureContentScriptInjected(tab.id);
  const extraction = await runExtractionInTab(tab.id);
  const screenshotDataUrl = await captureScreenshot(tab);
  return { extraction, screenshotDataUrl, tabId: tab.id };
}

async function performAction(action, args) {
  const tab = await getActiveTab();
  await ensureContentScriptInjected(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (actionName, actionArgs) => window.__BA[actionName](...actionArgs),
    args: [action, args]
  });
  return result;
}

// --- Offscreen document management (hosts the local NER model) ---

let creatingOffscreenPromise = null;

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
    return contexts.length > 0;
  }
  // Older Chrome fallback.
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS'], // local ML inference; adjust if your build uses a different reason
    justification: 'Runs a local NER model to detect names/PII entities without any network call.'
  });
  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function forwardToOffscreen(text) {
  await ensureOffscreenDocument();
  // IMPORTANT: chrome.runtime.sendMessage() broadcasts to every extension
  // context (background, popup, offscreen document). Without a `target`
  // discriminator, this service worker's own listener below would also
  // try to handle the message it just forwarded to itself, racing
  // against the offscreen document's real response. Every listener in
  // this file checks `message.target` up front and bails out
  // immediately for anything not addressed to it — the standard pattern
  // for talking to an offscreen document.
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'RUN_NER_INFERENCE', text });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore anything addressed to the offscreen document — let its own
  // listener (offscreen/offscreen.js) handle it instead. Without this
  // guard, this same handler would also fire for messages this service
  // worker forwards to itself via chrome.runtime.sendMessage() below.
  if (message.target === 'offscreen') return false;

  (async () => {
    try {
      switch (message.type) {
        case 'ANALYZE_PAGE': {
          const data = await performAnalysis();
          sendResponse({ ok: true, data });
          break;
        }
        case 'AGENT_ACTION': {
          const result = await performAction(message.action, message.args || []);
          sendResponse({ ok: true, data: result });
          break;
        }
        case 'START_OBSERVING': {
          const tab = await getActiveTab();
          await ensureContentScriptInjected(tab.id);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__BA.startObserving()
          });
          sendResponse({ ok: true });
          break;
        }
        case 'RUN_NER_INFERENCE': {
          // Relayed here from content/piiDetector.js (running inside the
          // page's isolated world, which cannot talk to the offscreen
          // document directly) to the offscreen document that hosts the
          // model, and the response relayed straight back.
          const response = await forwardToOffscreen(message.text || '');
          sendResponse(response || { ok: false, error: 'No response from offscreen document.' });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});