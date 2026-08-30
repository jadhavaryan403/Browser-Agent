/**
 * agent/stateManager.js
 *
 * The finite state machine described in the project spec (section 15).
 * Plain data + transition validation only — no I/O, no DOM, safe to
 * load in the background service worker (via importScripts) or the
 * popup (via <script>).
 */
(function (root) {
  const STATES = Object.freeze({
    IDLE: 'IDLE',
    TASK_RECEIVED: 'TASK_RECEIVED',
    PAGE_ANALYSIS: 'PAGE_ANALYSIS',
    DOM_EXTRACTED: 'DOM_EXTRACTED',
    PII_DETECTED: 'PII_DETECTED',
    SCREENSHOT_CAPTURED: 'SCREENSHOT_CAPTURED',
    SCREENSHOT_REDACTED: 'SCREENSHOT_REDACTED',
    READY_FOR_AGENT: 'READY_FOR_AGENT',
    WAITING_FOR_USER: 'WAITING_FOR_USER',
    EXECUTING: 'EXECUTING',
    COMPLETED: 'COMPLETED',
    ERROR: 'ERROR'
  });

  // Adjacency list of allowed forward transitions. This is now a LOOP:
  // after executing a backend-issued action, the agent goes back to
  // PAGE_ANALYSIS to re-extract the (possibly changed) page and ask the
  // backend for the next step, repeating until the backend returns
  // "done" or a safety step-cap is hit (see popup.js runAgentLoop()).
  // WAITING_FOR_USER can also loop back into PAGE_ANALYSIS once the
  // user answers a backend-requested "ask_user" step. ERROR is
  // reachable from anywhere.
  const TRANSITIONS = {
    IDLE: ['TASK_RECEIVED'],
    TASK_RECEIVED: ['PAGE_ANALYSIS'],
    PAGE_ANALYSIS: ['DOM_EXTRACTED'],
    DOM_EXTRACTED: ['PII_DETECTED'],
    PII_DETECTED: ['SCREENSHOT_CAPTURED'],
    SCREENSHOT_CAPTURED: ['SCREENSHOT_REDACTED'],
    SCREENSHOT_REDACTED: ['READY_FOR_AGENT'],
    READY_FOR_AGENT: ['WAITING_FOR_USER', 'EXECUTING', 'COMPLETED'],
    WAITING_FOR_USER: ['READY_FOR_AGENT', 'PAGE_ANALYSIS'],
    EXECUTING: ['READY_FOR_AGENT', 'COMPLETED', 'WAITING_FOR_USER', 'PAGE_ANALYSIS'],
    COMPLETED: ['IDLE'],
    ERROR: ['IDLE']
  };

  class StateManager {
    constructor() {
      this.current = STATES.IDLE;
      this.history = [STATES.IDLE];
      this.listeners = [];
    }

    canTransition(next) {
      const allowed = TRANSITIONS[this.current] || [];
      return allowed.includes(next) || next === STATES.ERROR;
    }

    transition(next) {
      if (!this.canTransition(next)) {
        throw new Error(`Invalid state transition: ${this.current} -> ${next}`);
      }
      this.current = next;
      this.history.push(next);
      this.listeners.forEach((fn) => fn(next, this.history));
      return this.current;
    }

    reset() {
      this.current = STATES.IDLE;
      this.history = [STATES.IDLE];
    }

    onChange(fn) {
      this.listeners.push(fn);
    }
  }

  root.__BA_STATES = STATES;
  root.__BA_StateManager = StateManager;
})(typeof window !== 'undefined' ? window : self);