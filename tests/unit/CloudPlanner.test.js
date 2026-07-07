import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudPlanner, Modality, Intensity } from '../../src/planning/CloudPlanner.js';
import { IntentClass } from '../../src/inference/StormEngine.js';

const intentOf = (cls, { confident = true, confidence = 0.9, severity = 'high' } = {}) => ({
  primary: { class: cls, confidence }, confident, severity,
});

describe('CloudPlanner.plan', () => {
  test('selects the strategy ladder for a confident intent', async () => {
    const planner = new CloudPlanner({ depth: 3 });
    const plan = await planner.plan({ intent: intentOf(IntentClass.COGNITIVE_OVERLOAD), subjectId: 's1', sessionContext: null });
    assert.equal(plan.intentClass, IntentClass.COGNITIVE_OVERLOAD);
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].intensity, Intensity.WHISPER);
    assert.equal(plan.requiresHuman, false);
    assert.ok(plan.expiresAt > plan.plannedAt);
  });

  test('flags requiresHuman when the ladder contains a notification', async () => {
    const planner = new CloudPlanner({ depth: 3 });
    const plan = await planner.plan({ intent: intentOf(IntentClass.PANIC_ONSET), subjectId: 's1', sessionContext: null });
    assert.equal(plan.requiresHuman, true);
    assert.equal(plan.steps.at(-1).modality, Modality.NOTIFICATION);
  });

  test('depth truncates the ladder', async () => {
    const planner = new CloudPlanner({ depth: 2 });
    const plan = await planner.plan({ intent: intentOf(IntentClass.PANIC_ONSET), subjectId: 's1', sessionContext: null });
    assert.equal(plan.steps.length, 2);
    assert.equal(plan.requiresHuman, false); // notification was step 3
  });

  test('low confidence yields a silent observation plan', async () => {
    const planner = new CloudPlanner({ depth: 3 });
    const plan = await planner.plan({ intent: intentOf(IntentClass.PANIC_ONSET, { confident: false }), subjectId: 's1', sessionContext: null });
    assert.equal(plan.intentClass, 'UNKNOWN');
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0].modality, Modality.SILENT_LOG);
  });

  test('unmapped intent class yields a silent unclassified plan', async () => {
    const planner = new CloudPlanner({ depth: 3 });
    const plan = await planner.plan({ intent: intentOf(IntentClass.RAGE_VECTOR), subjectId: 's1', sessionContext: null });
    assert.equal(plan.intentClass, 'UNKNOWN');
    assert.equal(plan.steps[0].cue, 'unclassified_pattern');
  });

  test('heavy intervention history escalates sub-SIGNAL intensities', async () => {
    const planner = new CloudPlanner({ depth: 3 });
    const plan = await planner.plan({
      intent: intentOf(IntentClass.COGNITIVE_OVERLOAD), subjectId: 's1',
      sessionContext: { interventionCount: 6 },
    });
    assert.equal(plan.steps[0].intensity, Intensity.WHISPER + 1);
    assert.match(plan.steps[0].rationale, /\[escalated\]$/);
    // Steps already at SIGNAL or above are untouched.
    assert.equal(plan.steps[2].intensity, Intensity.SIGNAL);
  });
});
