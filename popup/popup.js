/**
 * popup/popup.js
 *
 * Chat-driven controller for the agent loop:
 *
 *   user types a task
 *     -> analyze page (extract DOM + detect PII locally + screenshot)
 *     -> redact screenshot locally
 *     -> POST { task, redacted screenshot, sanitized elements, viewport, history }
 *        to the configured backend (agent/agentBackend.js — the ONLY
 *        network call in this extension)
 *     -> backend replies { action, element_id, value }
 *     -> execute click/type/scroll on that element_id via the content
 *        script (background/service-worker.js -> window.__BA.*)
 *     -> re-analyze the (possibly changed) page and repeat
 *     -> stop when the backend replies { action: "done" }, asks for
 *        user info via { action: "ask_user" }, errors, or a safety
 *        step-cap is hit
 *
 * This file never sends anything itself except messages to this
 * extension's own background service worker (chrome.runtime.sendMessage).
 * The one real outbound network request happens inside agentBackend.js.
 */

const MAX_AGENT_STEPS = 15;
const SETTLE_DELAY_MS = 600; // let the page react to an action before re-analyzing

const els = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  backendUrlInput: document.getElementById('backendUrlInput'),
  saveBackendBtn: document.getElementById('saveBackendBtn'),
  backendSavedNote: document.getElementById('backendSavedNote'),

  chatLog: document.getElementById('chatLog'),
  taskInput: document.getElementById('taskInput'),
  sendBtn: document.getElementById('sendBtn'),
  errorLine: document.getElementById('errorLine'),

  userInputSection: document.getElementById('userInputSection'),
  userInputContainer: document.getElementById('userInputContainer'),

  detailsPanel: document.getElementById('detailsPanel'),
  countElements: document.getElementById('countElements'),
  countSensitive: document.getElementById('countSensitive'),
  screenshotCanvas: document.getElementById('screenshotCanvas'),
  elementsList: document.getElementById('elementsList'),
  elementsJson: document.getElementById('elementsJson'),
  visibleTextJson: document.getElementById('visibleTextJson'),
  sensitiveList: document.getElementById('sensitiveList'),
  agentStateLine: document.getElementById('agentStateLine')
};

const agentController = new window.__BA_AgentController();
const agentBackend = new window.__BA_AgentBackend();
const userInputManager = new window.__BA_UserInputManager(els.userInputContainer);

let isRunning = false;
let actionHistory = []; // { action, elementId, value, result } — in-memory only, cleared per task

agentController.onStateChange((state) => {
  els.agentStateLine.textContent = state;
});

// ---------- Chat rendering ----------

function addMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `ba-msg ${role}`;
  bubble.textContent = text;
  els.chatLog.appendChild(bubble);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return bubble;
}

function showError(message) {
  els.errorLine.hidden = false;
  els.errorLine.textContent = message;
  addMessage('error', message);
}

function clearError() {
  els.errorLine.hidden = true;
  els.errorLine.textContent = '';
}

// ---------- Settings (backend endpoint) ----------

async function initSettings() {
  els.backendUrlInput.value = await agentBackend.getEndpoint();
}

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
});

els.saveBackendBtn.addEventListener('click', async () => {
  const url = els.backendUrlInput.value.trim();
  if (!url) return;
  await agentBackend.setEndpoint(url);
  els.backendSavedNote.hidden = false;
  setTimeout(() => { els.backendSavedNote.hidden = true; }, 1500);
});

// ---------- Messaging to background ----------

