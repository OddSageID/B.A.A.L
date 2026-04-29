export class BaalMetrics {
  #interventionsByIntent = new Map();
  #vetoByReason = new Map();
  #resolution = { resolved: 0, unresolved: 0 };

  markIntervention(intentClass = 'UNKNOWN') {
    this.#interventionsByIntent.set(intentClass, (this.#interventionsByIntent.get(intentClass) ?? 0) + 1);
  }

  markVeto(reason = 'UNKNOWN') {
    this.#vetoByReason.set(reason, (this.#vetoByReason.get(reason) ?? 0) + 1);
  }

  markResolution(outcome = 'UNRESOLVED') {
    if (outcome === 'RESOLVED' || outcome === 'PARTIALLY_RESOLVED') this.#resolution.resolved += 1;
    else this.#resolution.unresolved += 1;
  }

  snapshot() {
    return {
      interventionsByIntent: Object.fromEntries(this.#interventionsByIntent),
      vetoByReason: Object.fromEntries(this.#vetoByReason),
      resolution: { ...this.#resolution },
    };
  }
}
