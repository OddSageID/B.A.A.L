/**
 * Two-instance contention — the check HANDOFF.md listed as manual.
 * Two full BaalAgent instances share real Redis (locks + resolution channel);
 * Postgres/RabbitMQ are faked because the property under test is lock
 * exclusivity across replicas, not transport.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaalAgent } from '../../src/agent/BaalAgent.js';
import { ResolutionMonitor } from '../../src/execution/ResolutionMonitor.js';
import { Modality, Intensity } from '../../src/planning/CloudPlanner.js';

const LIVE = process.env.BAAL_LIVE === '1';
const DIMS = ['cognitive_load', 'emotional_valence', 'arousal_level', 'decision_velocity', 'attention_vector', 'system_mode', 'hesitation_index'];

class SharedFakeVault {
  interventionLog = []; vetoLog = []; baselineUpdates = [];
  baselines = new Map(); consents = new Map();
  async getBaseline(s) { return this.baselines.get(s) ?? null; }
  async getConsentRecord(s) { return this.consents.get(s) ?? null; }
  async updateBaseline(s, sig, w) { this.baselineUpdates.push({ s, w }); }
  async logIntervention(e) { this.interventionLog.push(e); }
  async logVeto(e) { this.vetoLog.push(e); }
  async health() { return { connected: true }; }
  async disconnect() {}
}

const fakeQueue = () => ({
  handler: null,
  async consume(h) { this.handler = h; },
  async publishEscalation() {},
  health() { return { connected: true }; },
  async close() {},
});

const noopHealth = { start: async () => {}, stop: async () => {} };

const matureBaseline = (subjectId) => ({
  subjectId,
  dimensions: Object.fromEntries(DIMS.map(d => [d, { mean: 0.2, stdDev: 0.05, sampleCount: 100, referenceMean: 0.2 }])),
});

const overloadEvent = (subjectId, n) => ({
  eventId: `contention-${n}-${Date.now()}`, subjectId, source: 'behavioral', type: 'burst',
  timestamp: Date.now() + n,
  payload: { cognitiveLoad: 0.92, arousal: 0.72, emotionalValence: 0.5, attentionScore: 0.5, systemMode: 0.5, reactionTimeMs: 1850, hesitationMs: 100 },
});

describe('live: cross-instance intervention exclusivity', { skip: !LIVE, concurrency: 1 }, () => {
  test('two agents flooded with one subject run exactly one intervention', async () => {
    const subjectId = `contention-${Date.now()}`;
    const vault = new SharedFakeVault();
    vault.baselines.set(subjectId, matureBaseline(subjectId));
    vault.consents.set(subjectId, {
      subjectId, active: true, optedOut: false,
      maxPermittedIntensity: Intensity.SIGNAL,
      consentedModalities: [Modality.HAPTIC, Modality.AUDITORY, Modality.COGNITIVE],
      expiresAt: null,
    });

    const agents = [];
    try {
      for (let i = 0; i < 2; i++) {
        const queue = fakeQueue();
        const monitor = await ResolutionMonitor.create(); // real Redis: lock + windows
        const agent = new BaalAgent({ healthPort: 0, planningDepth: 1 });
        await agent.initialize({ vault, queue, monitor, healthServer: noopHealth, escalationDesk: null });
        await agent.run();
        agents.push({ agent, queue, monitor });
      }

      // Both instances receive significant signals for the same subject at once.
      // planningDepth 1 → single WHISPER step, ~2s resolution window (times out
      // unresolved since no calm signal is fed) — long enough that the second
      // acquire is guaranteed to contend.
      await Promise.all([
        agents[0].queue.handler(overloadEvent(subjectId, 1)),
        agents[1].queue.handler(overloadEvent(subjectId, 2)),
      ]);

      assert.equal(vault.interventionLog.length, 1, 'exactly one intervention across both instances');
      assert.equal(vault.vetoLog.length, 0);
      const interventions = agents.map(({ agent }) => agent.metrics.snapshot().interventionsByIntent.COGNITIVE_OVERLOAD ?? 0);
      assert.deepEqual(interventions.sort(), [0, 1], 'one instance intervened, the other stood down');
    } finally {
      for (const { agent } of agents) await agent.shutdown();
    }
  }, { timeout: 30000 });
});
