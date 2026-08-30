/**
 * offscreen.js
 *
 * Runs ONNX Runtime Web inside a Chrome Extension offscreen document.
 *
 * NER confidence threshold:
 *   0.80 (80%)
 *
 * Only token predictions with confidence >= 0.85
 * are considered PII entities.
 */

const MODEL_DIR = 'models/ner/';

const MODEL_FILE = 'model_quantized.onnx';
const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';
const MODEL_CONFIG_FILE = 'config.json';

const MAX_SEQ_LEN = 256;

/* ============================================================
   NER CONFIDENCE THRESHOLD
   ============================================================ */

const NER_CONFIDENCE_THRESHOLD = 0.85;

let modelResourcesPromise = null;


// ============================================================
// YuNet face detector
// ============================================================

const FACE_MODEL_FILE =
  'models/face_detection_yunet_2023mar.onnx';

const FACE_INPUT_WIDTH = 640;
const FACE_INPUT_HEIGHT = 640;
  
const FACE_CONFIDENCE_THRESHOLD = 0.50;
const FACE_NMS_THRESHOLD = 0.30;
const FACE_TOP_K = 5000;

let faceDetectorPromise = null;


// ============================================================
// YuNet utilities
// ============================================================

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}


function decodeYuNet(
  outputs,
  originalWidth,
  originalHeight
) {
  const faces = [];

  const strides = [8, 16, 32];

  /*
   * The ONNX model expects 640x640.
   *
   * YuNet coordinates are first decoded
   * in the 640x640 model coordinate system,
   * then scaled back to the screenshot.
   */
  const scaleX =
    originalWidth / FACE_INPUT_WIDTH;

  const scaleY =
    originalHeight / FACE_INPUT_HEIGHT;

  for (const stride of strides) {

    const clsTensor =
      outputs[`cls_${stride}`];

    const objTensor =
      outputs[`obj_${stride}`];

    const bboxTensor =
      outputs[`bbox_${stride}`];

    if (
      !clsTensor ||
      !objTensor ||
      !bboxTensor
    ) {
      console.error(
        `[YuNet] Missing outputs for stride ${stride}`
      );
      continue;
    }

    const cls =
      clsTensor.data;

    const obj =
      objTensor.data;

    const bbox =
      bboxTensor.data;

    /*
     * 640x640 input:
     *
     * stride 8  -> 80 x 80
     * stride 16 -> 40 x 40
     * stride 32 -> 20 x 20
     */
    const featureWidth =
      FACE_INPUT_WIDTH / stride;

    const featureHeight =
      FACE_INPUT_HEIGHT / stride;

    const numAnchors =
      featureWidth * featureHeight;

    for (
      let i = 0;
      i < numAnchors;
      i++
    ) {

      /*
       * Classification and objectness
       */
      let clsScore =
        cls[i];

      let objScore =
        obj[i];

      /*
       * Clamp scores just like OpenCV.
       */
      clsScore =
        Math.max(
          0,
          Math.min(
            1,
            clsScore
          )
        );

      objScore =
        Math.max(
          0,
          Math.min(
            1,
            objScore
          )
        );

      /*
       * YuNet final confidence.
       */
      const score =
        Math.sqrt(
          clsScore *
          objScore
        );

      if (
        score <
        FACE_CONFIDENCE_THRESHOLD
      ) {
        continue;
      }

      /*
       * Feature-map coordinates.
       */
      const gridX =
        i % featureWidth;

      const gridY =
        Math.floor(
          i / featureWidth
        );

      /*
       * Bounding-box regression.
       *
       * YuNet stores:
       *
       * [dx, dy, dw, dh]
       *
       * where:
       *
       * cx = (gridX + dx) * stride
       * cy = (gridY + dy) * stride
       * w  = exp(dw) * stride
       * h  = exp(dh) * stride
       */
      const offset =
        i * 4;

      const dx =
        bbox[offset];

      const dy =
        bbox[offset + 1];

      const dw =
        bbox[offset + 2];

      const dh =
        bbox[offset + 3];

      /*
       * Decode in 640x640 coordinates.
       */
      const centerX =
        (
          gridX +
          dx
        ) * stride;

      const centerY =
        (
          gridY +
          dy
        ) * stride;

      const width =
        Math.exp(dw) *
        stride;

      const height =
        Math.exp(dh) *
        stride;

      const left =
        centerX -
        width / 2;

      const top =
        centerY -
        height / 2;

      /*
       * Convert 640x640 coordinates
       * to screenshot coordinates.
       */
      let x =
        left * scaleX;

      let y =
        top * scaleY;

      let w =
        width * scaleX;

      let h =
        height * scaleY;

      /*
       * Clamp to screenshot.
       */
      x =
        Math.max(
          0,
          Math.min(
            originalWidth,
            x
          )
        );

      y =
        Math.max(
          0,
          Math.min(
            originalHeight,
            y
          )
        );

      w =
        Math.min(
          w,
          originalWidth - x
        );

      h =
        Math.min(
          h,
          originalHeight - y
        );

      if (
        w <= 0 ||
        h <= 0
      ) {
        continue;
      }

      faces.push({
        x,
        y,
        width: w,
        height: h,
        confidence: score
      });
    }
  }

  console.log(
    "[YuNet] Before NMS:",
    faces.length
  );

  const result =
    nonMaximumSuppression(
      faces,
      FACE_NMS_THRESHOLD,
      FACE_TOP_K
    );

  console.log(
    "[YuNet] After NMS:",
    result.length
  );

  console.log(
    "[YuNet] FINAL FACES:",
    JSON.stringify(result, null, 2)
  );

  return result;
}



