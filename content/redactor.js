/**
 * content/redactor.js
 *
 * Draws opaque black rectangles over sensitive regions of a screenshot.
 * Runs in the POPUP context (it needs Canvas + Image, which a service
 * worker does not have, and the popup is where the screenshot is
 * displayed anyway). Everything here stays inside the extension —
 * the original, unredacted screenshot is discarded after this runs
 * and is never sent anywhere.
 */
(function (root) {
  /**
   * @param {string} screenshotDataUrl - PNG/JPEG data URL from chrome.tabs.captureVisibleTab
   * @param {Array} sensitiveItems - items with .bbox in DOM viewport coordinates
   * @param {{width:number,height:number}} viewport - viewport size at capture time
   * @param {number} padding - px padding around each redacted region (pre-scale)
   * @returns {Promise<{canvas: HTMLCanvasElement, dataUrl: string}>}
   */
  function redactScreenshot(screenshotDataUrl, sensitiveItems, viewport, padding = 4) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        ctx.fillStyle = '#000000';
        for (const item of sensitiveItems) {
          const box = root.__BA_CoordinateMapper.mapDomBoxToScreenshot(
            item.bbox,
            viewport,
            canvas.width,
            canvas.height,
            padding
          );
          if (box.width > 0 && box.height > 0) {
            ctx.fillRect(box.x, box.y, box.width, box.height);
          }
        }

        resolve({ canvas, dataUrl: canvas.toDataURL('image/png') });
      };
      img.onerror = reject;
      img.src = screenshotDataUrl;
    });
  }

  root.__BA_Redactor = { redactScreenshot };
})(window);
