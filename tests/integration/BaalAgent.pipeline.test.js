import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaalAgent } from '../../src/agent/BaalAgent.js';
import { Modality, Intensity } from '../../src/planning/CloudPlanner.js';
import { IntentClass } from '../../src/inference/StormEngine.js';
import { Outcome } from '../../src/execution/WarExecutor.js';

/**
 * Full ReAct loop with in-memory fakes at the real service boundaries
 * (Postgres, RabbitMQ, Redis). Everything between — Gaze, Storm, Cloud,
 * Anat, War — is the real implementation.
 */
class FakeVault {
  baselines = new Map(); consents = new Map();
  baselineUpdates = []; interventionLog = []; vetoLog = [];
  async getBaseline(subjectId) { return this.baselines.get(subjectId) ?? null; }
  async getConsentRecord(subjectId) { return this.consents.get(subjectId) ?? null; }
  async updateBaseline(subjectId, signal, weight) { this.baselineUpdates.push({ subjectId, signal, weight }); }
  async logIntervention(entry) { this.interventionLog.push(entry); }
  async logVeto(entry) { this.vetoLog.push(entry); }
  async health() { return { connected: true }; }
  async disconnect() {}
}

class FakeQueue {
  handler = null; escalations = [];
  async consume(handler) { this.handler = handler; }
  async publishEscalation(escalation) { this.escalations.push(escalation); }
  health() { return { connected: true }; }
  async close() {}
}

class FakeMonitor {
  forwarded = [];
  constructor({ resolved = true, delayMs = 0 } = {}) { this.resolved = resolved; this.delayMs = delayMs; }
  async forwardDeviation(subjectId, deviation, ts) { this.forwarded.push({ subjectId, deviation, ts }); }
  async waitForResolution() {
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    return { resolved: this.resolved, partiallyResolved: false, signal: null, timedOut: !this.resolved };
  }
  health() { return { connected: true }; }
  get activeWindowCount() { return 0; }
  async shutdown() {}
}

const noopHealthServer = { start: async () => {}, stop: async () => {} };

const flatBaseline = (subjectId) => ({
  subjectId,
  dimensions: Object.fromEntries(
    ['cognitive_load', 'emotional_valence', 'arousal_level', 'decision_velocity', 'attention_vector', 'system_mode', 'hesitation_index']
      .map(d => [d, { mean: 0.2, stdDev: 0.05 }])
  ),
});

const fullConsent = (subjectId, { maxIntensity = Intensity.SIGNAL, modalities = [Modality.HAPTIC, Modality.AUDITORY, Modality.COGNITIVE] } = {}) => ({
  subjectId, active: true, optedOut: false,
  maxPermittedIntensity: maxIntensity, consentedModalities: modalities, expiresAt: null,
});

// Dimensions that hit COGNITIVE_OVERLOAD and nothing else (see StormEngine rules).
const overloadEvent = (subjectId) => ({
  eventId: `evt-${Math.random().toString(36).slice(2)}`, subjectId, source: 'behavioral', type: 'burst',
  timestamp: Date.now(),
  payload: { cognitiveLoad: 0.9, arousal: 0.7, emotionalValence: 0.5, attentionScore: 0.5, systemMode: 0.5, reactionTimeMs: 1800, hesitationMs: 0 },
});

const calmEvent = (subjectId) => ({
  eventId: 'evt-calm', subjectId, source: 'behavioral', type: 'steady',
  timestamp: Date.now(),
  payload: { cognitiveLoad: 0.2, arousal: 0.2, emotionalValence: 0.2, attentionScore: 0.2, systemMode: 0.2, reactionTimeMs: 1600, hesitationMs: 600 },
});

const panicEvent = (subjectId) => ({
  eventId: 'evt-panic', subjectId, source: 'biometric', type: 'spike',
  timestamp: Date.now(),
  payload: { cognitiveLoad: 0.5, arousal: 0.9, emotionalValence: 0.1, attentionScore: 0.2, systemMode: 0.5, hesitationMs: 1500 },
});

async function buildAgent({ vault = new FakeVault(), queue = new FakeQueue(), monitor = new FakeMonitor(), config = {} } = {}) {
  const agent = new BaalAgent({ healthPort: 0, ...config });
  await agent.initialize({ vault, queue, monitor, healthServer: noopHealthServer });
  await agent.run();
  return { agent, vault, queue, monitor };
}