/**
 * IoU calculation.
 */
function faceIoU(a, b) {

  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;

  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;

  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);

  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);

  const intersection = iw * ih;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  const union =
    areaA +
    areaB -
    intersection;

  return union > 0
    ? intersection / union
    : 0;
}


/**
 * Non-maximum suppression.
 */
function nonMaximumSuppression(
  faces,
  threshold,
  topK
) {

  faces.sort(
    (a, b) =>
      b.confidence -
      a.confidence
  );

  const selected = [];

  for (const face of faces) {

    let suppressed = false;

    for (const selectedFace of selected) {

      if (
        faceIoU(face, selectedFace) >=
        threshold
      ) {
        suppressed = true;
        break;
      }
    }

    if (!suppressed) {
      selected.push(face);
    }

    if (selected.length >= topK) {
      break;
    }
  }

  return selected;
}


// ============================================================
// Load YuNet
// ============================================================

async function loadFaceDetector() {

  console.log(
      "[YuNet] Loading model..."
  );

  const modelUrl =
      chrome.runtime.getURL(
          "models/face_detection_yunet_2023mar.onnx"
      );

  console.log(
      "[YuNet] Model URL:",
      modelUrl
  );

  try {

      const test =
          await fetch(
              modelUrl
          );

      console.log(
          "[YuNet] Model fetch:",
          test.status,
          test.statusText
      );

      if (!test.ok) {
          throw new Error(
              `YuNet model HTTP ${test.status}`
          );
      }

      const session =
          await ort.InferenceSession.create(
              modelUrl,
              {
                  executionProviders: [
                      "wasm"
                  ]
              }
          );

      console.log(
          "[YuNet] Model loaded successfully"
      );

      return session;

  } catch (error) {

      console.error(
          "[YuNet] MODEL LOAD FAILED:",
          error
      );

      throw error;
  }
}


function ensureFaceDetectorLoaded() {

  if (!faceDetectorPromise) {

    faceDetectorPromise =
      loadFaceDetector()
        .catch((error) => {

          faceDetectorPromise = null;

          throw error;

        });
  }

  return faceDetectorPromise;
}


// ============================================================
// Convert screenshot -> YuNet input tensor
// ============================================================

async function prepareYuNetInputFromBitmap(bitmap) {

  const canvas =
      new OffscreenCanvas(
          FACE_INPUT_WIDTH,
          FACE_INPUT_HEIGHT
      );

  const ctx =
      canvas.getContext("2d", {
          willReadFrequently: true
      });

  ctx.drawImage(
      bitmap,
      0,
      0,
      FACE_INPUT_WIDTH,
      FACE_INPUT_HEIGHT
  );

  const imageData =
      ctx.getImageData(
          0,
          0,
          FACE_INPUT_WIDTH,
          FACE_INPUT_HEIGHT
      );

  const rgba =
      imageData.data;

  const planeSize =
      FACE_INPUT_WIDTH *
      FACE_INPUT_HEIGHT;

  const data =
      new Float32Array(
          planeSize * 3
      );

  for (
      let i = 0;
      i < planeSize;
      i++
  ) {
      const r =
          rgba[i * 4];

      const g =
          rgba[i * 4 + 1];

      const b =
          rgba[i * 4 + 2];

      // B
      data[i] = b;

      // G
      data[
          planeSize + i
      ] = g;

      // R
      data[
          planeSize * 2 + i
      ] = r;
  }

  return new ort.Tensor(
      "float32",
      data,
      [
          1,
          3,
          FACE_INPUT_HEIGHT,
          FACE_INPUT_WIDTH
      ]
  );
}


