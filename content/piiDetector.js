/**
 * content/piiDetector.js
 *
 * Local rule-based detection (regex + Luhn) PLUS an async NER pass that
 * delegates to an offscreen document running an ONNX model
 * (background/service-worker.js relays 'RUN_NER_INFERENCE' messages to
 * offscreen.js — see offscreen/offscreen.js). The NER inference still
 * never leaves the browser: it runs in the offscreen document, not a
 * remote API.
 */
(function (root) {
  const PATTERNS = {
    EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    PHONE: /(\+\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}\b/g,
    CARD: /\b(?:\d[ -]?){13,19}\b/g,
    IPV4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  };

  const SENSITIVE_QUERY_PARAMS = new Set([
    'token', 'access_token', 'auth', 'password', 'pwd', 'email', 'ssn',
    'api_key', 'apikey', 'key', 'session', 'sid'
  ]);

  const ENTITY_TYPE_MAP = {
    NAME: 'NAME',
    PERSON: 'NAME',
    GIVENNAME: 'NAME',
    FIRSTNAME: 'NAME',
    LASTNAME: 'NAME', 
    SURNAME: 'NAME', 
    MIDDLENAME: 'NAME', 
    EMAIL: 'EMAIL',
    TEL: 'PHONE', 
    PHONE: 'PHONE', 
    PHONENUMBER: 'PHONE', 
    PHONEIMEI: 'PHONE',
    CREDITCARDNUMBER: 'CARD', 
    CREDITCARDCVV: 'CARD', 
    CREDITCARD: 'CARD',
    IP: 'IP_ADDRESS', 
    IPV4: 'IP_ADDRESS', 
    IPV6: 'IP_ADDRESS'
  };

  function normalizeEntityType(rawType) {
    const key = rawType.toUpperCase().replace(/[\s_-]/g, '');
    return ENTITY_TYPE_MAP[key] || rawType.toUpperCase();
  }

  /** Sends text to background service worker -> offscreen document for ONNX NER inference */
  async function runNerOnText(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_NER_INFERENCE', text }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[piiDetector] NER message failed:', chrome.runtime.lastError.message);
          return resolve([]);
        }
        if (response && response.ok) {
          resolve(response.spans || []);
        } else {
          console.warn('[piiDetector] NER model error:', response?.error);
          resolve([]);
        }
      });
    });
  }

  function luhnCheck(digitsOnly) {
    let sum = 0;
    let alt = false;
    for (let i = digitsOnly.length - 1; i >= 0; i--) {
      let d = parseInt(digitsOnly[i], 10);
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function maskValue(type, text) {
    switch (type) {
      case 'EMAIL': {
        const [user, domain] = text.split('@');
        const maskedUser = user.length <= 2 ? '*'.repeat(user.length) : user[0] + '*'.repeat(user.length - 2) + user.slice(-1);
        return `${maskedUser}@${domain}`;
      }
      case 'CARD': {
        const digits = text.replace(/\D/g, '');
        return `**** **** **** ${digits.slice(-4)}`;
      }
      case 'PHONE': {
        const digits = text.replace(/\D/g, '');
        return `${'*'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
      }
      case 'IPV4':
      case 'IP_ADDRESS':
        return text.includes('.')
          ? text.split('.').map((o, i) => (i < 2 ? '*'.repeat(o.length) : o)).join('.')
          : '[REDACTED]';
      case 'NAME':
        return text[0] + '*'.repeat(Math.max(0, text.length - 1));
      default:
        return '[REDACTED]';
    }
  }

  function bboxForMatch(textNode, index, length, viewportWidth, viewportHeight) {
    try {
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + length);
      const rect = range.getBoundingClientRect();
      range.detach && range.detach();
      if (!root.__BA_Geometry.rectIntersectsViewport(rect, viewportWidth, viewportHeight)) {
        return null;
      }
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch (e) {
      return null;
    }
  }

  function detectInText(text, type, regex) {
    const matches = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      matches.push({ match: m[0], index: m.index, group: m[1] });
      if (m[0].length === 0) regex.lastIndex++;
    }
    return matches;
  }

  async function detectSensitiveInfo(textNodes, viewportWidth, viewportHeight) {
    const items = [];
    const flaggedNodes = new Set();

    for (const entry of textNodes) {
      const { node, text, elementId } = entry;
      let nodeFlagged = false;

      // EMAIL
      for (const { match, index } of detectInText(text, 'EMAIL', PATTERNS.EMAIL)) {
        const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
        if (bbox) { items.push({ type: 'EMAIL', masked: maskValue('EMAIL', match), confidence: 0.98, bbox, elementId }); nodeFlagged = true; }
      }

      // CARD
      for (const { match, index } of detectInText(text, 'CARD', PATTERNS.CARD)) {
        const digits = match.replace(/[ -]/g, '');
        if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'CARD', masked: maskValue('CARD', digits), confidence: 0.95, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // PHONE
      for (const { match, index } of detectInText(text, 'PHONE', PATTERNS.PHONE)) {
        const digits = match.replace(/\D/g, '');
        if (digits.length >= 7 && digits.length <= 15) {
          const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
          if (bbox) { items.push({ type: 'PHONE', masked: maskValue('PHONE', match), confidence: 0.8, bbox, elementId }); nodeFlagged = true; }
        }
      }

      // IPV4
      for (const { match, index } of detectInText(text, 'IPV4', PATTERNS.IPV4)) {
        const bbox = bboxForMatch(node, index, match.length, viewportWidth, viewportHeight);
        if (bbox) { items.push({ type: 'IP_ADDRESS', masked: maskValue('IPV4', match), confidence: 0.9, bbox, elementId }); nodeFlagged = true; }
      }

      // ONNX NER via Offscreen Document
      const spans = await runNerOnText(text);
      for (const span of spans) {
        const type = normalizeEntityType(span.entityType);
        const bbox = bboxForMatch(node, span.start, span.end - span.start, viewportWidth, viewportHeight);
        if (bbox) {
          items.push({ type, masked: maskValue(type, span.text), confidence: span.confidence, bbox, elementId });
          nodeFlagged = true;
        }
      }

      if (nodeFlagged) flaggedNodes.add(node);
    }

    return { items, flaggedNodes };
  }

  async function scanPlainText(text, fieldLabel) {
    if (!text) return [];
    const items = [];

    for (const { match } of detectInText(text, 'EMAIL', PATTERNS.EMAIL)) {
      items.push({ type: 'EMAIL', masked: maskValue('EMAIL', match), confidence: 0.98 });
    }

    for (const { match } of detectInText(text, 'CARD', PATTERNS.CARD)) {
      const digits = match.replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        items.push({ type: 'CARD', masked: maskValue('CARD', digits), confidence: 0.95 });
      }
    }

    for (const { match } of detectInText(text, 'PHONE', PATTERNS.PHONE)) {
      const digits = match.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) {
        items.push({ type: 'PHONE', masked: maskValue('PHONE', match), confidence: 0.8 });
      }
    }

    for (const { match } of detectInText(text, 'IPV4', PATTERNS.IPV4)) {
      items.push({ type: 'IP_ADDRESS', masked: maskValue('IPV4', match), confidence: 0.9 });
    }

    const spans = await runNerOnText(text);
    for (const span of spans) {
      const type = normalizeEntityType(span.entityType);
      items.push({ type, masked: maskValue(type, span.text), confidence: span.confidence });
    }

    if (
      fieldLabel &&
      /\b(name|passenger|patient|customer|guest)\b/i.test(fieldLabel) &&
      /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,2}$/.test(text.trim()) &&
      !items.some((it) => it.type === 'NAME')
    ) {
      items.push({ type: 'NAME', masked: maskValue('NAME', text.trim()), confidence: 0.6 });
    }

    return items;
  }

  function detectSensitiveUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, window.location.href);
      const flaggedParams = [...url.searchParams.keys()].filter((k) =>
        SENSITIVE_QUERY_PARAMS.has(k.toLowerCase())
      );
      if (flaggedParams.length > 0) {
        return { type: 'SENSITIVE_URL_PARAM', masked: `${url.origin}${url.pathname}?...`, confidence: 0.7, params: flaggedParams };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  root.__BA_PiiDetector = {
    detectSensitiveInfo,
    detectSensitiveUrl,
    scanPlainText,
    maskValue,
    luhnCheck,
    ensureModelLoaded: () => Promise.resolve()
  };
})(window);