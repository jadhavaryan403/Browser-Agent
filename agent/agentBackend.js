/**
 * agent/agentBackend.js
 *
 * INTENTIONALLY NOT IMPLEMENTED.
 *
 * This is the abstract seam described in the project spec (section 17)
 * where a future backend LLM/VLM agent would be wired in. It exists so
 * the rest of the codebase (AgentController, TaskManager) has a stable
 * interface to call once a backend is ready — but calling any method
 * here today throws, on purpose. There is no fetch(), no XHR, no
 * WebSocket anywhere in this file or anywhere else in the extension.
 *
 * A real implementation, if ever added, would:
 *   1. Take the ALREADY-REDACTED screenshot + sanitized DOM summary
 *      (never raw PII, never the unredacted screenshot)
 *   2. Send it to a developer-configured backend endpoint
 *   3. Return a structured next-action (click/type/scroll/select) for
 *      AgentController to execute via window.__BA.click(), etc.
 */
(function (root) {
  class AgentBackend {
    /**
     * @param {{redactedScreenshotDataUrl: string, elements: Array, task: string}} payload
     * @returns {Promise<{action: string, elementId?: number, text?: string}>}
     */
    async decideNextAction(payload) {
      throw new Error(
        'AgentBackend.decideNextAction() is not implemented in this local-only prototype. ' +
        'Wire a real backend call in here when one exists.'
      );
    }

    async isAvailable() {
      return false;
    }
  }

  root.__BA_AgentBackend = AgentBackend;
})(typeof window !== 'undefined' ? window : self);