function calculateIoU(a, b) {
  const ax1 = a.x;
  const ay1 = a.y;

  const ax2 =
      a.x + a.width;

  const ay2 =
      a.y + a.height;

  const bx1 = b.x;
  const by1 = b.y;

  const bx2 =
      b.x + b.width;

  const by2 =
      b.y + b.height;

  const ix1 =
      Math.max(ax1, bx1);

  const iy1 =
      Math.max(ay1, by1);

  const ix2 =
      Math.min(ax2, bx2);

  const iy2 =
      Math.min(ay2, by2);

  const intersectionWidth =
      Math.max(
          0,
          ix2 - ix1
      );

  const intersectionHeight =
      Math.max(
          0,
          iy2 - iy1
      );

  const intersection =
      intersectionWidth *
      intersectionHeight;

  const areaA =
      a.width * a.height;

  const areaB =
      b.width * b.height;

  const union =
      areaA +
      areaB -
      intersection;

  if (union <= 0) {
      return 0;
  }

  return intersection / union;
}


function nonMaximumSuppression(
  faces,
  threshold,
  topK
) {
  faces.sort(
      (a, b) =>
          b.confidence -
          a.confidence
  );

  const selected = [];

  for (const face of faces) {

      let keep = true;

      for (
          const selectedFace
          of selected
      ) {

          if (
              calculateIoU(
                  face,
                  selectedFace
              ) >= threshold
          ) {
              keep = false;
              break;
          }
      }

      if (keep) {
          selected.push(face);
      }

      if (
          selected.length >= topK
      ) {
          break;
      }
  }

  console.log(
      "[YuNet] After NMS:",
      selected.length
  );

  return selected;
}


// ============================================================
// Detect faces in screenshot
// ============================================================

async function detectFaces(screenshotDataUrl) {
  try {
      console.log(
          "[YuNet] Starting face detection"
      );

      const session =
          await ensureFaceDetectorLoaded();

      console.log(
          "[YuNet] Model loaded"
      );

      const bitmap =
          await createImageBitmapFromDataUrl(
              screenshotDataUrl
          );

      const originalWidth =
          bitmap.width;

      const originalHeight =
          bitmap.height;

      console.log(
          "[YuNet] Original screenshot:",
          originalWidth,
          "x",
          originalHeight
      );

      const input =
          await prepareYuNetInputFromBitmap(
              bitmap
          );

      bitmap.close();

      console.log(
          "[YuNet] Input tensor:",
          input.dims
      );

      const inputName =
          session.inputNames[0];

      const outputs =
          await session.run({
              [inputName]: input
          });

      console.log(
          "[YuNet] Inference completed"
      );

      const faces =
          decodeYuNet(
              outputs,
              originalWidth,
              originalHeight
          );

      console.log(
          "[YuNet] FINAL FACES:",
          faces
      );

      return faces;

  } catch (error) {

      console.error(
          "[offscreen] Face detection failed:",
          error
      );

      console.error(
          "[offscreen] Error name:",
          error?.name
      );

      console.error(
          "[offscreen] Error message:",
          error?.message
      );

      console.error(
          "[offscreen] Error stack:",
          error?.stack
      );

      throw error;
  }
}


/* ============================================================
   Extension URL helper
   ============================================================ */

function extURL(path) {
  return chrome.runtime.getURL(path);
}


