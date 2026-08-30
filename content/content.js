/**
 * content/content.js
 *
 * Entry point injected into the page. Exposes a single namespaced API,
 * window.__BA, that the background service worker calls into via
 * chrome.scripting.executeScript({ func: ... }). Nothing in this file
 * (or anything it calls) performs network I/O — see README "Privacy"
 * section.
 *
 * Guarded against double-injection: chrome.scripting.executeScript can
 * be called more than once on the same tab (e.g. user clicks "Analyze"
 * twice), so we only set up state/observers once per page load.
 */
(function (window) {
  if (window.__BA_state) {
    // Already injected on this page — nothing further to do here.
    return;
  }

  window.__BA_state = {
    registry: new Map(), // id -> live element, rebuilt every extraction
    lastResult: null,
    observer: null,
    debounceTimer: null
  };

  function resolveElement(id) {
    const cached = window.__BA_state.registry.get(id);
    if (cached && document.contains(cached)) return cached;

    // The page may have re-rendered (React/Vue/etc.) since the last
    // extraction. Fall back to the stored stable selector rather than
    // trusting a possibly-detached reference (see README "Avoiding
    // Stale Elements").
    const meta = window.__BA_state.lastResult &&
      window.__BA_state.lastResult.elements.find((e) => e.id === id);
    if (meta && meta.selector) {
      return window.__BA_Selectors.resolveSelector(meta.selector);
    }
    return null;
  }

  function dispatchNativeInput(el, text) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const BrowserAgent = {
    /** Runs a full extraction pass. This is the main entry point called from the popup. (async — see domExtractor.js) */
    runFullExtraction() {
      return window.__BA_DomExtractor.runExtraction();
    },

    /** Returns the most recent cached extraction without re-running the pipeline. */
    getLastResult() {
      return window.__BA_state.lastResult;
    },

    click(elementId) {
      const el = resolveElement(elementId);
      if (!el) return { success: false, reason: 'element_not_found' };
      if (!window.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight)) {
        return { success: false, reason: 'element_not_visible' };
      }
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { success: true };
    },

    type(elementId, text) {
      const el = resolveElement(elementId);
      if (!el) return { success: false, reason: 'element_not_found' };
      if (!window.__BA_Visibility.isElementVisible(el, window.innerWidth, window.innerHeight)) {
        return { success: false, reason: 'element_not_visible' };
      }
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') {
        return { success: false, reason: 'element_not_typeable' };
      }
      el.focus();
      dispatchNativeInput(el, text);
      return { success: true };
    },

    scroll(direction, amount = 400) {
      const delta = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      window.scrollBy({ top: delta, behavior: 'smooth' });
      return { success: true };
    },

    select(elementId, optionValue) {
      const el = resolveElement(elementId);
      if (!el || el.tagName.toLowerCase() !== 'select') {
        return { success: false, reason: 'element_not_found_or_not_select' };
      }
      el.value = optionValue;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    },

    /**
     * Sets up a debounced MutationObserver so a cached extraction stays
     * reasonably fresh on highly dynamic pages, WITHOUT reprocessing the
     * entire page on every single DOM mutation (see README "Handling
     * Dynamic Websites"). This only refreshes the in-memory cache used
     * by click()/type()/etc.'s selector-resolution fallback — it never
     * sends anything anywhere on its own.
     */
    startObserving() {
      if (window.__BA_state.observer) return;
      const observer = new MutationObserver(() => {
        clearTimeout(window.__BA_state.debounceTimer);
        window.__BA_state.debounceTimer = setTimeout(() => {
          try {
            window.__BA_DomExtractor.runExtraction();
          } catch (e) {
            /* swallow — a stale page mid-mutation shouldn't throw */
          }
        }, 400);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      window.__BA_state.observer = observer;
    },

    stopObserving() {
      if (window.__BA_state.observer) {
        window.__BA_state.observer.disconnect();
        window.__BA_state.observer = null;
      }
    }
  };

  window.__BA = BrowserAgent;
})(window);