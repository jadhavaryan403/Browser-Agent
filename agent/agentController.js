/**
 * agent/agentController.js
 *
 * The local agent's orchestrator, matching the pipeline in the project
 * spec (section 15). It walks the state machine and delegates the
 * "should we proceed or ask the user something" call to TaskManager's
 * decide() stub — the seam where a real LLM/VLM decision layer will
 * eventually plug in (see agent/agentBackend.js).
 */
(function (root) {
  const STATES = root.__BA_STATES;

  class AgentController {
    constructor() {
      this.stateManager = new root.__BA_StateManager();
      this.taskManager = new root.__BA_TaskManager();
      this.lastExtraction = null;
    }

    get state() {
      return this.stateManager.current;
    }

    onStateChange(fn) {
      this.stateManager.onChange(fn);
    }

    startTask(taskText) {
      this.stateManager.reset();
      this.taskManager.setTask(taskText);
      this.stateManager.transition(STATES.TASK_RECEIVED);
    }

    beginPageAnalysis() {
      this.stateManager.transition(STATES.PAGE_ANALYSIS);
    }

    onDomExtracted() {
      this.stateManager.transition(STATES.DOM_EXTRACTED);
    }

    onPiiDetected() {
      this.stateManager.transition(STATES.PII_DETECTED);
    }

    onScreenshotCaptured() {
      this.stateManager.transition(STATES.SCREENSHOT_CAPTURED);
    }

    onScreenshotRedacted() {
      this.stateManager.transition(STATES.SCREENSHOT_REDACTED);
    }

    /**
     * Call once extraction + redaction are done for this pass. Marks
     * the state machine READY_FOR_AGENT and caches the extraction so
     * the caller (popup.js) can build the payload for
     * agentBackend.decideNextAction(). Actual next-step reasoning now
     * lives entirely on the configured backend — this controller only
     * tracks state and the task/collected-info bookkeeping.
     */
    evaluateReadiness(extractionResult) {
      this.lastExtraction = extractionResult;
      this.stateManager.transition(STATES.READY_FOR_AGENT);
    }

    submitUserInfo(values) {
      this.taskManager.recordUserInfo(values);
      this.stateManager.transition(STATES.READY_FOR_AGENT);
    }

    markExecuting() {
      this.stateManager.transition(STATES.EXECUTING);
    }

    /** Backend asked for missing info via an "ask_user" action. */
    markWaitingForUser() {
      this.stateManager.transition(STATES.WAITING_FOR_USER);
    }

    markCompleted() {
      this.stateManager.transition(STATES.COMPLETED);
      // Wipe any user-entered info from memory now that the task is done.
      this.taskManager.clearCollectedInfo();
    }

    markError(err) {
      this.stateManager.transition(STATES.ERROR);
      return err;
    }

    reset() {
      this.stateManager.reset();
      this.taskManager.clearCollectedInfo();
      this.lastExtraction = null;
    }
  }

  root.__BA_AgentController = AgentController;
})(typeof window !== 'undefined' ? window : self);