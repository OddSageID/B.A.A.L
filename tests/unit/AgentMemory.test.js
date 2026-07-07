import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMemory } from '../../src/memory/AgentMemory.js';

const entry = (planClass, outcome, weight = 0.05) => ({
  intent: { primary: { class: planClass, confidence: 0.8 }, severity: 'high', confident: true },
  plan: { intentClass: planClass, severity: 'high', stepCount: 2 },
  result: { outcome },
  evaluation: { outcomeWeight: weight },
});

describe('AgentMemory', () => {
  test('records and returns history most-recent-last', () => {
    const memory = new AgentMemory();
    memory.record('s1', entry('PANIC_ONSET', 'RESOLVED'));
    memory.record('s1', entry('COGNITIVE_OVERLOAD', 'UNRESOLVED'));
    const history = memory.getHistory('s1');
    assert.equal(history.length, 2);
    assert.equal(history.at(-1).planClass, 'COGNITIVE_OVERLOAD');
    assert.equal(memory.getHistory('unknown').length, 0);
  });

  test('caps entries per subject', () => {
    const memory = new AgentMemory({ maxPerSubject: 3 });
    for (let i = 0; i < 5; i++) memory.record('s1', entry('PANIC_ONSET', 'RESOLVED'));
    assert.equal(memory.getHistory('s1', 100).length, 3);
  });

  test('analyzePatterns surfaces dominant class and chronic risk', () => {
    const memory = new AgentMemory();
    for (let i = 0; i < 8; i++) memory.record('s1', entry('PANIC_ONSET', 'UNRESOLVED'));
    for (let i = 0; i < 3; i++) memory.record('s1', entry('FATIGUE_ONSET', 'RESOLVED'));
    const patterns = memory.analyzePatterns('s1');
    assert.equal(patterns.dominantClass, 'PANIC_ONSET');
    assert.equal(patterns.dominantOutcome, 'UNRESOLVED');
    assert.equal(patterns.chronicRisk, 'HIGH');
    assert.equal(memory.analyzePatterns('unknown'), null);
  });

  test('isPatternRepeating escalates after 3 unresolved repeats', () => {
    const memory = new AgentMemory();
    for (let i = 0; i < 3; i++) memory.record('s1', entry('PANIC_ONSET', 'UNRESOLVED'));
    const verdict = memory.isPatternRepeating('s1', 'PANIC_ONSET');
    assert.equal(verdict.repeating, true);
    assert.equal(verdict.shouldEscalate, true);
  });

  test('sweep drops expired entries and empty subjects', () => {
    const memory = new AgentMemory({ windowHours: -1 }); // cutoff in the future: everything expires
    memory.record('s1', entry('PANIC_ONSET', 'RESOLVED'));
    memory.sweep();
    assert.equal(memory.getHistory('s1', 100).length, 0);
  });

  test('clear and clearAll remove buffers', () => {
    const memory = new AgentMemory();
    memory.record('s1', entry('PANIC_ONSET', 'RESOLVED'));
    memory.record('s2', entry('PANIC_ONSET', 'RESOLVED'));
    memory.clear('s1');
    assert.equal(memory.getHistory('s1').length, 0);
    memory.clearAll();
    assert.equal(memory.getHistory('s2').length, 0);
  });
});
