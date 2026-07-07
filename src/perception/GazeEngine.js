export class GazeEngine {
  #vault = null;

  static DIMENSIONS = Object.freeze({
    COGNITIVE_LOAD:    'cognitive_load',
    EMOTIONAL_VALENCE: 'emotional_valence',
    AROUSAL_LEVEL:     'arousal_level',
    DECISION_VELOCITY: 'decision_velocity',
    ATTENTION_VECTOR:  'attention_vector',
    SYSTEM_MODE:       'system_mode',
    HESITATION_INDEX:  'hesitation_index',
  });

  static THRESHOLDS = Object.freeze({
    cognitive_load:    { low: 0.15, medium: 0.30, high: 0.50, critical: 0.70 },
    emotional_valence: { low: 0.20, medium: 0.40, high: 0.60, critical: 0.80 },
    arousal_level:     { low: 0.10, medium: 0.25, high: 0.45, critical: 0.65 },
    decision_velocity: { low: 0.25, medium: 0.45, high: 0.65, critical: 0.85 },
    attention_vector:  { low: 0.15, medium: 0.35, high: 0.55, critical: 0.75 },
    system_mode:       { low: 0.30, medium: 0.50, high: 0.70, critical: 0.90 },
    hesitation_index:  { low: 0.20, medium: 0.40, high: 0.60, critical: 0.80 },
  });

  constructor({ vault }) { this.#vault = vault; }

  async readSignal(event, session) {
    const raw = event.payload;
    return {
      subjectId:  event.subjectId,
      timestamp:  event.timestamp ?? Date.now(),
      source:     event.source,
      dimensions: {
        cognitive_load:    raw.cognitiveLoad    ?? (raw.errorRate != null ? Math.min(raw.errorRate * 2, 1) : 0.5),
        emotional_valence: raw.emotionalValence ?? raw.sentiment ?? 0.5,
        arousal_level:     raw.arousal          ?? (raw.heartRate != null ? Math.min(Math.max((raw.heartRate - 50) / 100, 0), 1) : 0.5),
        decision_velocity: raw.reactionTimeMs   != null ? Math.max(0, 1 - (raw.reactionTimeMs / 2000)) : (raw.decisionVelocity ?? 0.5),
        attention_vector:  raw.attentionScore   ?? raw.focusIndex ?? 0.5,
        system_mode:       raw.systemMode       ?? 0.5,
        hesitation_index:  raw.hesitationMs     != null ? Math.min(raw.hesitationMs / 3000, 1) : (raw.hesitationIndex ?? 0),
      },
      sessionContext: {
        interventionCount: session.interventions,
        vetoCount:         session.vetoes,
        sessionAgeMs:      Date.now() - session.createdAt,
      },
    };
  }

  /**
   * minSamples: below this per-dimension sample count the baseline is still
   * calibrating — inference on an immature baseline is noise, so nothing is
   * significant yet (fail toward observation, never toward intervention).
   */
  computeDeviation(signal, baseline, { minSamples = 0 } = {}) {
    if (!baseline?.dimensions) return { significant: false, reason: 'no_baseline', dimensions: {} };
    if (minSamples > 0) {
      const immature = Object.values(baseline.dimensions).some(d => (d.sampleCount ?? 0) < minSamples);
      if (immature) return { significant: false, reason: 'calibrating', dimensions: {} };
    }
    const dims = {};
    let maxSeverity = 'none', significantCount = 0;
    for (const [dim, value] of Object.entries(signal.dimensions)) {
      const mean     = baseline.dimensions[dim]?.mean   ?? 0;
      const stdDev   = baseline.dimensions[dim]?.stdDev ?? 0.1;
      const thresh   = GazeEngine.THRESHOLDS[dim];
      if (!thresh) continue;
      const zScore   = stdDev > 0 ? Math.abs(value - mean) / stdDev : Math.abs(value - mean);
      const norm     = Math.min(zScore / 3, 1.0);
      const severity = norm >= thresh.critical ? 'critical' : norm >= thresh.high ? 'high' : norm >= thresh.medium ? 'medium' : norm >= thresh.low ? 'low' : 'none';
      dims[dim]      = { current: value, baseline: mean, deviation: norm, zScore, severity };
      if (severity !== 'none') significantCount++;
      const order    = ['none','low','medium','high','critical'];
      if (order.indexOf(severity) > order.indexOf(maxSeverity)) maxSeverity = severity;
    }
    return { significant: significantCount >= 2 || maxSeverity === 'critical', severity: maxSeverity, dimensions: dims, triggeredAt: Date.now() };
  }

  /**
   * Baseline-poisoning defense: compares each dimension's adaptive mean to the
   * reference pinned at calibration. A slow adversarial (or natural) walk of
   * the baseline shows up here long before it normalizes dangerous states.
   */
  detectDrift(baseline, { driftThreshold = 0.2 } = {}) {
    if (!baseline?.dimensions) return [];
    const drifted = [];
    for (const [dim, stats] of Object.entries(baseline.dimensions)) {
      if (stats.referenceMean == null) continue;
      const drift = Math.abs(stats.mean - stats.referenceMean);
      if (drift > driftThreshold) drifted.push({ dim, mean: stats.mean, referenceMean: stats.referenceMean, drift });
    }
    return drifted;
  }
}