function sendMessage(message) {
  return new Promise(
      (resolve, reject) => {

          chrome.runtime.sendMessage(
              message,
              response => {

                  if (
                      chrome.runtime.lastError
                  ) {
                      reject(
                          new Error(
                              chrome.runtime
                                  .lastError
                                  .message
                          )
                      );

                      return;
                  }

                  resolve(response);
              }
          );
      }
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Rendering the latest analysis into the details panel ----------

function renderElementsList(elements) {
  els.elementsList.innerHTML = '';
  const top = elements.slice(0, 25);
  for (const el of top) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag';
    tag.textContent = el.type;
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = `[${el.id}] ${el.text || el.placeholder || el.ariaLabel || '(no label)'}`;
    row.appendChild(label);

    const bboxLine = document.createElement('div');
    bboxLine.style.color = '#9aa0b4';
    bboxLine.style.fontSize = '10px';
    bboxLine.textContent = `bbox: [${el.bbox.x}, ${el.bbox.y}, ${el.bbox.width}, ${el.bbox.height}]`;
    row.appendChild(bboxLine);

    els.elementsList.appendChild(row);
  }
  els.elementsJson.textContent = JSON.stringify(elements, null, 2);
}

function renderSensitiveList(sensitiveItems) {
  els.sensitiveList.innerHTML = '';
  for (const item of sensitiveItems) {
    const row = document.createElement('div');
    row.className = 'ba-list-item';

    const tag = document.createElement('span');
    tag.className = 'ba-tag sensitive';
    tag.textContent = item.type;
    row.appendChild(tag);

    const label = document.createElement('span');
    label.textContent = `${item.masked}  (confidence ${Math.round(item.confidence * 100)}%)`;
    row.appendChild(label);

    els.sensitiveList.appendChild(row);
  }
}

async function drawRedactedScreenshot(
  screenshotDataUrl,
  sensitiveItems,
  viewport,
  faceBoxes = []
) {
  console.log(
    "[redaction] sensitive items:",
    sensitiveItems?.length || 0
  );

  console.log(
    "[redaction] face boxes:",
    JSON.stringify(faceBoxes, null, 2)
  );

  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas =
        document.createElement("canvas");

      canvas.width =
        img.naturalWidth;

      canvas.height =
        img.naturalHeight;

      const ctx =
        canvas.getContext("2d");

      if (!ctx) {
        reject(
          new Error(
            "Could not create 2D canvas context"
          )
        );
        return;
      }

      console.log(
        "[redaction] Canvas:",
        canvas.width,
        "x",
        canvas.height
      );

      /*
       * Draw original screenshot.
       */
      ctx.drawImage(
        img,
        0,
        0
      );

      /*
       * =====================================================
       * 1. REDACT DOM PII
       * =====================================================
       */

      ctx.fillStyle = "#000000";

      for (
        const item
        of (sensitiveItems || [])
      ) {
        if (!item?.bbox) {
          continue;
        }

        const box =
          window.__BA_CoordinateMapper
            .mapDomBoxToScreenshot(
              item.bbox,
              viewport,
              canvas.width,
              canvas.height,
              4
            );

        if (
          Number.isFinite(box.x) &&
          Number.isFinite(box.y) &&
          box.width > 0 &&
          box.height > 0
        ) {
          ctx.fillRect(
            box.x,
            box.y,
            box.width,
            box.height
          );
        }
      }

      /*
       * =====================================================
       * 2. REDACT FACES
       * =====================================================
       *
       * YuNet already returns coordinates in the
       * ORIGINAL SCREENSHOT coordinate system.
       *
       * Therefore:
       *
       * DO NOT use viewport.
       * DO NOT use CoordinateMapper.
       * DO NOT multiply by devicePixelRatio.
       */

      console.log(
        `[redaction] Redacting ${faceBoxes.length} faces`
      );

      for (
        const face
        of (faceBoxes || [])
      ) {
        if (
          !face ||
          !Number.isFinite(face.x) ||
          !Number.isFinite(face.y) ||
          !Number.isFinite(face.width) ||
          !Number.isFinite(face.height)
        ) {
          console.warn(
            "[redaction] Invalid face:",
            face
          );
          continue;
        }

        /*
         * Padding around detected face.
         */
        const padding = 10;

        let x =
          Math.floor(
            face.x - padding
          );

        let y =
          Math.floor(
            face.y - padding
          );

        let right =
          Math.ceil(
            face.x +
            face.width +
            padding
          );

        let bottom =
          Math.ceil(
            face.y +
            face.height +
            padding
          );

        /*
         * Clamp coordinates.
         */
        x =
          Math.max(
            0,
            Math.min(
              canvas.width,
              x
            )
          );

        y =
          Math.max(
            0,
            Math.min(
              canvas.height,
              y
            )
          );

        right =
          Math.max(
            x,
            Math.min(
              canvas.width,
              right
            )
          );

        bottom =
          Math.max(
            y,
            Math.min(
              canvas.height,
              bottom
            )
          );

        const width =
          right - x;

        const height =
          bottom - y;

        if (
          width <= 0 ||
          height <= 0
        ) {
          continue;
        }

        console.log(
          "[redaction] DRAWING FACE:",
          {
            x,
            y,
            width,
            height,
            confidence:
              face.confidence
          }
        );

        /*
         * Black redaction rectangle.
         */
        ctx.fillStyle =
          "#000000";

        ctx.fillRect(
          x,
          y,
          width,
          height
        );
      }

      /*
       * =====================================================
       * 3. EXPORT
       * =====================================================
       */

      const dataUrl =
        canvas.toDataURL(
          "image/png"
        );

      console.log(
        "[redaction] Redacted screenshot generated:",
        dataUrl.substring(
          0,
          30
        )
      );

      resolve({
        canvas,
        dataUrl
      });
    };

    img.onerror = (error) => {
      console.error(
        "[redaction] Screenshot load failed:",
        error
      );

      reject(
        new Error(
          "Could not load screenshot"
        )
      );
    };

    /*
     * Ensure the screenshot is actually
     * a data URL before loading it.
     */
    if (
      typeof screenshotDataUrl !==
      "string"
    ) {
      reject(
        new Error(
          `Screenshot must be a string, received ${typeof screenshotDataUrl}`
        )
      );
      return;
    }

    if (
      !screenshotDataUrl.startsWith(
        "data:image/"
      )
    ) {
      reject(
        new Error(
          "Invalid screenshot data URL"
        )
      );
      return;
    }

    img.src =
      screenshotDataUrl;
  });
}


