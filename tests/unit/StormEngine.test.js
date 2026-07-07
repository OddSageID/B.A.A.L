import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { StormEngine, IntentClass } from '../../src/inference/StormEngine.js';

const asDeviation = (dims, severity = 'high') => ({
  severity,
  dimensions: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, { current: v }])),
});

describe('StormEngine.infer', () => {
  test('classifies panic onset for matching dimensions', async () => {
    const storm = new StormEngine({ threshold: 0.5 });
    const dims = { arousal_level: 0.9, emotional_valence: 0.1, attention_vector: 0.2, cognitive_load: 0.5, decision_velocity: 0.5, hesitation_index: 0.5, system_mode: 0.5 };
    const out = await storm.infer({ signal: { dimensions: dims }, baseline: null, deviation: asDeviation(dims), history: [] });
    assert.equal(out.primary.class, IntentClass.PANIC_ONSET);
    assert.equal(out.confident, true);
  });

  test('returns UNKNOWN with zero confidence when nothing matches', async () => {
    const storm = new StormEngine({ threshold: 0.72 });
    const dims = { arousal_level: 0.5, emotional_valence: 0.5, attention_vector: 0.5, cognitive_load: 0.45, decision_velocity: 0.5, hesitation_index: 0.3, system_mode: 0.5 };
    const out = await storm.infer({ signal: { dimensions: dims }, baseline: null, deviation: asDeviation(dims, 'medium'), history: [] });
    assert.equal(out.primary.class, IntentClass.UNKNOWN);
    assert.equal(out.primary.confidence, 0);
    assert.equal(out.confident, false);
  });

  test('confidence never exceeds 1.0 despite rule weights above 1 (regression)', async () => {
    const storm = new StormEngine({ threshold: 0.5 });
    const dims = { arousal_level: 0.9, emotional_valence: 0.1, attention_vector: 0.2, cognitive_load: 0.5, decision_velocity: 0.5, hesitation_index: 0.5, system_mode: 0.5 };
    const out = await storm.infer({ signal: { dimensions: dims }, baseline: null, deviation: asDeviation(dims), history: [] });
    assert.ok(out.primary.confidence <= 1.0);
  });

  test('recent history of the same class boosts confidence (capped at +0.15)', async () => {
    const storm = new StormEngine({ threshold: 0.5 });
    // Barely-matching PANIC dims: base confidence well below 1 so the boost is visible.
    const dims = { arousal_level: 0.81, emotional_valence: 0.24, attention_vector: 0.34, cognitive_load: 0.5, decision_velocity: 0.5, hesitation_index: 0.5, system_mode: 0.5 };
    const args = { signal: { dimensions: dims }, baseline: null, deviation: asDeviation(dims) };
    const cold = await storm.infer({ ...args, history: [] });
    const history = Array.from({ length: 10 }, () => ({ intent: { primary: { class: IntentClass.PANIC_ONSET } } }));
    const warm = await storm.infer({ ...args, history });
    assert.ok(cold.primary.confidence < 1.0, 'test setup: base confidence must be sub-1');
    assert.ok(warm.primary.confidence > cold.primary.confidence);
    assert.ok(warm.primary.confidence - cold.primary.confidence <= 0.15 + 1e-9);
  });
});
