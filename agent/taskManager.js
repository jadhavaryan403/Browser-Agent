/**
 * agent/taskManager.js
 *
 * Holds the current natural-language task and any information the user
 * has explicitly typed in response to a backend "ask_user" step.
 *
 * Decision-making ("what should happen next on this page") used to be
 * a local keyword-matching stub here. It now lives entirely on the
 * configured backend (agent/agentBackend.js) — this class is just
 * bookkeeping, kept deliberately dumb so it's obvious nothing sensitive
 * is inferred or stored beyond what the user directly typed.
 */
(function (root) {
  class TaskManager {
    constructor() {
      this.task = null;
      this.collectedInfo = {}; // in-memory only, cleared on completion/reset
    }

    setTask(taskText) {
      this.task = (taskText || '').trim();
      this.collectedInfo = {};
      return this.task;
    }

    recordUserInfo(values) {
      this.collectedInfo = { ...this.collectedInfo, ...values };
    }

    /** Wipes any user-supplied info from memory. Call this on COMPLETED/reset. */
    clearCollectedInfo() {
      this.collectedInfo = {};
    }
  }

  root.__BA_TaskManager = TaskManager;
})(typeof window !== 'undefined' ? window : self);