function findElementLabel(elements, elementId) {
  const el = elements.find((e) => e.id === elementId);
  if (!el) return `element #${elementId}`;
  return el.text || el.placeholder || el.ariaLabel || `${el.type} #${elementId}`;
}

function describeAction(decision, elements) {
  switch (decision.action) {
    case 'click':
      return `Clicking "${findElementLabel(elements, decision.elementId)}"…`;
    case 'type':
      return `Typing into "${findElementLabel(elements, decision.elementId)}"…`;
    case 'scroll':
      return `Scrolling ${decision.value || 'down'}…`;
    default:
      return `Performing ${decision.action}…`;
  }
}

function buildActionArgs(decision) {
  switch (decision.action) {
    case 'click':
      return [decision.elementId];
    case 'type':
      return [decision.elementId, decision.value || ''];
    case 'scroll':
      return [decision.value === 'up' ? 'up' : 'down'];
    default:
      return [];
  }
}

// ---------- One analysis pass: extract + detect PII + screenshot + redact ----------

async function analyzeCurrentPage() {
  agentController.beginPageAnalysis();

  const response = await sendMessage({
    type: 'ANALYZE_PAGE'
  });

  console.log("[popup] ANALYZE_PAGE RESPONSE:", response);

  if (!response?.ok) {
    throw new Error(
      response?.error || "Page analysis failed."
    );
  }

  /*
   * IMPORTANT:
   * service-worker returns:
   *
   * {
   *   ok: true,
   *   data: {
   *     extraction,
   *     screenshotDataUrl,
   *     faces,
   *     tabId
   *   }
   * }
   */
  const {
    extraction,
    screenshotDataUrl,
    faces
  } = response.data;

  agentController.onDomExtracted();
  agentController.onPiiDetected();
  agentController.onScreenshotCaptured();

  console.log(
    "[popup] Screenshot:",
    typeof screenshotDataUrl,
    screenshotDataUrl?.substring(0, 50)
  );

  console.log(
    "[popup] FACE BOXES FROM BACKGROUND:",
    JSON.stringify(
      faces,
      null,
      2
    )
  );

  const faceBoxes =
    Array.isArray(faces)
      ? faces
      : [];

  console.log(
    "[popup] FACE BOXES FOR REDACTION:",
    JSON.stringify(
      faceBoxes,
      null,
      2
    )
  );

  const redactedResult =
    await drawRedactedScreenshot(
      screenshotDataUrl,
      extraction.sensitiveItems,
      extraction.viewport,
      faceBoxes
    );

  const redactedDataUrl =
    redactedResult.dataUrl;
  
  /*
   * Display the redacted screenshot in the popup.
   */
  const displayCanvas = els.screenshotCanvas;
  
  if (displayCanvas) {
    const sourceCanvas = redactedResult.canvas;
  
    displayCanvas.width =
      sourceCanvas.width;
  
    displayCanvas.height =
      sourceCanvas.height;
  
    const displayCtx =
      displayCanvas.getContext("2d");
  
    if (displayCtx) {
      displayCtx.clearRect(
        0,
        0,
        displayCanvas.width,
        displayCanvas.height
      );
  
      displayCtx.drawImage(
        sourceCanvas,
        0,
        0
      );
    }
  }
  
  agentController.onScreenshotRedacted();

  els.countElements.textContent =
    extraction.counts.interactiveElements;

  els.countSensitive.textContent =
    extraction.counts.sensitiveItems;

  renderElementsList(
    extraction.elements
  );

  renderSensitiveList(
    extraction.sensitiveItems
  );

  els.visibleTextJson.textContent =
    JSON.stringify(
      extraction.visibleText,
      null,
      2
    );

  els.detailsPanel.hidden = false;

  agentController.evaluateReadiness(
    extraction
  );

  return {
    extraction,
    redactedDataUrl
  };
}

