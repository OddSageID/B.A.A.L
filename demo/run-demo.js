#!/usr/bin/env node
/**
 * B.A.A.L. end-to-end demo — no infrastructure required.
 *
 *   npm run demo
 *
 * Runs the REAL pipeline (Gaze → Storm → Cloud → Anat → War) with in-memory
 * stand-ins for Postgres/RabbitMQ/Redis, a console delivery adapter, and a
 * synthetic subject. Walks through the full lifecycle:
 *
 *   calibration → consent → overload intervention → panic escalation →
 *   consent revocation → veto + escalation desk → metrics
 *
 * Step delays and resolution windows are compressed so the demo runs in
 * seconds; the logic is unmodified.
 */
const QUIET = process.argv.includes('--quiet');
if (QUIET) process.env.LOG_LEVEL = 'ERROR';

const { BaalAgent } = await import('../src/agent/BaalAgent.js');
const { CloudPlanner, Intensity, Modality } = await import('../src/planning/CloudPlanner.js');
const { createConsoleDeliveryMap } = await import('../src/execution/adapters/DeliveryAdapters.js');
const { EscalationDesk } = await import('../src/oversight/EscalationDesk.js');

// ── In-memory stand-ins for the three real services ─────────────────────────

const DIMS = ['cognitive_load', 'emotional_valence', 'arousal_level', 'decision_velocity', 'attention_vector', 'system_mode', 'hesitation_index'];

class InMemoryVault {
  baselines = new Map(); consents = new Map();
  interventions = []; vetoes = []; escalations = new Map();

  async getBaseline(subjectId) { return this.baselines.get(subjectId) ?? null; }
  async getConsentRecord(subjectId) { return this.consents.get(subjectId) ?? null; }

  // Mirrors the SQL EWMA + reference pinning in BaselineVault.
  async updateBaseline(subjectId, signal, weight, { pinAfterSamples = 30 } = {}) {
    let baseline = this.baselines.get(subjectId);
    if (!baseline) { baseline = { subjectId, dimensions: {} }; this.baselines.set(subjectId, baseline); }
    for (const [dim, value] of Object.entries(signal.dimensions)) {
      if (value == null) continue;
      const d = baseline.dimensions[dim] ?? { mean: value, stdDev: 0.1, sampleCount: 0, referenceMean: null };
      d.stdDev = Math.max(Math.sqrt(d.stdDev ** 2 * (1 - weight) + (value - d.mean) ** 2 * weight), 0.01);
      d.mean = d.mean * (1 - weight) + value * weight;
      d.sampleCount += 1;
      if (d.referenceMean == null && d.sampleCount >= pinAfterSamples) d.referenceMean = d.mean;
      baseline.dimensions[dim] = d;
    }
    return { duplicate: false };
  }

  async countRecentInterventions() { return { lastHour: 0, lastDay: 0 }; }
  async logIntervention(entry) { this.interventions.push(entry); }
  async logVeto(entry) { this.vetoes.push(entry); }
  async recordEscalation(entry) { this.escalations.set(entry.escalationId, { ...entry, ackedAt: null }); }
  async ackEscalation(id, actor) {
    const e = this.escalations.get(id);
    if (!e || e.ackedAt) return false;
    e.ackedAt = new Date(); e.ackedBy = actor;
    return true;
  }
  async pendingEscalations() {
    return [...this.escalations.values()].filter(e => !e.ackedAt)
      .map(e => ({ id: e.escalationId, subject_id: e.subjectId, reason: e.reason, ack_deadline: e.ackDeadline }));
  }
  async overdueEscalations() { return []; }
  async markEscalationAlerted() {}
  async health() { return { connected: true }; }
  async disconnect() {}
}

class InMemoryQueue {
  handler = null; escalationHandler = null;
  async consume(handler) { this.handler = handler; }
  async consumeEscalations(handler) { this.escalationHandler = handler; }
  async publishEscalation(escalation) { await this.escalationHandler?.(escalation); }
  health() { return { connected: true }; }
  async close() {}
}

/** Real closed-loop window semantics, compressed to ≤600ms. */
class InMemoryMonitor {
  #pending = new Map();
  async forwardDeviation(subjectId, deviation) {
    const window = this.#pending.get(subjectId);
    if (!window) return;
    this.#pending.delete(subjectId);
    clearTimeout(window.timer);
    const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    window.resolve({
      resolved: !deviation.significant,
      partiallyResolved: deviation.significant && order[deviation.severity] <= 1,
      signal: { deviation }, timedOut: false,
    });
  }
  waitForResolution(subjectId, windowMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(subjectId);
        resolve({ resolved: false, partiallyResolved: false, signal: null, timedOut: true });
      }, Math.min(windowMs, 600));
      this.#pending.set(subjectId, { resolve, timer });
    });
  }
  health() { return { connected: true }; }
  get activeWindowCount() { return this.#pending.size; }
  async shutdown() {}
}

// ── The synthetic subject ────────────────────────────────────────────────────

