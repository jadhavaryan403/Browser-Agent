/**
 * content/coordinateMapper.js
 *
 * Converts a DOM bounding box (CSS pixels, relative to the viewport)
 * into screenshot pixel coordinates.
 *
 * Loaded in TWO contexts:
 *   - the content script (not strictly required there, but kept
 *     available for symmetry / future use, e.g. if redaction ever
 *     moves back into the page context)
 *   - the popup, where the actual screenshot <img>/<canvas> lives and
 *     where the real scaling happens today
 *
 * See utils/geometry.js `scaleRectToImage` for why we scale using the
 * decoded image's actual pixel size rather than devicePixelRatio alone
 * (it self-corrects for zoom + DPR + OS scaling in one measurement).
 */
(function (root) {
  /**
   * @param {{x:number,y:number,width:number,height:number}} domBbox - viewport-relative CSS px box
   * @param {{width:number,height:number}} viewport - viewport CSS size captured at extraction time
   * @param {number} imageWidth - decoded screenshot width in pixels
   * @param {number} imageHeight - decoded screenshot height in pixels
   * @param {number} [padding=4] - extra px to grow the box by, to avoid partial leakage at edges
   */
  function mapDomBoxToScreenshot(domBbox, viewport, imageWidth, imageHeight, padding = 4) {
    const scaled = root.__BA_Geometry.scaleRectToImage(domBbox, viewport, imageWidth, imageHeight);
    // Padding is applied in image-pixel space, scaled proportionally so
    // it looks consistent regardless of DPR.
    const scaleAvg = (imageWidth / viewport.width + imageHeight / viewport.height) / 2;
    const padded = root.__BA_Geometry.padRect(scaled, padding * scaleAvg);
    return root.__BA_Geometry.clampRect(padded, imageWidth, imageHeight);
  }

  root.__BA_CoordinateMapper = { mapDomBoxToScreenshot };
})(typeof window !== 'undefined' ? window : self);