async function createImageBitmapFromDataUrl(screenshot) {
  try {
      console.log(
          "[YuNet] Received screenshot:",
          screenshot
      );

      let dataUrl = screenshot;

      if (
          typeof screenshot === "object" &&
          screenshot !== null
      ) {
          dataUrl =
              screenshot.dataUrl ??
              screenshot.dataURL ??
              screenshot.image ??
              screenshot.screenshot;
      }

      if (
          typeof dataUrl !== "string"
      ) {
          throw new Error(
              `Screenshot is not a string. Received: ${typeof dataUrl}`
          );
      }

      if (
          !dataUrl.startsWith("data:image/")
      ) {
          throw new Error(
              "Screenshot is not a valid image data URL"
          );
      }

      const commaIndex =
          dataUrl.indexOf(",");

      if (commaIndex === -1) {
          throw new Error(
              "Invalid data URL"
          );
      }

      const base64 =
          dataUrl.substring(
              commaIndex + 1
          );

      const binary =
          atob(base64);

      const bytes =
          new Uint8Array(
              binary.length
          );

      for (
          let i = 0;
          i < binary.length;
          i++
      ) {
          bytes[i] =
              binary.charCodeAt(i);
      }

      const mime =
          dataUrl
              .substring(
                  5,
                  commaIndex
              )
              .split(";")[0];

      const blob =
          new Blob(
              [bytes],
              { type: mime }
          );

      return await createImageBitmap(
          blob
      );

  } catch (error) {
      throw new Error(
          `Could not create screenshot bitmap: ${
              error.message || error
          }`
      );
  }
}


/* ============================================================
   JSON loader
   ============================================================ */

async function fetchJson(relativePath) {

  const url = extURL(relativePath);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `[offscreen] ${relativePath} returned HTTP ${response.status}`
    );
  }

  return response.json();
}


/* ============================================================
   Load model resources
   ============================================================ */

async function loadModelResources() {

  if (typeof ort === 'undefined') {

    throw new Error(
      '[offscreen] onnxruntime-web ("ort") not found on window.'
    );
  }


  console.log(
    '[offscreen] Loading NER model...'
  );


  /* ----------------------------------------------------------
     ONNX Runtime
     ---------------------------------------------------------- */

  ort.env.wasm.wasmPaths =
    extURL('lib/');

  ort.env.wasm.numThreads = 1;

  ort.env.wasm.proxy = false;


  /* ----------------------------------------------------------
     Tokenizer
     ---------------------------------------------------------- */

  const tokenizerJson =
    await fetchJson(
      MODEL_DIR + TOKENIZER_FILE
    );


  const tokenizerConfig =
    await fetchJson(
      MODEL_DIR + TOKENIZER_CONFIG_FILE
    );


  /* ----------------------------------------------------------
     Model config
     ----------------------------------------------------------

     id2label should come from config.json.

     Example:

     {
       "id2label": {
         "0": "O",
         "1": "B-PERSON",
         "2": "I-PERSON"
       }
     }
     ---------------------------------------------------------- */

  let modelConfig = {};

  try {

    modelConfig =
      await fetchJson(
        MODEL_DIR + MODEL_CONFIG_FILE
      );

  } catch (error) {

    console.warn(
      '[offscreen] config.json could not be loaded:',
      error.message
    );
  }


  /* ----------------------------------------------------------
     Vocabulary
     ---------------------------------------------------------- */

  const vocab =
    tokenizerJson.model &&
    tokenizerJson.model.vocab;


  if (!vocab) {

    throw new Error(
      '[offscreen] tokenizer.json missing model.vocab'
    );
  }


  /* ----------------------------------------------------------
     Lowercase configuration
     ---------------------------------------------------------- */

  const normalizer =
    tokenizerJson.normalizer || {};


  const doLowerCase =
    normalizer.lowercase === true ||
    (
      Array.isArray(
        normalizer.normalizers
      ) &&
      normalizer.normalizers.some(
        (n) =>
          n &&
          n.lowercase === true
      )
    );


  /* ----------------------------------------------------------
     Special tokens
     ---------------------------------------------------------- */

  const unkToken =
    (
      tokenizerJson.model &&
      tokenizerJson.model.unk_token
    ) ||
    tokenizerConfig.unk_token ||
    '[UNK]';


  const clsToken =
    tokenizerConfig.cls_token ||
    '[CLS]';


  const sepToken =
    tokenizerConfig.sep_token ||
    '[SEP]';


  const padToken =
    tokenizerConfig.pad_token ||
    '[PAD]';


  const clsId =
    vocab[clsToken] !== undefined
      ? vocab[clsToken]
      : vocab['[CLS]'];


  const sepId =
    vocab[sepToken] !== undefined
      ? vocab[sepToken]
      : vocab['[SEP]'];


  const padId =
    vocab[padToken] !== undefined
      ? vocab[padToken]
      : (
          vocab['[PAD]'] !== undefined
            ? vocab['[PAD]']
            : 0
        );


  if (clsId === undefined) {

    throw new Error(
      '[offscreen] Could not find CLS token ID.'
    );
  }


  if (sepId === undefined) {

    throw new Error(
      '[offscreen] Could not find SEP token ID.'
    );
  }


  /* ----------------------------------------------------------
     Label mapping
     ---------------------------------------------------------- */

  const id2label =
    modelConfig.id2label ||
    tokenizerConfig.id2label ||
    {};


  console.log(
    '[offscreen] ID2LABEL:',
    id2label
  );


  if (
    Object.keys(id2label).length === 0
  ) {

    console.warn(
      '[offscreen] WARNING: No id2label mapping found.'
    );
  }


  /* ----------------------------------------------------------
     Load ONNX model
     ---------------------------------------------------------- */

  const modelUrl =
    extURL(
      MODEL_DIR + MODEL_FILE
    );


  const session =
    await ort.InferenceSession.create(
      modelUrl,
      {
        executionProviders: [
          'wasm'
        ]
      }
    );


  console.log(
    '[offscreen] ONNX model loaded.'
  );


  console.log(
    '[offscreen] Model inputs:',
    session.inputNames
  );


  console.log(
    '[offscreen] Model outputs:',
    session.outputNames
  );


  return {

    session,

    vocab,

    id2label,

    doLowerCase,

    unkToken,

    clsId,

    sepId,

    padId
  };
}


