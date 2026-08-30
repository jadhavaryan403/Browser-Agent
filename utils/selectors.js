/**
 * utils/selectors.js
 *
 * Builds a reasonably stable CSS selector for an element so that we can
 * re-resolve it later (e.g. right before performing a click) instead of
 * holding on to a stale live DOM reference across re-extractions.
 *
 * Preference order:
 *   1. #id                                (fastest, most stable)
 *   2. [data-testid]/[data-test]/[data-qa] (common test hooks, stable)
 *   3. tag + nth-of-type path from a nearby ancestor with an id
 *   4. full nth-of-type path from <html>   (last resort, still unique)
 */
(function (root) {
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    // Minimal fallback escape.
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function nthOfTypeIndex(el) {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function segmentFor(el) {
    const tag = el.tagName.toLowerCase();
    return `${tag}:nth-of-type(${nthOfTypeIndex(el)})`;
  }

  function buildPath(el, stopAtId) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && stopAtId) {
        parts.unshift(`#${cssEscape(node.id)}`);
        return parts.join(' > ');
      }
      parts.unshift(segmentFor(node));
      node = node.parentElement;
    }
    parts.unshift('html');
    return parts.join(' > ');
  }

  /**
   * Returns a CSS selector string that should uniquely resolve back to
   * `el` within the current document.
   */
  function getStableSelector(el) {
    if (!el || el.nodeType !== 1) return null;

    if (el.id) {
      const sel = `#${cssEscape(el.id)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    for (const attr of ['data-testid', 'data-test', 'data-qa']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = `[${attr}="${cssEscape(val)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Try a path that stops early at the nearest ancestor with an id.
    const shortPath = buildPath(el, true);
    if (shortPath && document.querySelectorAll(shortPath).length === 1) {
      return shortPath;
    }

    // Last resort: full path from <html>, guaranteed unique.
    return buildPath(el, false);
  }

  /** Resolve a selector back to a single live element, or null. */
  function resolveSelector(selector) {
    if (!selector) return null;
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length >= 1 ? matches[0] : null;
    } catch (e) {
      return null;
    }
  }

  root.__BA_Selectors = { getStableSelector, resolveSelector };
})(typeof window !== 'undefined' ? window : self);
