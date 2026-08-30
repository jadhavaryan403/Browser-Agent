/**
 * agent/userInputManager.js
 *
 * Renders and validates the "additional information required" form.
 * Values the user types here are:
 *   - kept only in memory (never chrome.storage, never console.log)
 *   - never auto-populated from previously detected page PII — the
 *     user must explicitly type them, per the privacy requirements
 *   - cleared as soon as the task completes or is reset
 */
(function (root) {
  class UserInputManager {
    /**
     * @param {HTMLElement} container - element to render the form into
     */
    constructor(container) {
      this.container = container;
      this.onSubmit = null; // (values) => void
    }

    /** @param {Array<{key:string,label:string,type:string}>} fields */
    renderForm(fields, onSubmit) {
      this.onSubmit = onSubmit;
      this.container.innerHTML = ''; // safe: we build all nodes below via DOM APIs, not innerHTML with user data

      const heading = document.createElement('div');
      heading.className = 'ba-section-title';
      heading.textContent = 'Additional information required';
      this.container.appendChild(heading);

      const form = document.createElement('form');
      form.className = 'ba-user-input-form';

      const inputs = {};
      for (const field of fields) {
        const wrap = document.createElement('label');
        wrap.className = 'ba-field';

        const labelText = document.createElement('span');
        labelText.textContent = field.label; // textContent, never innerHTML — see security notes in README
        wrap.appendChild(labelText);

        const input = document.createElement('input');
        input.type = field.type || 'text';
        input.name = field.key;
        input.required = true;
        input.autocomplete = 'off';
        wrap.appendChild(input);

        inputs[field.key] = input;
        form.appendChild(wrap);
      }

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.textContent = 'Continue';
      submitBtn.className = 'ba-primary-btn';
      form.appendChild(submitBtn);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = {};
        for (const key of Object.keys(inputs)) {
          values[key] = inputs[key].value;
        }
        if (typeof this.onSubmit === 'function') this.onSubmit(values);
        // Clear the DOM inputs immediately after handing values off.
        form.reset();
      });

      this.container.appendChild(form);
    }

    clear() {
      this.container.innerHTML = '';
    }
  }

  root.__BA_UserInputManager = UserInputManager;
})(window);