/* ============================================================
   Ensure model loaded once
   ============================================================ */

function ensureModelLoaded() {

  if (!modelResourcesPromise) {

    modelResourcesPromise =
      loadModelResources()
        .catch((error) => {

          modelResourcesPromise = null;

          throw error;
        });
  }

  return modelResourcesPromise;
}


/* ============================================================
   Character helpers
   ============================================================ */

function isWhitespace(ch) {

  return /\s/.test(ch);
}


function isPunctuation(ch) {

  const cp =
    ch.codePointAt(0);

  return (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  );
}


/* ============================================================
   Basic tokenizer
   ============================================================ */

function basicTokenizeWithOffsets(text) {

  const tokens = [];

  let i = 0;

  const n = text.length;


  while (i < n) {

    const ch = text[i];


    if (isWhitespace(ch)) {

      i++;

      continue;
    }


    if (isPunctuation(ch)) {

      tokens.push({

        text: ch,

        start: i,

        end: i + 1
      });

      i++;

      continue;
    }


    let j = i + 1;


    while (
      j < n &&
      !isWhitespace(text[j]) &&
      !isPunctuation(text[j])
    ) {

      j++;
    }


    tokens.push({

      text:
        text.slice(
          i,
          j
        ),

      start: i,

      end: j
    });


    i = j;
  }


  return tokens;
}


/* ============================================================
   WordPiece tokenizer
   ============================================================ */

function wordpieceTokenizeWithOffsets(
  word,
  vocab,
  unkToken
) {

  const {
    text,
    start
  } = word;


  const output = [];

  const len =
    text.length;


  if (len === 0) {

    return output;
  }


  let curStart = 0;


  while (
    curStart < len
  ) {

    let curEnd = len;

    let matched = null;


    while (
      curStart < curEnd
    ) {

      let sub =
        text.slice(
          curStart,
          curEnd
        );


      if (curStart > 0) {

        sub =
          '##' + sub;
      }


      if (
        Object.prototype.hasOwnProperty.call(
          vocab,
          sub
        )
      ) {

        matched = sub;

        break;
      }


      curEnd--;
    }


    if (matched === null) {

      return [

        {
          text: unkToken,

          start,

          end:
            start + len,

          isUnk: true
        }

      ];
    }


    output.push({

      text: matched,

      start:
        start + curStart,

      end:
        start + curEnd
    });


    curStart =
      curEnd;
  }


  return output;
}


/* ============================================================
   Tokenize text with character offsets
   ============================================================ */

