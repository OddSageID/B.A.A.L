import { describe, test, expect } from '@jest/globals';
import { GazeEngine } from '../../src/perception/GazeEngine.js';

describe('GazeEngine.computeDeviation', () => {
  const engine = new GazeEngine({ vault: null });

  test('returns non-significant when baseline absent', () => {
    const res = engine.computeDeviation({ dimensions: {} }, null);
    expect(res.significant).toBe(false);
    expect(res.reason).toBe('no_baseline');
  });

  test('marks critical when a dimension crosses threshold', () => {
    const signal = { dimensions: { cognitive_load: 1, emotional_valence: 0.5, arousal_level:0.5, decision_velocity:0.5, attention_vector:0.5, system_mode:0.5, hesitation_index:0.5 } };
    const baseline = { dimensions: Object.fromEntries(Object.keys(signal.dimensions).map(k => [k, { mean: 0.1, stdDev: 0.1 }])) };
    const res = engine.computeDeviation(signal, baseline);
    expect(res.severity).toBe('critical');
    expect(res.significant).toBe(true);
  });
});
