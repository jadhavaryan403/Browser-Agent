/**
 * content/domExtractor.js
 *
 * Ties together visibility.js, interactiveElements.js, textExtractor.js
 * and piiDetector.js into a single extraction pass, and shapes the
 * result into a plain, JSON-serializable object (no live DOM/Text node
 * references) so it can safely cross the boundary out of the page's
 * JS context back to the extension's background/popup contexts.
 */
(function (root) {
  function buildViewport() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  /**
   * Runs the full local extraction pipeline described in the project
   * spec (sections 4-9): interactive elements -> visible text ->
   * sensitive-info detection. Everything below this call stays inside
   * the content script; only the returned plain object leaves it.
   *
   * ASYNC: piiDetector.js now awaits an NER pass running in an
   * offscreen document (see offscreen/offscreen.js), so this whole
   * pipeline is async. chrome.scripting.executeScript in Manifest V3
   * automatically awaits a Promise returned from an injected function,
   * so callers (background/service-worker.js) don't need to change how
   * they invoke this.
   */
  async function runExtraction() {
    const viewport = buildViewport();

    const { elements, registry } = root.__BA_InteractiveElements.extractInteractiveElements(
      viewport.width,
      viewport.height
    );

    const textNodes = root.__BA_TextExtractor.extractVisibleText(
      viewport.width,
      viewport.height,
      registry
    );

    const { items: sensitiveItems, flaggedNodes } = await root.__BA_PiiDetector.detectSensitiveInfo(
      textNodes,
      viewport.width,
      viewport.height
    );

    // Also flag interactive elements whose href carries sensitive query params.
    for (const el of elements) {
      if (el.href) {
        const flagged = root.__BA_PiiDetector.detectSensitiveUrl(el.href);
        if (flagged) {
          sensitiveItems.push({
            type: flagged.type,
            masked: flagged.masked,
            confidence: flagged.confidence,
            bbox: el.bbox,
            elementId: el.id
          });
        }
      }

      // IMPORTANT: form-control VALUES — text typed into an
      // <input>/<textarea>, or the visible label of a <select>'s chosen
      // <option> — are painted on screen by the browser's native form
      // control rendering, NOT as ordinary DOM text nodes, so they need
      // their own scan (see README "Form-Control Values"). This scan is
      // now also async (NER runs here too).
      if (el.value) {
        const fieldLabel = el.ariaLabel || el.placeholder || '';
        const valueMatches = await root.__BA_PiiDetector.scanPlainText(el.value, fieldLabel);
        if (valueMatches.length > 0) {
          for (const m of valueMatches) {
            sensitiveItems.push({
              type: m.type,
              masked: m.masked,
              confidence: m.confidence,
              bbox: el.bbox,
              elementId: el.id
            });
          }
          // Never let the raw value escape this context once flagged.
          el.value = '[REDACTED]';
        }
      }
    }

    // Build a safe, display-ready visible-text summary: any text node
    // that contained a sensitive match is fully replaced, never partially
    // leaked. Live `.node` references are stripped here.
    const visibleTextSummary = textNodes.map((entry) => ({
      text: flaggedNodes.has(entry.node) ? '[REDACTED - sensitive text on this line]' : entry.text.slice(0, 300),
      bbox: entry.bbox,
      elementId: entry.elementId
    }));

    // Strip masked/confidence-only sensitive items down to a clean,
    // serializable shape (defensive: ensure no stray DOM refs sneak in).
    const cleanSensitiveItems = sensitiveItems.map((s) => ({
      type: s.type,
      masked: s.masked,
      confidence: s.confidence,
      bbox: s.bbox,
      elementId: s.elementId != null ? s.elementId : null
    }));

    const result = {
      timestamp: Date.now(),
      url: location.href,
      viewport,
      elements,
      visibleText: visibleTextSummary,
      sensitiveItems: cleanSensitiveItems,
      counts: {
        interactiveElements: elements.length,
        sensitiveItems: cleanSensitiveItems.length
      }
    };

    // Cache the registry + result locally for later action execution
    // (click/type/scroll/select) and for MutationObserver-driven
    // background refreshes. Never persisted to disk/storage.
    root.__BA_state.registry = registry;
    root.__BA_state.lastResult = result;

    return result;
  }

  root.__BA_DomExtractor = { runExtraction };
})(window);