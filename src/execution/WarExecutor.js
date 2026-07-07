import { Modality, Intensity } from '../planning/CloudPlanner.js';
import { BaalLogger }          from '../utils/BaalLogger.js';
import { createDefaultDeliveryMap } from './adapters/DeliveryAdapters.js';

export const Outcome = Object.freeze({
  RESOLVED:           'RESOLVED',
  PARTIALLY_RESOLVED: 'PARTIALLY_RESOLVED',
  UNRESOLVED:         'UNRESOLVED',
  ESCALATED:          'ESCALATED',
  EXPIRED:            'EXPIRED',
  ABORTED:            'ABORTED',
});

export class WarExecutor {
  #logger  = new BaalLogger({ name: 'WarExecutor' });
  #monitor = null;
  #deliveryMap = createDefaultDeliveryMap();

  setMonitor(monitor) { this.#monitor = monitor; }
  setDeliveryMap(deliveryMap = {}) { this.#deliveryMap = { ...this.#deliveryMap, ...deliveryMap }; }

  static RESOLUTION_WINDOW_MS = {
    [Intensity.WHISPER]:  2000,
    [Intensity.NUDGE]:    5000,
    [Intensity.SIGNAL]:   8000,
    [Intensity.PROMPT]:   15000,
    [Intensity.OVERRIDE]: 0,
  };

  /**
   * abortSignal: operator/system kill switch — checked before every step and
   * raced against delays and resolution windows.
   * consentCheck: re-verified between steps so a mid-ladder revocation stops
   * stimulation immediately. Fails closed: a check error aborts the ladder.
   */
  async execute(plan, subjectId, { abortSignal = null, consentCheck = null } = {}) {
    if (Date.now() > plan.expiresAt) {
      this.#logger.warn('Plan expired before execution', { subjectId });
      return { outcome: Outcome.EXPIRED, stepsExecuted: 0, plan };
    }
    const executionLog = [];
    let resolved = false;
    let aborted = false;
    let abortReason = null;

    for (const step of plan.steps) {
      if (abortSignal?.aborted) { aborted = true; abortReason = String(abortSignal.reason ?? 'aborted'); break; }
      if (consentCheck && step.modality !== Modality.SILENT_LOG) {
        let stillConsented = false;
        try { stillConsented = await consentCheck(); }
        catch (err) { this.#logger.error('Mid-ladder consent check failed — aborting (fail closed)', { subjectId, err }); }
        if (!stillConsented) { aborted = true; abortReason = 'consent_revoked_mid_ladder'; break; }
      }
      if (step.condition && !this.#evaluateCondition(step.condition, executionLog)) continue;
      if (step.delayMs > 0) {
        await this.#delay(step.delayMs, abortSignal);
        if (abortSignal?.aborted) { aborted = true; abortReason = String(abortSignal.reason ?? 'aborted'); break; }
      }
      this.#logger.declare('Executing step', { subjectId, step: step.step, modality: step.modality, intensity: step.intensity });
      const deliveryHandler = this.#deliveryMap[step.modality];
      if (!deliveryHandler) continue;
      let deliveryResult;
      try {
        deliveryResult = await deliveryHandler(step, subjectId);
      } catch (err) {
        this.#logger.error('Delivery failure', { step, subjectId, err });
        // A failed caregiver notification means the human-oversight guarantee
        // did NOT happen — surface it rather than silently continuing.
        executionLog.push({
          step: step.step, status: 'delivery_failed', error: err.message,
          escalationFailed: step.modality === Modality.NOTIFICATION || undefined,
        });
        continue;
      }
      executionLog.push({ step: step.step, modality: step.modality, intensity: step.intensity, cue: step.cue, delivered: deliveryResult.delivered, firedAt: Date.now() });
      if (step.modality === Modality.NOTIFICATION) { executionLog[executionLog.length - 1].escalated = true; continue; }
      if (step.modality === Modality.SILENT_LOG) continue;
      const windowMs         = WarExecutor.RESOLUTION_WINDOW_MS[step.intensity] ?? 5000;
      const resolutionResult = await this.#waitForResolution(subjectId, windowMs, plan, abortSignal);
      if (resolutionResult.aborted) { aborted = true; abortReason = resolutionResult.abortReason; break; }
      resolved = resolutionResult.resolved;
      const lastLog = executionLog[executionLog.length - 1];
      lastLog.resolved          = resolved;
      lastLog.partiallyResolved = resolutionResult.partiallyResolved;
      lastLog.timedOut          = resolutionResult.timedOut;
      lastLog.postSeverity      = resolutionResult.signal?.deviation?.severity ?? null;
      if (resolved) { this.#logger.gaze('Deviation resolved', { subjectId, resolvedAtStep: step.step }); break; }
    }

    const wasEscalated = executionLog.some(l => l.escalated);
    let outcome;
    if (aborted)                    outcome = Outcome.ABORTED;    // must never adapt the baseline
    else if (wasEscalated)          outcome = Outcome.ESCALATED;  // human involvement stays visible
    else if (resolved)              outcome = Outcome.RESOLVED;
    else if (executionLog.length)   outcome = Outcome.UNRESOLVED;
    else                            outcome = Outcome.EXPIRED;
    if (aborted) this.#logger.anat('Intervention aborted mid-ladder', { subjectId, abortReason });
    return { subjectId, planIntentClass: plan.intentClass, outcome, abortReason, stepsExecuted: executionLog.length, executionLog, completedAt: Date.now() };
  }

  evaluate({ intent, plan, result }) {
    const hasPartial       = result.executionLog?.some(l => l.partiallyResolved);
    const effectiveOutcome = result.outcome === Outcome.UNRESOLVED && hasPartial ? Outcome.PARTIALLY_RESOLVED : result.outcome;
    const weights = {
      [Outcome.RESOLVED]: 0.02, [Outcome.PARTIALLY_RESOLVED]: 0.04,
      [Outcome.UNRESOLVED]: 0.08, [Outcome.ESCALATED]: 0.03, [Outcome.EXPIRED]: 0.05,
      [Outcome.ABORTED]: 0, // an aborted cycle must not adapt the baseline
    };
    const adjustedWeight = (weights[effectiveOutcome] ?? 0.05) * (intent.primary?.confidence ?? 0.5);
    return { outcome: effectiveOutcome, outcomeWeight: Math.round(adjustedWeight * 1000) / 1000, stepsExecuted: result.stepsExecuted, intentClass: intent.primary?.class, confidence: intent.primary?.confidence, evaluatedAt: Date.now() };
  }

  async #waitForResolution(subjectId, windowMs, plan, abortSignal) {
    if (!this.#monitor) {
      this.#logger.warn('ResolutionMonitor not available', { subjectId });
      await this.#delay(Math.min(windowMs, 200), abortSignal);
      return { resolved: false, partiallyResolved: false, signal: null, timedOut: true };
    }
    const wait = this.#monitor.waitForResolution(subjectId, windowMs, { intentClass: plan?.intentClass });
    if (!abortSignal) return wait;
    const abort = new Promise((resolve) => {
      if (abortSignal.aborted) return resolve({ aborted: true, abortReason: String(abortSignal.reason ?? 'aborted') });
      abortSignal.addEventListener('abort', () => resolve({ aborted: true, abortReason: String(abortSignal.reason ?? 'aborted') }), { once: true });
    });
    // The monitor's own timeout cleans up the dangling window if abort wins.
    return Promise.race([wait, abort]);
  }

  #evaluateCondition(condition, executionLog) {
    if (condition === 'if_step_1_unresolved') { const s = executionLog.find(l => l.step === 1); return s != null && !s.resolved; }
    if (condition === 'if_step_2_unresolved') { const s = executionLog.find(l => l.step === 2); return s != null && !s.resolved; }
    return true;
  }

  #delay(ms, abortSignal = null) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
