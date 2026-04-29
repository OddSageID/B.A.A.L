import { describe, test, expect } from '@jest/globals';
import { StormEngine, IntentClass } from '../../src/inference/StormEngine.js';

describe('StormEngine.infer', () => {
  test('classifies panic onset for matching dimensions', async () => {
    const storm = new StormEngine({ threshold: 0.5 });
    const signal = { dimensions: { arousal_level: 0.9, emotional_valence: 0.1, attention_vector: 0.2, cognitive_load: 0.5, decision_velocity:0.5, hesitation_index:0.5, system_mode:0.5 } };
    const deviation = { severity: 'high', dimensions: Object.fromEntries(Object.entries(signal.dimensions).map(([k,v]) => [k,{ current:v }])) };
    const out = await storm.infer({ signal, baseline: null, deviation, history: [] });
    expect(out.primary.class).toBe(IntentClass.PANIC_ONSET);
    expect(out.confident).toBe(true);
  });
});
