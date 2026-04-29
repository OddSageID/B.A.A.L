import { Modality, Intensity } from '../planning/CloudPlanner.js';
import { BaalLogger }          from '../utils/BaalLogger.js';
import { ResolutionMonitor }   from './ResolutionMonitor.js';

export const Outcome = Object.freeze({
  RESOLVED:           'RESOLVED',
  PARTIALLY_RESOLVED: 'PARTIALLY_RESOLVED',
  UNRESOLVED:         'UNRESOLVED',
  ESCALATED:          'ESCALATED',
  EXPIRED:            'EXPIRED',
});

export class WarExecutor {
  #logger  = new BaalLogger({ name: 'WarExecutor' });
  #monitor = null;

  setMonitor(monitor) { this.#monitor = monitor; }

  static DELIVERY_MAP = {
    [Modality.HAPTIC]:        async (step, subjectId) => ({ delivered: true,  channel: 'haptic',        cue: step.cue, subjectId }),
    [Modality.AUDITORY]:      async (step, subjectId) => ({ delivered: true,  channel: 'auditory',      cue: step.cue, subjectId }),
    [Modality.VISUAL]:        async (step, subjectId) => ({ delivered: true,  channel: 'visual',        cue: step.cue, subjectId }),
    [Modality.COGNITIVE]:     async (step, subjectId) => ({ delivered: true,  channel: 'cognitive',     cue: step.cue, subjectId }),
    [Modality.ENVIRONMENTAL]: async (step, subjectId) => ({ delivered: true,  channel: 'environmental', cue: step.cue, subjectId }),
    [Modality.NOTIFICATION]:  async (step, subjectId) => ({ delivered: true,  channel: 'notification',  cue: step.cue, subjectId }),
    [Modality.SILENT_LOG]:    async (step, subjectId) => ({ delivered: false, channel: 'silent_log',    cue: step.cue, subjectId }),
  };

  static RESOLUTION_WINDOW_MS = {
    [Intensity.WHISPER]:  2000,
    [Intensity.NUDGE]:    5000,
    [Intensity.SIGNAL]:   8000,
    [Intensity.PROMPT]:   15000,
    [Intensity.OVERRIDE]: 0,
  };

  async execute(plan, subjectId) {
    if (Date.now() > plan.expiresAt) {
      this.#logger.warn('Plan expired before execution', { subjectId });
      return { outcome: Outcome.EXPIRED, stepsExecuted: 0, plan };
    }
    const executionLog = [];
    let resolved = false;
    for (const step of plan.steps) {
      if (step.condition && !this.#evaluateCondition(step.condition, executionLog)) continue;
      if (step.delayMs > 0) await this.#delay(step.delayMs);
      this.#logger.declare('Executing step', { subjectId, step: step.step, modality: step.modality, intensity: step.intensity });
      const deliveryHandler = WarExecutor.DELIVERY_MAP[step.modality];
      if (!deliveryHandler) continue;
      let deliveryResult;
      try {
        deliveryResult = await deliveryHandler(step, subjectId);
      } catch (err) {
        this.#logger.error('Delivery failure', { step, subjectId, err });
        executionLog.push({ step: step.step, status: 'delivery_failed', error: err.message });
        continue;
      }
      executionLog.push({ step: step.step, modality: step.modality, intensity: step.intensity, cue: step.cue, delivered: deliveryResult.delivered, firedAt: Date.now() });
      if (step.modality === Modality.NOTIFICATION) { executionLog[executionLog.length - 1].escalated = true; continue; }
      if (step.modality === Modality.SILENT_LOG) continue;
      const windowMs         = WarExecutor.RESOLUTION_WINDOW_MS[step.intensity] ?? 5000;
      const resolutionResult = await this.#waitForResolution(subjectId, windowMs, plan);
      resolved = resolutionResult.resolved;
      const lastLog = executionLog[executionLog.length - 1];
      lastLog.resolved          = resolved;
      lastLog.partiallyResolved = resolutionResult.partiallyResolved;
      lastLog.timedOut          = resolutionResult.timedOut;
      lastLog.postSeverity      = resolutionResult.signal?.deviation?.severity ?? null;
      if (resolved) { this.#logger.gaze('Deviation resolved', { subjectId, resolvedAtStep: step.step }); break; }
    }
    const wasEscalated = executionLog.some(l => l.escalated);
    const outcome = wasEscalated ? Outcome.ESCALATED : resolved ? Outcome.RESOLVED : executionLog.length > 0 ? Outcome.UNRESOLVED : Outcome.EXPIRED;
    return { subjectId, planIntentClass: plan.intentClass, outcome, stepsExecuted: executionLog.length, executionLog, completedAt: Date.now() };
  }

  evaluate({ intent, plan, result }) {
    const hasPartial       = result.executionLog?.some(l => l.partiallyResolved);
    const effectiveOutcome = result.outcome === Outcome.UNRESOLVED && hasPartial ? Outcome.PARTIALLY_RESOLVED : result.outcome;
    const weights = {
      [Outcome.RESOLVED]: 0.02, [Outcome.PARTIALLY_RESOLVED]: 0.04,
      [Outcome.UNRESOLVED]: 0.08, [Outcome.ESCALATED]: 0.03, [Outcome.EXPIRED]: 0.05,
    };
    const adjustedWeight = (weights[effectiveOutcome] ?? 0.05) * (intent.primary?.confidence ?? 0.5);
    return { outcome: effectiveOutcome, outcomeWeight: Math.round(adjustedWeight * 1000) / 1000, stepsExecuted: result.stepsExecuted, intentClass: intent.primary?.class, confidence: intent.primary?.confidence, evaluatedAt: Date.now() };
  }

  async #waitForResolution(subjectId, windowMs, plan) {
    if (!this.#monitor) {
      await this.#delay(Math.min(windowMs, 200));
      return { resolved: false, partiallyResolved: false, signal: null, timedOut: true };
    }
    return this.#monitor.waitForResolution(subjectId, windowMs, { intentClass: plan?.intentClass });
  }

  #evaluateCondition(condition, executionLog) {
    if (condition === 'if_step_1_unresolved') { const s = executionLog.find(l => l.step === 1); return s != null && !s.resolved; }
    if (condition === 'if_step_2_unresolved') { const s = executionLog.find(l => l.step === 2); return s != null && !s.resolved; }
    return true;
  }

  #delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