/** Waits for the user to fill in the backend-requested fields, via the existing userInputManager UI. */
function waitForUserInput(fields) {
  return new Promise((resolve) => {
    els.userInputSection.hidden = false;
    userInputManager.renderForm(fields, (values) => {
      els.userInputSection.hidden = true;
      userInputManager.clear();
      resolve(values);
    });
  });
}

// ---------- Main agent loop ----------

async function runAgentLoop(task) {
  agentController.startTask(task);
  actionHistory = [];

  addMessage('agent', "Got it — let's take a look at the page.");

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    addMessage('system', step === 0 ? 'Analyzing the page…' : 'Re-checking the page…');

    let extraction, redactedDataUrl;
    try {
      ({ extraction, redactedDataUrl } = await analyzeCurrentPage());
    } catch (err) {
      agentController.markError(err);
      showError(`Page analysis failed: ${err.message}`);
      return;
    }

    addMessage(
      'agent',
      `Found ${extraction.counts.interactiveElements} interactive elements and ` +
      `${extraction.counts.sensitiveItems} sensitive item(s) (redacted before anything leaves the browser). ` +
      `Asking the backend what to do next…`
    );

    let decision;
    try {
      decision = await agentBackend.decideNextAction({
        task,
        redactedScreenshotDataUrl: redactedDataUrl,
        elements: extraction.elements,
        viewport: extraction.viewport,
        history: actionHistory
      });
    } catch (err) {
      agentController.markError(err);
      showError(err.message);
      return;
    }

    if (decision.action === 'done') {
      addMessage('agent', 'The backend says this task is complete.');
      agentController.markCompleted();
      return;
    }

    if (decision.action === 'ask_user') {
      if (!decision.fields || decision.fields.length === 0) {
        showError('Backend requested "ask_user" but provided no fields.');
        agentController.markError(new Error('ask_user with no fields'));
        return;
      }
      agentController.markWaitingForUser();
      addMessage('agent', 'I need a bit more information from you before continuing.');
      const values = await waitForUserInput(decision.fields);
      agentController.submitUserInfo(values);
      addMessage('system', 'Thanks — continuing.');
      actionHistory.push({ action: 'ask_user', fields: decision.fields.map((f) => f.key) });
      continue; // loop back around and re-ask the backend with this info folded into history
    }

    // click / type / scroll
    addMessage('agent', describeAction(decision, extraction.elements));
    agentController.markExecuting();

    let result;
    try {
      result = await sendMessage({
        type: 'AGENT_ACTION',
        action: decision.action,
        args: buildActionArgs(decision)
      });
    } catch (err) {
      showError(`Failed to execute ${decision.action}: ${err.message}`);
      agentController.markError(err);
      return;
    }

    actionHistory.push({
      action: decision.action,
      elementId: decision.elementId,
      value: decision.action === 'type' ? '[REDACTED]' : decision.value, // never keep typed text in history sent back to the backend beyond this turn's own request
      result
    });

    if (!result || !result.success) {
      addMessage('error', `Couldn't ${decision.action} element #${decision.elementId}: ${result ? result.reason : 'no response'}`);
      // Keep looping — the next re-analysis may reveal the page changed
      // and the target no longer exists, which is useful signal for the backend too.
    }

    await delay(SETTLE_DELAY_MS);
  }

  addMessage('system', `Stopped after ${MAX_AGENT_STEPS} steps to avoid an unbounded loop.`);
}

// ---------- Send button / input wiring ----------

async function handleSend() {
  if (isRunning) return;
  clearError();

  const task = els.taskInput.value.trim();
  if (!task) {
    showError('Please describe a task first.');
    return;
  }

  addMessage('user', task);
  els.taskInput.value = '';
  isRunning = true;
  els.sendBtn.disabled = true;
  els.taskInput.disabled = true;

  try {
    await runAgentLoop(task);
  } catch (err) {
    // Defensive catch-all — individual steps already handle their own errors.
    showError(err.message || String(err));
    agentController.markError(err);
  } finally {
    isRunning = false;
    els.sendBtn.disabled = false;
    els.taskInput.disabled = false;
    els.taskInput.focus();
  }
}

els.sendBtn.addEventListener('click', handleSend);
els.taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

initSettings();