describe('BaalAgent pipeline', () => {
  test('insignificant deviation only updates the baseline', async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    const { queue, agent } = await buildAgent({ vault });
    await queue.handler(calmEvent('s1'));
    assert.equal(vault.baselineUpdates.length, 1);
    assert.equal(vault.baselineUpdates[0].weight, 0.05);
    assert.equal(vault.interventionLog.length, 0);
    assert.deepEqual(agent.metrics.snapshot().interventionsByIntent, {});
    await agent.shutdown();
  });

  test('significant deviation with consent runs the full intervention cycle', async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    vault.consents.set('s1', fullConsent('s1'));
    const { queue, monitor, agent } = await buildAgent({ vault });

    await queue.handler(overloadEvent('s1'));

    // Deviation was forwarded to the resolution loop before intervening.
    assert.equal(monitor.forwarded.length, 1);
    // Intervention executed and audited.
    assert.equal(vault.interventionLog.length, 1);
    assert.equal(vault.interventionLog[0].intentClass, IntentClass.COGNITIVE_OVERLOAD);
    assert.equal(vault.interventionLog[0].evaluation.outcome, Outcome.RESOLVED);
    // Baseline adapted with the evaluated outcome weight, not the passive weight.
    assert.equal(vault.baselineUpdates.length, 1);
    assert.ok(vault.baselineUpdates[0].weight <= 0.02);
    const snap = agent.metrics.snapshot();
    assert.equal(snap.interventionsByIntent[IntentClass.COGNITIVE_OVERLOAD], 1);
    assert.equal(snap.resolution.resolved, 1);
    await agent.shutdown();
  });

  test('missing consent vetoes, escalates durably, and never executes', async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    // no consent record for s1
    const { queue, agent } = await buildAgent({ vault });

    await queue.handler(overloadEvent('s1'));

    assert.equal(vault.interventionLog.length, 0);
    assert.equal(vault.vetoLog.length, 1);
    assert.equal(vault.vetoLog[0].vetoReason, 'CONSENT_NOT_ESTABLISHED');
    assert.equal(queue.escalations.length, 1);
    assert.equal(queue.escalations[0].reason, 'CONSENT_NOT_ESTABLISHED');
    assert.equal(agent.metrics.snapshot().vetoByReason.CONSENT_NOT_ESTABLISHED, 1);
    await agent.shutdown();
  });

  test("Anat's modified plan (prepended human alert) is what actually executes", async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    vault.consents.set('s1', fullConsent('s1', { modalities: [Modality.HAPTIC, Modality.AUDITORY] }));
    // Depth 2 truncates PANIC's ladder before its own notification step,
    // forcing Anat to prepend the human-oversight alert.
    const { queue, agent } = await buildAgent({ vault, config: { planningDepth: 2 } });

    await queue.handler(panicEvent('s1'));

    assert.equal(vault.interventionLog.length, 1);
    const executed = vault.interventionLog[0];
    assert.equal(executed.intentClass, IntentClass.PANIC_ONSET);
    assert.equal(executed.plan.steps[0].modality, Modality.NOTIFICATION, 'human alert must be step 0');
    assert.equal(executed.result.executionLog[0].modality, Modality.NOTIFICATION, 'human alert must actually fire');
    assert.equal(executed.evaluation.outcome, Outcome.ESCALATED);
    await agent.shutdown();
  });

  test('only one intervention per subject runs at a time', async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    vault.consents.set('s1', fullConsent('s1'));
    const monitor = new FakeMonitor({ resolved: true, delayMs: 30 });
    const { queue, agent } = await buildAgent({ vault, monitor });

    await Promise.all([queue.handler(overloadEvent('s1')), queue.handler(overloadEvent('s1'))]);

    assert.equal(agent.metrics.snapshot().interventionsByIntent[IntentClass.COGNITIVE_OVERLOAD], 1);
    assert.equal(vault.interventionLog.length, 1);
    // Both signals still fed the resolution loop.
    assert.equal(monitor.forwarded.length, 2);
    await agent.shutdown();
  });

  test('audit failures never break the loop', async () => {
    const vault = new FakeVault();
    vault.baselines.set('s1', flatBaseline('s1'));
    vault.consents.set('s1', fullConsent('s1'));
    vault.logIntervention = async () => { throw new Error('pg down'); };
    const { queue, agent } = await buildAgent({ vault });
    await queue.handler(overloadEvent('s1')); // must not throw
    assert.equal(agent.metrics.snapshot().interventionsByIntent[IntentClass.COGNITIVE_OVERLOAD], 1);
    await agent.shutdown();
  });
});