const SUBJECT = 'demo-subject-7';
let eventSeq = 0;
const event = (type, payload) => ({
  eventId: `demo-${++eventSeq}`, subjectId: SUBJECT, source: 'behavioral', type,
  timestamp: Date.now() + eventSeq, // strictly advancing — satisfies the ordering guard
  payload,
});
// A steady subject: identical calm readings keep the demo deterministic —
// against a fully converged baseline even tiny noise reads as deviation.
const calm     = () => event('steady',  { cognitiveLoad: 0.3, arousal: 0.3, emotionalValence: 0.6, attentionScore: 0.6, systemMode: 0.5, reactionTimeMs: 900, hesitationMs: 300 });
const overload = () => event('burst',   { cognitiveLoad: 0.92, arousal: 0.72, emotionalValence: 0.5, attentionScore: 0.5, systemMode: 0.5, reactionTimeMs: 1850, hesitationMs: 100 });
const panic    = () => event('spike',   { cognitiveLoad: 0.55, arousal: 0.93, emotionalValence: 0.08, attentionScore: 0.18, systemMode: 0.5, reactionTimeMs: 700, hesitationMs: 1600 });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (msg) => console.log(msg);
const banner = (title) => say(`\n━━━ ${title} ${'━'.repeat(Math.max(2, 64 - title.length))}\n`);

// ── Assemble the agent with real engines, fake services ─────────────────────

const vault = new InMemoryVault();
const queue = new InMemoryQueue();
const monitor = new InMemoryMonitor();
const realPlanner = new CloudPlanner({ depth: 3 });
const fastPlanner = { // identical plans, step delays compressed for the demo
  plan: async (args) => {
    const plan = await realPlanner.plan(args);
    return { ...plan, steps: plan.steps.map(s => ({ ...s, delayMs: Math.min(s.delayMs, 250) })) };
  },
};
const desk = new EscalationDesk({ queue, vault, metrics: null, ackTimeoutMs: 60000 });

// Real executor, but deliveries print to the terminal instead of the silent stubs.
const { WarExecutor } = await import('../src/execution/WarExecutor.js');
const executor = new WarExecutor();
executor.setDeliveryMap(createConsoleDeliveryMap());

const agent = new BaalAgent({ healthPort: 0 });
await agent.initialize({
  vault, queue, monitor, cloud: fastPlanner, executor, escalationDesk: desk,
  healthServer: { start: async () => {}, stop: async () => {} },
});

banner('B.A.A.L. DEMO — Behavioral Anticipatory Autonomy Layer');
say('Real pipeline, in-memory services, one synthetic subject. Delays compressed.');

await agent.run();

// ── Scenario 1: calibration ──────────────────────────────────────────────────

banner('1 · CALIBRATION — 32 calm signals build the behavioral baseline');
for (let i = 0; i < 32; i++) await queue.handler(calm());
const base = vault.baselines.get(SUBJECT).dimensions.cognitive_load;
say(`Baseline mature: cognitive_load mean=${base.mean.toFixed(3)} n=${base.sampleCount}, reference pinned at ${base.referenceMean.toFixed(3)}.`);
say('During calibration NOTHING can trigger an intervention — inference is gated.');

// ── Scenario 2: consent ──────────────────────────────────────────────────────

banner('2 · CONSENT — without it, every intervention is vetoed');
await queue.handler(overload());
say(`Overload signal WITHOUT consent → veto (${vault.vetoes[0]?.vetoReason}), escalation recorded for a human.`);
vault.consents.set(SUBJECT, {
  subjectId: SUBJECT, active: true, optedOut: false,
  maxPermittedIntensity: Intensity.PROMPT,
  consentedModalities: [Modality.HAPTIC, Modality.AUDITORY, Modality.COGNITIVE, Modality.NOTIFICATION],
  expiresAt: null,
});
say('Consent granted: haptic, auditory, cognitive, notification — up to PROMPT.');

// ── Scenario 3: cognitive overload, resolved at step 1 ───────────────────────

banner('3 · OVERLOAD — whisper-level nudge, subject recovers, ladder stops');
const overloadRun = queue.handler(overload());
await sleep(120);
await queue.handler(calm());  // the subject settles → closed loop resolves the window
await overloadRun;
const first = vault.interventions.at(-1);
say(`Outcome: ${first.evaluation.outcome} after ${first.result.stepsExecuted} step(s) — escalation ladder never went past WHISPER.`);

// ── Scenario 4: panic — ladder escalates to the caregiver alert ──────────────

banner('4 · PANIC — subject does not recover, ladder climbs to a human');
const panicRun = queue.handler(panic());
const feeder = setInterval(() => { queue.handler(panic()).catch(() => {}); }, 130); // still panicking
await panicRun;
clearInterval(feeder);
const panicResult = vault.interventions.at(-1);
say(`Outcome: ${panicResult.evaluation.outcome} — caregiver notification fired at step ${panicResult.result.executionLog.at(-1).step}.`);

// ── Scenario 5: revocation + escalation desk ────────────────────────────────

banner('5 · REVOCATION — consent withdrawn, Anat blocks, a human is paged');
vault.consents.set(SUBJECT, { ...vault.consents.get(SUBJECT), active: false, optedOut: true });
await queue.handler(overload());
const pending = await desk.pending();
say(`Veto: ${vault.vetoes.at(-1).vetoReason}. Escalation desk now holds ${pending.length} unacknowledged escalation(s):`);
for (const e of pending) say(`   ${e.id}  reason=${e.reason}`);
await desk.ack(pending[0].id, 'demo-operator');
say(`Acknowledged by demo-operator → ${(await desk.pending()).length} pending.`);

// ── Wrap up ──────────────────────────────────────────────────────────────────

banner('METRICS');
console.log(JSON.stringify(agent.metrics.snapshot(), null, 2));
await agent.shutdown();
banner('DEMO COMPLETE');
say('Next steps: docker compose up -d && npm start, then wire a real producer');
say('with src/client/BaalProducer.js and manage consent with bin/baalctl.js.\n');
