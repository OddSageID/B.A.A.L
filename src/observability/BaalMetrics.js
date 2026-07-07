export class BaalMetrics {
  #interventionsByIntent = new Map();
  #vetoByReason = new Map();
  #droppedByReason = new Map();
  #resolution = { resolved: 0, unresolved: 0 };
  #holdout = { resolved: 0, unresolved: 0 };
  #aborts = 0;
  #overdueEscalations = 0;
  #baselineDrifts = 0;

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

  /** Holdout cycles observe without intervening — the natural-resolution control arm. */
  markHoldout(outcome = 'UNRESOLVED') {
    if (outcome === 'RESOLVED' || outcome === 'PARTIALLY_RESOLVED') this.#holdout.resolved += 1;
    else this.#holdout.unresolved += 1;
  }

  markDropped(reason = 'unknown') {
    this.#droppedByReason.set(reason, (this.#droppedByReason.get(reason) ?? 0) + 1);
  }

  markAbort() { this.#aborts += 1; }
  markOverdueEscalation() { this.#overdueEscalations += 1; }
  markBaselineDrift() { this.#baselineDrifts += 1; }

  /** Prometheus exposition format for scrape-based monitoring. */
  toPrometheus() {
    const snap = this.snapshot();
    const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const lines = [];
    const counter = (name, help, entries) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, value] of entries) lines.push(`${name}${labels} ${value}`);
    };
    counter('baal_interventions_total', 'Interventions executed by intent class',
      Object.entries(snap.interventionsByIntent).map(([k, v]) => [`{intent_class="${esc(k)}"}`, v]));
    counter('baal_vetoes_total', 'Anat vetoes by reason',
      Object.entries(snap.vetoByReason).map(([k, v]) => [`{reason="${esc(k)}"}`, v]));
    counter('baal_dropped_events_total', 'Events dropped before intervention by reason',
      Object.entries(snap.droppedByReason).map(([k, v]) => [`{reason="${esc(k)}"}`, v]));
    counter('baal_resolutions_total', 'Treated intervention outcomes', [
      ['{outcome="resolved"}', snap.resolution.resolved],
      ['{outcome="unresolved"}', snap.resolution.unresolved],
    ]);
    counter('baal_holdout_total', 'Holdout (observe-only) outcomes', [
      ['{outcome="resolved"}', snap.holdout.resolved],
      ['{outcome="unresolved"}', snap.holdout.unresolved],
    ]);
    counter('baal_aborts_total', 'Interventions aborted mid-ladder', [['', snap.aborts]]);
    counter('baal_overdue_escalations_total', 'Escalations past their ack deadline', [['', snap.overdueEscalations]]);
    counter('baal_baseline_drift_total', 'Baseline drift detections (adaptation frozen)', [['', snap.baselineDrifts]]);
    return lines.join('\n') + '\n';
  }

  snapshot() {
    const rate = ({ resolved, unresolved }) => {
      const total = resolved + unresolved;
      return total === 0 ? null : Math.round((resolved / total) * 1000) / 1000;
    };
    return {
      interventionsByIntent: Object.fromEntries(this.#interventionsByIntent),
      vetoByReason: Object.fromEntries(this.#vetoByReason),
      droppedByReason: Object.fromEntries(this.#droppedByReason),
      resolution: { ...this.#resolution },
      holdout: { ...this.#holdout },
      // Naive efficacy read: treated resolution rate vs natural (holdout) rate.
      efficacy: { treatedRate: rate(this.#resolution), naturalRate: rate(this.#holdout) },
      aborts: this.#aborts,
      overdueEscalations: this.#overdueEscalations,
      baselineDrifts: this.#baselineDrifts,
    };
  }
}
