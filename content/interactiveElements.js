/**
 * content/interactiveElements.js
 *
 * Finds candidate interactive elements on the page and turns each
 * visible one into a plain-object record safe to serialize back to the
 * extension's background/popup contexts.
 */
(function (root) {
  const INTERACTIVE_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[onclick]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="option"]',
    '[tabindex]'
  ].join(',');

  // Input types whose raw value must never be captured, even locally.
  const SENSITIVE_VALUE_INPUT_TYPES = new Set(['password']);

  function classifyType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      return `input:${(el.getAttribute('type') || 'text').toLowerCase()}`;
    }
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    const role = el.getAttribute('role');
    if (role) return `role:${role}`;
    return tag;
  }

  function hasPointerCursor(el) {
    try {
      return window.getComputedStyle(el).cursor === 'pointer';
    } catch (e) {
      return false;
    }
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function safeValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SENSITIVE_VALUE_INPUT_TYPES.has(type)) return null;
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
      // Text-like inputs: value is included, but it will still be run
      // through the PII detector before anything is ever rendered/sent.
      return el.value || null;
    }
    if (tag === 'select') {
      // Use the selected option's visible label, not the underlying
      // `value` attribute — pages often set value="opt1" while the
      // text actually rendered on screen (and therefore in the
      // screenshot) is something like "John Doe — Visa ••1234".
      // That rendered text is what needs to be PII-scanned.
      const opt = el.options && el.options[el.selectedIndex];
      return opt ? (opt.text || opt.value || null) : (el.value || null);
    }
    if (tag === 'textarea') return el.value || null;
    return null;
  }

  function shortText(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.value ||
      (el.innerText || el.textContent || '').trim();
    return label ? label.slice(0, 200) : '';
  }

  /**
   * Collects visible interactive elements from the current document.
   * Returns { elements: [...], registry: Map<id, HTMLElement> }
   * The registry is kept in-memory only (not serialized) so actions
   * like click()/type() can resolve back to the live element quickly;
   * it is rebuilt on every extraction pass.
   */
  function extractInteractiveElements(viewportWidth, viewportHeight) {
    const candidates = new Set(document.querySelectorAll(INTERACTIVE_SELECTOR));

    // Heuristic pass: elements with pointer cursor + a click-ish role
    // that weren't already matched (e.g. clickable <div> cards).
    document.querySelectorAll('div,span,li,section,article').forEach((el) => {
      if (candidates.has(el)) return;
      if (hasPointerCursor(el) && el.getAttribute('tabindex') !== '-1') {
        candidates.add(el);
      }
    });

    const elements = [];
    const registry = new Map();
    let nextId = 0;

    for (const el of candidates) {
      if (!root.__BA_Visibility.isElementVisible(el, viewportWidth, viewportHeight)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      const id = nextId++;
      const selector = root.__BA_Selectors.getStableSelector(el);

      elements.push({
        id,
        type: classifyType(el),
        text: shortText(el),
        ariaLabel: el.getAttribute('aria-label') || null,
        placeholder: el.getAttribute('placeholder') || null,
        value: safeValue(el),
        href: el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') : null,
        bbox: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        selector,
        visible: true,
        enabled: !isDisabled(el)
      });

      registry.set(id, el);
    }

    return { elements, registry };
  }

  root.__BA_InteractiveElements = { extractInteractiveElements };
})(window);