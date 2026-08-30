/**
 * utils/logger.js
 *
 * A tiny logging helper used across every context (content script,
 * background service worker, popup).
 *
 * PRIVACY RULE:
 *   This logger must NEVER be given raw PII, raw screenshots, or raw
 *   DOM text. Callers are responsible for passing only non-sensitive
 *   metadata (counts, types, element ids, state names, etc).
 *   We defensively strip a few obviously-dangerous key names if an
 *   object is logged, as a last line of defense.
 */
(function (root) {
  const DEBUG = false; // flip to true only for local development

  const DANGEROUS_KEYS = [
    'value', 'text', 'password', 'email', 'phone', 'card', 'cardNumber',
    'ssn', 'name', 'dob', 'screenshot', 'dataUrl', 'raw'
  ];

  function scrub(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    try {
      const clone = Array.isArray(obj) ? [] : {};
      for (const key of Object.keys(obj)) {
        if (DANGEROUS_KEYS.includes(key)) {
          clone[key] = '[omitted-by-logger]';
        } else {
          clone[key] = typeof obj[key] === 'object' ? scrub(obj[key]) : obj[key];
        }
      }
      return clone;
    } catch (e) {
      return '[unloggable]';
    }
  }

  const Logger = {
    info(tag, ...args) {
      if (!DEBUG) return;
      console.log(`[BA:${tag}]`, ...args.map(scrub));
    },
    warn(tag, ...args) {
      console.warn(`[BA:${tag}]`, ...args.map(scrub));
    },
    error(tag, ...args) {
      console.error(`[BA:${tag}]`, ...args.map(scrub));
    }
  };

  root.__BA_Logger = Logger;
})(typeof window !== 'undefined' ? window : self);
