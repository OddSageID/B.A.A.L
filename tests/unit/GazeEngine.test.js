import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GazeEngine } from '../../src/perception/GazeEngine.js';

describe('GazeEngine.computeDeviation', () => {
  const engine = new GazeEngine({ vault: null });

  test('returns non-significant when baseline absent', () => {
    const res = engine.computeDeviation({ dimensions: {} }, null);
    assert.equal(res.significant, false);
    assert.equal(res.reason, 'no_baseline');
  });

  test('marks critical when a dimension crosses threshold', () => {
    const signal = { dimensions: { cognitive_load: 1, emotional_valence: 0.5, arousal_level: 0.5, decision_velocity: 0.5, attention_vector: 0.5, system_mode: 0.5, hesitation_index: 0.5 } };
    const baseline = { dimensions: Object.fromEntries(Object.keys(signal.dimensions).map(k => [k, { mean: 0.1, stdDev: 0.1 }])) };
    const res = engine.computeDeviation(signal, baseline);
    assert.equal(res.severity, 'critical');
    assert.equal(res.significant, true);
  });

  test('signal matching baseline is not significant', () => {
    const dims = { cognitive_load: 0.3, emotional_valence: 0.5, arousal_level: 0.4, decision_velocity: 0.5, attention_vector: 0.6, system_mode: 0.5, hesitation_index: 0.2 };
    const baseline = { dimensions: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { mean: v, stdDev: 0.1 }])) };
    const res = engine.computeDeviation({ dimensions: dims }, baseline);
    assert.equal(res.significant, false);
    assert.equal(res.severity, 'none');
  });
});

describe('GazeEngine.readSignal', () => {
  const engine = new GazeEngine({ vault: null });
  const session = { interventions: 2, vetoes: 1, createdAt: Date.now() - 5000 };

  test('maps raw payload fields onto the seven dimensions', async () => {
    const event = {
      subjectId: 's1', source: 'biometric', timestamp: 123,
      payload: { cognitiveLoad: 0.7, heartRate: 100, reactionTimeMs: 1000, hesitationMs: 1500, attentionScore: 0.8 },
    };
    const signal = await engine.readSignal(event, session);
    assert.equal(signal.subjectId, 's1');
    assert.equal(signal.timestamp, 123);
    assert.equal(signal.dimensions.cognitive_load, 0.7);
    assert.equal(signal.dimensions.arousal_level, 0.5);          // (100-50)/100
    assert.equal(signal.dimensions.decision_velocity, 0.5);      // 1 - 1000/2000
    assert.equal(signal.dimensions.hesitation_index, 0.5);       // 1500/3000
    assert.equal(signal.dimensions.attention_vector, 0.8);
    assert.equal(signal.sessionContext.interventionCount, 2);
    assert.equal(signal.sessionContext.vetoCount, 1);
  });

  test('falls back to neutral 0.5 for absent metrics', async () => {
    const signal = await engine.readSignal({ subjectId: 's1', source: 'behavioral', payload: {} }, session);
    assert.equal(signal.dimensions.cognitive_load, 0.5);
    assert.equal(signal.dimensions.emotional_valence, 0.5);
    assert.equal(signal.dimensions.hesitation_index, 0);
  });
});