function tokenizeWithOffsets(
  text,
  vocab,
  doLowerCase,
  unkToken
) {

  const words =
    basicTokenizeWithOffsets(
      text
    );


  const pieces = [];


  for (const word of words) {

    const wordForVocab =
      doLowerCase
        ? word.text.toLowerCase()
        : word.text;


    const subPieces =
      wordpieceTokenizeWithOffsets(
        {
          text:
            wordForVocab,

          start:
            word.start
        },

        vocab,

        unkToken
      );


    for (
      const piece of subPieces
    ) {

      pieces.push(
        piece
      );
    }
  }


  return pieces;
}


/* ============================================================
   Build ONNX model inputs
   ============================================================ */

function buildModelInputs(
  pieces,
  ready,
  maxLen
) {

  const truncated =
    pieces.slice(
      0,
      Math.max(
        0,
        maxLen - 2
      )
    );


  const ids = [
    ready.clsId
  ];


  const offsets = [
    [0, 0]
  ];


  for (
    const piece of truncated
  ) {

    const id =
      Object.prototype.hasOwnProperty.call(
        ready.vocab,
        piece.text
      )

        ? ready.vocab[
            piece.text
          ]

        : ready.vocab[
            ready.unkToken
          ];


    ids.push(id);


    offsets.push([
      piece.start,
      piece.end
    ]);
  }


  ids.push(
    ready.sepId
  );


  offsets.push([
    0,
    0
  ]);


  const inputIds =
    new BigInt64Array(
      ids.map(
        (value) =>
          BigInt(value)
      )
    );


  const attentionMask =
    new BigInt64Array(
      ids.length
    );


  attentionMask.fill(1n);


  const tokenTypeIds =
    new BigInt64Array(
      ids.length
    );


  tokenTypeIds.fill(0n);


  return {

    inputIds,

    attentionMask,

    tokenTypeIds,

    offsets
  };
}


/* ============================================================
   Parse BIO label
   ============================================================ */

function parseEntityLabel(
  label
) {

  if (!label) {

    return {

      prefix: 'O',

      entityType: 'O'
    };
  }


  const normalized =
    String(label)
      .trim()
      .toUpperCase();


  if (
    normalized === 'O' ||
    normalized === '0'
  ) {

    return {

      prefix: 'O',

      entityType: 'O'
    };
  }


  const bioMatch =
    normalized.match(
      /^([BI])[-_](.+)$/
    );


  if (bioMatch) {

    return {

      prefix:
        bioMatch[1],

      entityType:
        bioMatch[2]
    };
  }


  return {

    prefix: 'B',

    entityType:
      normalized
  };
}


/* ============================================================
   Normalize entity type
   ============================================================ */

function normalizeEntityType(
  entityType
) {

  if (!entityType) {

    return 'UNKNOWN';
  }


  let key =
    String(entityType)
      .toUpperCase()
      .trim()
      .replace(
        /[\s_-]/g,
        ''
      );


  key =
    key.replace(
      /^[BI]/,
      ''
    );


  const ENTITY_TYPE_MAP = {

    /* Person */

    NAME: 'NAME',

    PERSON: 'NAME',

    PER: 'NAME',

    GIVENNAME: 'NAME',

    FIRSTNAME: 'NAME',

    LASTNAME: 'NAME',

    SURNAME: 'NAME',

    MIDDLENAME: 'NAME',


    /* Location */

    LOCATION: 'LOCATION',

    LOC: 'LOCATION',

    CITY: 'LOCATION',

    STATE: 'LOCATION',

    COUNTRY: 'LOCATION',


    /* Organization */

    ORGANIZATION: 'ORGANIZATION',

    ORG: 'ORGANIZATION',


    /* Email */

    EMAIL: 'EMAIL',

    EMAILADDRESS: 'EMAIL',


    /* Phone */

    TEL: 'PHONE',

    PHONE: 'PHONE',

    PHONENUMBER: 'PHONE',

    PHONEIMEI: 'PHONE',


    /* Credit card */

    CREDITCARD: 'CARD',

    CREDITCARDNUMBER: 'CARD',

    CREDITCARDCVV: 'CARD',


    /* IP */

    IP: 'IP_ADDRESS',

    IPV4: 'IP_ADDRESS',

    IPV6: 'IP_ADDRESS'
  };


  return (
    ENTITY_TYPE_MAP[key] ||
    key
  );
}


