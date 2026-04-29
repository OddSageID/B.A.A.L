export class AgentMemory {
  #store         = new Map();
  #windowHours   = 24;
  #maxPerSubject = 100;

  constructor({ windowHours = 24, maxPerSubject = 100 } = {}) {
    this.#windowHours   = windowHours;
    this.#maxPerSubject = maxPerSubject;
  }

  record(subjectId, { intent, plan, result, evaluation }) {
    const entry = {
      timestamp: Date.now(),
      intent:    this.#slim(intent),
      planClass: plan?.intentClass,
      severity:  plan?.severity,
      stepCount: plan?.stepCount,
      outcome:   result?.outcome,
      weight:    evaluation?.outcomeWeight,
    };
    const buffer = this.#getOrCreate(subjectId);
    buffer.push(entry);
    this.#evict(buffer);
  }

  getHistory(subjectId, limitEntries = 20) {
    const buffer = this.#store.get(subjectId);
    if (!buffer || buffer.length === 0) return [];
    const cutoff = Date.now() - (this.#windowHours * 3600 * 1000);
    return buffer.filter(e => e.timestamp > cutoff).slice(-limitEntries);
  }

  analyzePatterns(subjectId) {
    const history = this.getHistory(subjectId);
    if (history.length === 0) return null;
    const classCounts = {}, outcomeCounts = {};
    let totalWeight = 0;
    for (const e of history) {
      if (e.planClass) classCounts[e.planClass]   = (classCounts[e.planClass]   ?? 0) + 1;
      if (e.outcome)   outcomeCounts[e.outcome]   = (outcomeCounts[e.outcome]   ?? 0) + 1;
      totalWeight += e.weight ?? 0;
    }
    return {
      subjectId, sampleCount: history.length,
      dominantClass:    this.#maxKey(classCounts),
      dominantOutcome:  this.#maxKey(outcomeCounts),
      classCounts, outcomeCounts,
      avgOutcomeWeight: history.length > 0 ? totalWeight / history.length : 0,
      chronicRisk:      this.#assessChronicRisk(outcomeCounts, history),
    };
  }

  isPatternRepeating(subjectId, intentClass, windowCount = 5) {
    const history    = this.getHistory(subjectId, windowCount);
    const recent     = history.filter(e => e.planClass === intentClass);
    const unresolved = recent.filter(e => e.outcome === 'UNRESOLVED');
    return { repeating: recent.length >= 3, unresolvedCount: unresolved.length, shouldEscalate: unresolved.length >= 3 };
  }

  clear(subjectId) { this.#store.delete(subjectId); }
  clearAll()       { this.#store.clear(); }

  #getOrCreate(subjectId) {
    if (!this.#store.has(subjectId)) this.#store.set(subjectId, []);
    return this.#store.get(subjectId);
  }

  #evict(buffer) {
    const cutoff = Date.now() - (this.#windowHours * 3600 * 1000);
    while (buffer.length > 0 && buffer[0].timestamp < cutoff) buffer.shift();
    while (buffer.length > this.#maxPerSubject) buffer.shift();
  }

  #slim(intent) {
    if (!intent) return null;
    return { primary: { class: intent.primary?.class, confidence: intent.primary?.confidence }, severity: intent.severity, confident: intent.confident };
  }

  #maxKey(obj) {
    if (!obj || Object.keys(obj).length === 0) return null;
    return Object.entries(obj).sort((a, b) => b[1] - a[1])[0][0];
  }

  #assessChronicRisk(outcomeCounts, history) {
    const unresolvedRate = (outcomeCounts['UNRESOLVED'] ?? 0) / Math.max(history.length, 1);
    if (unresolvedRate > 0.6 && history.length > 10) return 'HIGH';
    if (unresolvedRate > 0.4 && history.length > 5)  return 'MEDIUM';
    return 'LOW';
  }
}
