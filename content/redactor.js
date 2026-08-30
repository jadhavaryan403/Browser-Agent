/**
 * content/redactor.js
 *
 * Redacts:
 *
 * 1. DOM-detected PII
 * 2. Face bounding boxes detected by YuNet
 *
 * Face boxes are already expressed in screenshot
 * pixel coordinates, so they do NOT go through
 * the DOM coordinate mapper.
 */

(function (root) {

  function redactScreenshot(
    screenshotDataUrl,
    sensitiveItems,
    viewport,
    padding = 4,
    faceBoxes = []
  ) {

    return new Promise(
      (resolve, reject) => {

        const img =
          new Image();

        img.onload = () => {

          const canvas =
            document.createElement(
              'canvas'
            );

          canvas.width =
            img.naturalWidth;

          canvas.height =
            img.naturalHeight;

          const ctx =
            canvas.getContext('2d');

          ctx.drawImage(
            img,
            0,
            0
          );

          ctx.fillStyle =
            '#000000';


          // ==================================================
          // 1. REDACT DOM-DETECTED PII
          // ==================================================

          for (
            const item
            of sensitiveItems
          ) {

            const box =
              root
                .__BA_CoordinateMapper
                .mapDomBoxToScreenshot(
                  item.bbox,
                  viewport,
                  canvas.width,
                  canvas.height,
                  padding
                );

            if (
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


          // ==================================================
          // 2. REDACT FACES
          // ==================================================

          for (
            const face
            of faceBoxes
          ) {

            let x =
              Math.floor(
                face.x - padding
              );

            let y =
              Math.floor(
                face.y - padding
              );

            let width =
              Math.ceil(
                face.width +
                padding * 2
              );

            let height =
              Math.ceil(
                face.height +
                padding * 2
              );


            // Clamp to screenshot.
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

            width =
              Math.min(
                width,
                canvas.width - x
              );

            height =
              Math.min(
                height,
                canvas.height - y
              );


            if (
              width > 0 &&
              height > 0
            ) {

              ctx.fillRect(
                x,
                y,
                width,
                height
              );
            }
          }


          resolve({
            canvas,
            dataUrl:
              canvas.toDataURL(
                'image/png'
              )
          });

        };

        img.onerror =
          reject;

        img.src =
          screenshotDataUrl;
      }
    );
  }


  root.__BA_Redactor = {
    redactScreenshot
  };

})(window);