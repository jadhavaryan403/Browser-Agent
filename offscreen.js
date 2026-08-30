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


/* ============================================================
   Extension URL helper
   ============================================================ */

function extURL(path) {
  return chrome.runtime.getURL(path);
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
