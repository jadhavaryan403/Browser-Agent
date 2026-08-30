/**
 * content/visibility.js
 *
 * Determines whether an element is *actually visible to the user right
 * now* — on screen, not display:none/visibility:hidden/opacity:0, and
 * not zero-sized. This is the gatekeeper used before an element is ever
 * added to the extracted DOM list, per the extension's "only what the
 * user can see" principle.
 */
(function (root) {
  function isStyleVisible(el) {
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  /**
   * Walks up the ancestor chain to make sure no ancestor is itself
   * hidden (display:none on a parent hides children even if their own
   * computed style looks fine in some edge cases with detached checks).
   */
  function ancestorsVisible(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (!isStyleVisible(node)) return false;
      node = node.parentElement;
    }
    return true;
  }

  /**
   * Core visibility check combining geometry + computed style.
   * viewportWidth/Height should be window.innerWidth/innerHeight.
   */
  function isElementVisible(el, viewportWidth, viewportHeight) {
    if (!el || el.nodeType !== 1) return false;

    const rect = el.getBoundingClientRect();
    if (!root.__BA_Geometry.rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
      return false;
    }

    if (!isStyleVisible(el)) return false;
    if (!ancestorsVisible(el)) return false;

    // elementFromPoint sanity check: is *this* element (or a descendant
    // of it, e.g. an inner <span> inside a <button>) actually the
    // topmost thing at its own center point? This filters out elements
    // fully hidden behind an unrelated overlay/modal.
    try {
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), viewportWidth - 1);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), viewportHeight - 1);
      const topEl = document.elementFromPoint(cx, cy);
      if (topEl && !(el.contains(topEl) || topEl.contains(el))) {
        return false;
      }
    } catch (e) {
      // If elementFromPoint fails for any reason, don't block on it.
    }

    return true;
  }

  root.__BA_Visibility = { isElementVisible, isStyleVisible };
})(window);
