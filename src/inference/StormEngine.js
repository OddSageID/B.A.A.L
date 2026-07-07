export const IntentClass = Object.freeze({
  COGNITIVE_OVERLOAD:     'COGNITIVE_OVERLOAD',
  SYSTEM1_LOCK:           'SYSTEM1_LOCK',
  ATTENTION_COLLAPSE:     'ATTENTION_COLLAPSE',
  DECISION_PARALYSIS:     'DECISION_PARALYSIS',
  PANIC_ONSET:            'PANIC_ONSET',
  EMOTIONAL_SUPPRESSION:  'EMOTIONAL_SUPPRESSION',
  RAGE_VECTOR:            'RAGE_VECTOR',
  PEAK_STATE_APPROACHING: 'PEAK_STATE_APPROACHING',
  FATIGUE_ONSET:          'FATIGUE_ONSET',
  BASELINE_DRIFT:         'BASELINE_DRIFT',
  UNKNOWN:                'UNKNOWN',
});

export class StormEngine {
  #threshold = 0.72;

  static INFERENCE_RULES = [
    { id: 'cognitive_overload', class: IntentClass.COGNITIVE_OVERLOAD, weight: 1.0,
      require: [{ dim: 'cognitive_load', min: 0.65 }, { dim: 'arousal_level', min: 0.60 }, { dim: 'decision_velocity', max: 0.30 }] },
    { id: 'system1_lock', class: IntentClass.SYSTEM1_LOCK, weight: 1.2,
      require: [{ dim: 'system_mode', min: 0.75 }, { dim: 'decision_velocity', min: 0.80 }, { dim: 'hesitation_index', max: 0.10 }] },
    { id: 'panic_onset', class: IntentClass.PANIC_ONSET, weight: 1.5,
      require: [{ dim: 'arousal_level', min: 0.80 }, { dim: 'emotional_valence', max: 0.25 }, { dim: 'attention_vector', max: 0.35 }] },
    { id: 'attention_collapse', class: IntentClass.ATTENTION_COLLAPSE, weight: 0.9,
      require: [{ dim: 'attention_vector', max: 0.25 }, { dim: 'cognitive_load', min: 0.55 }, { dim: 'hesitation_index', min: 0.50 }] },
    { id: 'decision_paralysis', class: IntentClass.DECISION_PARALYSIS, weight: 0.85,
      require: [{ dim: 'hesitation_index', min: 0.70 }, { dim: 'decision_velocity', max: 0.20 }, { dim: 'cognitive_load', min: 0.50 }] },
    { id: 'peak_state', class: IntentClass.PEAK_STATE_APPROACHING, weight: 0.7,
      require: [{ dim: 'arousal_level', min: 0.55, max: 0.70 }, { dim: 'attention_vector', min: 0.75 }, { dim: 'cognitive_load', min: 0.40, max: 0.65 }, { dim: 'emotional_valence', min: 0.60 }] },
    { id: 'fatigue_onset', class: IntentClass.FATIGUE_ONSET, weight: 0.75,
      require: [{ dim: 'arousal_level', max: 0.25 }, { dim: 'attention_vector', max: 0.40 }, { dim: 'cognitive_load', max: 0.30 }] },
  ];

  constructor({ threshold = 0.72 } = {}) { this.#threshold = threshold; }

  async infer({ signal, baseline, deviation, history = [] }) {
    const candidates = [];
    for (const rule of StormEngine.INFERENCE_RULES) {
      const confidence = this.#evaluateRule(rule, signal, deviation);
      // Clamp: rule weights >1 amplify match strength but confidence is [0,1].
      if (confidence > 0) candidates.push({ class: rule.class, confidence: Math.min(confidence * rule.weight, 1.0), ruleId: rule.id });
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const weighted = this.#applyHistoryWeighting(candidates, history);
    const primary  = weighted[0] ?? { class: IntentClass.UNKNOWN, confidence: 0, ruleId: null };
    return { primary, candidates: weighted, inferredAt: Date.now(), confident: primary.confidence >= this.#threshold, severity: deviation.severity, rawDeviation: deviation };
  }

  #evaluateRule(rule, signal, deviation) {
    let matchScore = 0, matchCount = 0;
    for (const req of rule.require) {
      const value = deviation.dimensions?.[req.dim]?.current ?? signal.dimensions?.[req.dim] ?? 0.5;
      if ((req.min == null || value >= req.min) && (req.max == null || value <= req.max)) {
        matchScore += this.#matchStrength(value, req.min, req.max);
        matchCount++;
      }
    }
    if (matchCount < rule.require.length) return 0;
    return matchScore / rule.require.length;
  }

  #matchStrength(value, min, max) {
    if (min != null && max != null) { const c = (min + max) / 2, r = (max - min) / 2; return Math.max(0, 1 - Math.abs(value - c) / r); }
    if (min != null) return Math.min(1, (value - min) / (1 - min) + 0.5);
    if (max != null) return Math.min(1, (max - value) / max + 0.5);
    return 0.5;
  }

  #applyHistoryWeighting(candidates, history) {
    if (!history.length) return candidates;
    const recentClasses = history.slice(-10).map(h => h.intent?.primary?.class).filter(Boolean);
    return candidates.map(c => {
      const boost = Math.min(recentClasses.filter(rc => rc === c.class).length * 0.05, 0.15);
      return { ...c, confidence: Math.min(c.confidence + boost, 1.0) };
    });
  }
}
