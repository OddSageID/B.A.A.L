import { IntentClass } from '../inference/StormEngine.js';

export const Modality = Object.freeze({
  HAPTIC: 'haptic', AUDITORY: 'auditory', VISUAL: 'visual',
  COGNITIVE: 'cognitive', ENVIRONMENTAL: 'environmental',
  NOTIFICATION: 'notification', SILENT_LOG: 'silent_log',
});

export const Intensity = Object.freeze({
  WHISPER: 1, NUDGE: 2, SIGNAL: 3, PROMPT: 4, OVERRIDE: 5,
});

export class CloudPlanner {
  /** Bump whenever STRATEGIES change — written to the audit trail. */
  static STRATEGY_VERSION = 'cloud-strategies/1';

  #depth = 3;

  static STRATEGIES = {
    [IntentClass.COGNITIVE_OVERLOAD]: [
      { step: 1, modality: Modality.HAPTIC,        intensity: Intensity.WHISPER, cue: 'slow_pulse',               rationale: 'Grounding signal at pre-conscious level',           delayMs: 0 },
      { step: 2, modality: Modality.AUDITORY,      intensity: Intensity.NUDGE,   cue: 'beta_to_alpha_transition',  rationale: 'Guide cognitive load down via auditory entrainment', delayMs: 3000,  condition: 'if_step_1_unresolved' },
      { step: 3, modality: Modality.COGNITIVE,     intensity: Intensity.SIGNAL,  cue: 'task_decomposition_prompt', rationale: 'Break overloaded task into smaller chunks',           delayMs: 8000,  condition: 'if_step_2_unresolved' },
    ],
    [IntentClass.SYSTEM1_LOCK]: [
      { step: 1, modality: Modality.VISUAL,        intensity: Intensity.NUDGE,   cue: 'attention_anchor',          rationale: 'Force brief System 2 engagement',                    delayMs: 0 },
      { step: 2, modality: Modality.COGNITIVE,     intensity: Intensity.SIGNAL,  cue: 'decision_checkpoint',       rationale: 'Insert deliberation gate before action executes',    delayMs: 2000,  condition: 'if_step_1_unresolved' },
    ],
    [IntentClass.PANIC_ONSET]: [
      { step: 1, modality: Modality.HAPTIC,        intensity: Intensity.NUDGE,   cue: 'slow_rhythmic_4_7_8',       rationale: 'Parasympathetic activation via haptic rhythm',        delayMs: 0 },
      { step: 2, modality: Modality.AUDITORY,      intensity: Intensity.SIGNAL,  cue: 'low_frequency_anchor',      rationale: 'Low-frequency tone activates vagus nerve pathway',    delayMs: 5000,  condition: 'if_step_1_unresolved' },
      { step: 3, modality: Modality.NOTIFICATION,  intensity: Intensity.PROMPT,  cue: 'caregiver_alert',           rationale: 'Escalate to human oversight',                        delayMs: 15000, condition: 'if_step_2_unresolved' },
    ],
    [IntentClass.ATTENTION_COLLAPSE]: [
      { step: 1, modality: Modality.ENVIRONMENTAL, intensity: Intensity.WHISPER, cue: 'contrast_shift',            rationale: 'Novel stimulus resets attention vector',              delayMs: 0 },
      { step: 2, modality: Modality.HAPTIC,        intensity: Intensity.NUDGE,   cue: 'direction_pulse',           rationale: 'Directional haptic cue guides attention back',        delayMs: 4000,  condition: 'if_step_1_unresolved' },
    ],
    [IntentClass.DECISION_PARALYSIS]: [
      { step: 1, modality: Modality.COGNITIVE,     intensity: Intensity.NUDGE,   cue: 'option_reduction_frame',    rationale: 'Reduce decision space',                              delayMs: 0 },
      { step: 2, modality: Modality.HAPTIC,        intensity: Intensity.SIGNAL,  cue: 'momentum_pulse',            rationale: 'Physical forward momentum cue breaks hesitation',     delayMs: 6000,  condition: 'if_step_1_unresolved' },
    ],
    [IntentClass.PEAK_STATE_APPROACHING]: [
      { step: 1, modality: Modality.SILENT_LOG,    intensity: Intensity.WHISPER, cue: 'peak_window_open',          rationale: 'Log peak state — no intervention, protect state',     delayMs: 0 },
    ],
    [IntentClass.FATIGUE_ONSET]: [
      { step: 1, modality: Modality.ENVIRONMENTAL, intensity: Intensity.NUDGE,   cue: 'alertness_stimulus',        rationale: 'Mild environmental arousal to counter fatigue',       delayMs: 0 },
      { step: 2, modality: Modality.NOTIFICATION,  intensity: Intensity.SIGNAL,  cue: 'rest_recommendation',       rationale: 'Explicit rest prompt',                               delayMs: 10000, condition: 'if_step_1_unresolved' },
    ],
  };

  constructor({ depth = 3 } = {}) { this.#depth = depth; }

  async plan({ intent, subjectId, sessionContext }) {
    const { primary, severity } = intent;
    if (!intent.confident) return this.#silentPlan(subjectId, intent);
    const strategy = CloudPlanner.STRATEGIES[primary.class];
    if (!strategy)  return this.#unknownIntentPlan(subjectId, intent);
    const steps = this.#applyContextModifiers(strategy.slice(0, this.#depth), sessionContext);
    return {
      subjectId, intentClass: primary.class, confidence: primary.confidence, severity,
      steps, stepCount: steps.length,
      requiresHuman: steps.some(s => s.modality === Modality.NOTIFICATION),
      strategyVersion: CloudPlanner.STRATEGY_VERSION,
      plannedAt: Date.now(), expiresAt: Date.now() + 30000,
    };
  }

  #silentPlan(subjectId, intent) {
    return { subjectId, intentClass: 'UNKNOWN', confidence: intent.primary?.confidence ?? 0, severity: 'low',
      steps: [{ step: 1, modality: Modality.SILENT_LOG, intensity: Intensity.WHISPER, cue: 'low_confidence_observation', rationale: 'Insufficient confidence', delayMs: 0 }],
      stepCount: 1, requiresHuman: false, strategyVersion: CloudPlanner.STRATEGY_VERSION, plannedAt: Date.now(), expiresAt: Date.now() + 30000 };
  }

  #unknownIntentPlan(subjectId, intent) {
    return { subjectId, intentClass: 'UNKNOWN', confidence: intent.primary?.confidence ?? 0, severity: intent.severity,
      steps: [{ step: 1, modality: Modality.SILENT_LOG, intensity: Intensity.WHISPER, cue: 'unclassified_pattern', rationale: 'Pattern detected but not classified', delayMs: 0 }],
      stepCount: 1, requiresHuman: false, strategyVersion: CloudPlanner.STRATEGY_VERSION, plannedAt: Date.now(), expiresAt: Date.now() + 30000 };
  }

  #applyContextModifiers(steps, session) {
    if (!session) return steps;
    return steps.map(step =>
      session.interventionCount > 5 && step.intensity < Intensity.SIGNAL
        ? { ...step, intensity: step.intensity + 1, rationale: step.rationale + ' [escalated]' }
        : step
    );
  }
}