/* ============================================================
   Calculate winning label confidence
   ============================================================ */

function calculateConfidence(
  data,
  base,
  numLabels,
  bestScore
) {

  let sumExp = 0;


  for (
    let l = 0;
    l < numLabels;
    l++
  ) {

    sumExp +=
      Math.exp(
        data[
          base + l
        ] - bestScore
      );
  }


  return (
    1 / sumExp
  );
}


/* ============================================================
   NER inference
   ============================================================ */

async function runNerOnText(
  text
) {

  if (
    !text ||
    !text.trim()
  ) {

    return [];
  }


  console.log(
    '[offscreen] NER INPUT:',
    JSON.stringify(text)
  );


  /* ----------------------------------------------------------
     Load model
     ---------------------------------------------------------- */

  const ready =
    await ensureModelLoaded();


  /* ----------------------------------------------------------
     Tokenize
     ---------------------------------------------------------- */

  const pieces =
    tokenizeWithOffsets(
      text,

      ready.vocab,

      ready.doLowerCase,

      ready.unkToken
    );


  if (
    pieces.length === 0
  ) {

    return [];
  }


  console.log(
    '[offscreen] TOKEN PIECES:',
    pieces
  );


  /* ----------------------------------------------------------
     Build inputs
     ---------------------------------------------------------- */

  const {
    inputIds,

    attentionMask,

    tokenTypeIds,

    offsets

  } =
    buildModelInputs(
      pieces,

      ready,

      MAX_SEQ_LEN
    );


  const seqLen =
    inputIds.length;


  /* ----------------------------------------------------------
     Create ONNX feeds
     ---------------------------------------------------------- */

  const inputNames =
    ready.session.inputNames ||
    [];


  const feeds = {};


  if (
    inputNames.includes(
      'input_ids'
    )
  ) {

    feeds.input_ids =
      new ort.Tensor(
        'int64',

        inputIds,

        [
          1,
          seqLen
        ]
      );
  }


  if (
    inputNames.includes(
      'attention_mask'
    )
  ) {

    feeds.attention_mask =
      new ort.Tensor(
        'int64',

        attentionMask,

        [
          1,
          seqLen
        ]
      );
  }


  if (
    inputNames.includes(
      'token_type_ids'
    )
  ) {

    feeds.token_type_ids =
      new ort.Tensor(
        'int64',

        tokenTypeIds,

        [
          1,
          seqLen
        ]
      );
  }


  console.log(
    '[offscreen] ONNX FEEDS:',
    Object.keys(feeds)
  );


  /* ----------------------------------------------------------
     Run inference
     ---------------------------------------------------------- */

  const outputMap =
    await ready.session.run(
      feeds
    );


  const outputNames =
    ready.session.outputNames;


  if (
    !outputNames ||
    outputNames.length === 0
  ) {

    throw new Error(
      '[offscreen] ONNX model returned no outputs.'
    );
  }


  const logitsTensor =
    outputMap[
      outputNames[0]
    ];


  if (!logitsTensor) {

    throw new Error(
      '[offscreen] Could not find logits output.'
    );
  }


  const dims =
    logitsTensor.dims;


  const numLabels =
    dims[
      dims.length - 1
    ];


  const data =
    logitsTensor.data;


  console.log(
    '[offscreen] LOGITS DIMS:',
    dims
  );


  console.log(
    '[offscreen] NUMBER OF LABELS:',
    numLabels
  );


  /* ----------------------------------------------------------
     Decode predictions
     ---------------------------------------------------------- */

  const spans = [];

  let current = null;


  for (
    let t = 0;
    t < seqLen;
    t++
  ) {

    const [
      start,
      end
    ] =
      offsets[t];


    /* --------------------------------------------------------
       Ignore CLS / SEP
       -------------------------------------------------------- */

    if (
      start === end
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       Find highest scoring label
       -------------------------------------------------------- */

    const base =
      t * numLabels;


    let best =
      0;

    let bestScore =
      -Infinity;


    for (
      let l = 0;
      l < numLabels;
      l++
    ) {

      const score =
        data[
          base + l
        ];


      if (
        score >
        bestScore
      ) {

        bestScore =
          score;

        best =
          l;
      }
    }


    /* --------------------------------------------------------
       Softmax confidence
       -------------------------------------------------------- */

    const confidence =
      calculateConfidence(
        data,

        base,

        numLabels,

        bestScore
      );


    /* --------------------------------------------------------
       Label
       -------------------------------------------------------- */

    const rawLabel =
      ready.id2label[
        String(best)
      ] ||
      ready.id2label[
        best
      ] ||
      'O';


    const {
      prefix,

      entityType:
        rawEntityType

    } =
      parseEntityLabel(
        rawLabel
      );


    const entityType =
      normalizeEntityType(
        rawEntityType
      );


    console.log(
      '[offscreen] TOKEN PREDICTION:',
      {

        tokenIndex:
          t,

        tokenText:
          text.slice(
            start,
            end
          ),

        start,

        end,

        labelId:
          best,

        rawLabel,

        entityType,

        confidence,

        accepted:
          confidence >=
          NER_CONFIDENCE_THRESHOLD
      }
    );


    /* ========================================================
       CONFIDENCE FILTER
       ========================================================

       Anything below 80% is ignored.
       ======================================================== */

    if (
      confidence <
      NER_CONFIDENCE_THRESHOLD
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       O label
       -------------------------------------------------------- */

    if (
      prefix === 'O' ||
      entityType === 'O'
    ) {

      if (current) {

        spans.push(
          current
        );

        current = null;
      }

      continue;
    }


    /* --------------------------------------------------------
       B-ENTITY
       -------------------------------------------------------- */

    if (
      prefix === 'B' ||
      !current ||
      current.entityType !== entityType
    ) {

      if (current) {

        spans.push(
          current
        );
      }


      current = {

        entityType,

        start,

        end,

        confidences: [
          confidence
        ]
      };


      continue;
    }


    /* --------------------------------------------------------
       I-ENTITY
       -------------------------------------------------------- */

    if (
      prefix === 'I'
    ) {

      current.end =
        end;


      current.confidences.push(
        confidence
      );
    }
  }


  /* ----------------------------------------------------------
     Flush final span
     ---------------------------------------------------------- */

  if (current) {

    spans.push(
      current
    );
  }


  /* ----------------------------------------------------------
     Create final results
     ---------------------------------------------------------- */

  const result =
    spans.map(
      (span) => ({

        entityType:
          span.entityType,

        start:
          span.start,

        end:
          span.end,

        text:
          text.slice(
            span.start,
            span.end
          ),

        confidence:
          span.confidences.reduce(
            (
              sum,
              value
            ) =>
              sum + value,

            0
          ) /
          span.confidences.length
      })
    );


  console.log(
    '[offscreen] FINAL NER RESULT:',
    result
  );


  return result;
}


/* ============================================================
   Message listener
   ============================================================ */

chrome.runtime.onMessage.addListener(
  (
    message,
    sender,
    sendResponse
  ) => {

    if (
      message &&
      message.target === 'offscreen' &&
      message.type ===
        'RUN_NER_INFERENCE'
    ) {

      runNerOnText(
        message.text
      )

        .then(
          (spans) => {

            sendResponse({

              ok: true,

              spans
            });
          }
        )

        .catch(
          (error) => {

            console.error(
              '[offscreen] NER inference error:',
              error
            );


            sendResponse({

              ok: false,

              error:
                error.message ||
                String(error),

              spans: []
            });
          }
        );


      return true;
    }

    if (
      message &&
      message.target === 'offscreen' &&
      message.type === 'RUN_FACE_DETECTION'
    ) {
    
      (async () => {
    
        try {
    
          const faces =
            await detectFaces(
              message.screenshot
            );
    
          sendResponse({
            ok: true,
            faces
          });
    
        }
        catch (error) {
    
          console.error(
            '[offscreen] Face detection failed:',
            error
          );
    
          sendResponse({
            ok: false,
            error:
              error.message ||
              String(error)
          });
        }
    
      })();
    
      return true;
    }


    return false;
  }
);


/* ============================================================
   Startup
   ============================================================ */

console.log(
  '[offscreen] NER offscreen document loaded.'
);

console.log(
  `[offscreen] NER confidence threshold: ${NER_CONFIDENCE_THRESHOLD * 100}%`
);
