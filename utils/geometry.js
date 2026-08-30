/**
 * utils/geometry.js
 *
 * Pure geometry helpers shared by the content-script extraction code
 * and the popup's redaction/rendering code. No DOM access here except
 * where a DOMRect-like object is passed in explicitly, so this file is
 * safe to load in either context.
 */
(function (root) {
  /**
   * Returns true if a client rect (viewport-relative, CSS pixels)
   * intersects the given viewport dimensions and has non-zero size.
   */
  function rectIntersectsViewport(rect, viewportWidth, viewportHeight) {
    if (!rect) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    if (rect.top >= viewportHeight || rect.left >= viewportWidth) return false;
    return true;
  }

  /** Clamp a rect so it lies fully within [0,0,width,height]. */
  function clampRect(rect, width, height) {
    const x1 = Math.max(0, rect.x);
    const y1 = Math.max(0, rect.y);
    const x2 = Math.min(width, rect.x + rect.width);
    const y2 = Math.min(height, rect.y + rect.height);
    return {
      x: x1,
      y: y1,
      width: Math.max(0, x2 - x1),
      height: Math.max(0, y2 - y1)
    };
  }

  /** Grow a rect by `padding` px on every side. */
  function padRect(rect, padding) {
    return {
      x: rect.x - padding,
      y: rect.y - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2
    };
  }

  /** Convert a DOMRect (or rect-like) into our plain {x,y,width,height} shape. */
  function toPlainRect(domRect) {
    return {
      x: domRect.left,
      y: domRect.top,
      width: domRect.width,
      height: domRect.height
    };
  }

  /**
   * Scale a CSS-pixel, viewport-relative rect into screenshot pixel
   * coordinates.
   *
   * Why a ratio instead of just multiplying by devicePixelRatio?
   * chrome.tabs.captureVisibleTab() returns an image whose pixel
   * dimensions already reflect the actual rendered size of the visible
   * viewport (accounting for devicePixelRatio AND page zoom). Rather
   * than trying to reconstruct that from devicePixelRatio + zoom
   * separately (fragile, differs across platforms), we measure the
   * actual decoded image size and derive the scale factor directly.
   * This self-corrects for zoom, DPR, and OS-level scaling in one step.
   */
  function scaleRectToImage(rect, viewport, imageWidth, imageHeight) {
    const scaleX = imageWidth / viewport.width;
    const scaleY = imageHeight / viewport.height;
    return {
      x: rect.x * scaleX,
      y: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY
    };
  }

  root.__BA_Geometry = {
    rectIntersectsViewport,
    clampRect,
    padRect,
    toPlainRect,
    scaleRectToImage
  };
})(typeof window !== 'undefined' ? window : self);
