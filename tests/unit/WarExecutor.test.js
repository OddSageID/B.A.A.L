import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WarExecutor, Outcome } from '../../src/execution/WarExecutor.js';
import { Modality, Intensity } from '../../src/planning/CloudPlanner.js';

const monitorResolving = (resolved, { partiallyResolved = false } = {}) => ({
  waitForResolution: async () => ({ resolved, partiallyResolved, signal: null, timedOut: !resolved }),
});

const planOf = (steps) => ({
  intentClass: 'COGNITIVE_OVERLOAD', severity: 'high',
  plannedAt: Date.now(), expiresAt: Date.now() + 30000, steps,
});

const step = (n, modality, intensity, condition) => ({
  step: n, modality, intensity, cue: `cue_${n}`, rationale: 'test', delayMs: 0, condition,
});

describe('WarExecutor.execute', () => {
  test('expired plan is never executed', async () => {
    const war = new WarExecutor();
    const plan = { ...planOf([step(1, Modality.HAPTIC, Intensity.WHISPER)]), expiresAt: Date.now() - 1 };
    const result = await war.execute(plan, 's1');
    assert.equal(result.outcome, Outcome.EXPIRED);
    assert.equal(result.stepsExecuted, 0);
  });

  test('resolution after step 1 stops the ladder', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(true));
    const plan = planOf([
      step(1, Modality.HAPTIC, Intensity.WHISPER),
      step(2, Modality.AUDITORY, Intensity.NUDGE, 'if_step_1_unresolved'),
    ]);
    const result = await war.execute(plan, 's1');
    assert.equal(result.outcome, Outcome.RESOLVED);
    assert.equal(result.stepsExecuted, 1);
  });

  test('unresolved steps trigger conditional escalation through the ladder', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(false));
    const plan = planOf([
      step(1, Modality.HAPTIC, Intensity.WHISPER),
      step(2, Modality.AUDITORY, Intensity.NUDGE, 'if_step_1_unresolved'),
    ]);
    const result = await war.execute(plan, 's1');
    assert.equal(result.outcome, Outcome.UNRESOLVED);
    assert.equal(result.stepsExecuted, 2);
  });

  test('notification steps mark the run escalated', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(true));
    const plan = planOf([
      step(0, Modality.NOTIFICATION, Intensity.PROMPT),
      step(1, Modality.HAPTIC, Intensity.NUDGE),
    ]);
    const result = await war.execute(plan, 's1');
    assert.equal(result.outcome, Outcome.ESCALATED);
    assert.equal(result.executionLog[0].escalated, true);
  });

  test('failed notification delivery is surfaced as escalationFailed', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(true));
    war.setDeliveryMap({ [Modality.NOTIFICATION]: async () => { throw new Error('pager service down'); } });
    const plan = planOf([step(1, Modality.NOTIFICATION, Intensity.PROMPT)]);
    const result = await war.execute(plan, 's1');
    assert.equal(result.executionLog[0].escalationFailed, true);
    assert.equal(result.outcome, Outcome.UNRESOLVED); // honest: escalation did NOT happen
  });

  test('silent_log delivers without opening a resolution window', async () => {
    const war = new WarExecutor();
    let windowOpened = false;
    war.setMonitor({ waitForResolution: async () => { windowOpened = true; return { resolved: false, partiallyResolved: false, signal: null, timedOut: true }; } });
    const plan = planOf([step(1, Modality.SILENT_LOG, Intensity.WHISPER)]);
    const result = await war.execute(plan, 's1');
    assert.equal(windowOpened, false);
    assert.equal(result.stepsExecuted, 1);
  });
});

describe('WarExecutor.evaluate', () => {
  const war = new WarExecutor();
  const intent = { primary: { class: 'COGNITIVE_OVERLOAD', confidence: 1 } };

  test('weights outcomes for baseline adaptation', () => {
    const evaluation = war.evaluate({ intent, plan: {}, result: { outcome: Outcome.RESOLVED, stepsExecuted: 1, executionLog: [] } });
    assert.equal(evaluation.outcome, Outcome.RESOLVED);
    assert.equal(evaluation.outcomeWeight, 0.02);
  });

  test('promotes UNRESOLVED to PARTIALLY_RESOLVED when a step partially resolved', () => {
    const result = { outcome: Outcome.UNRESOLVED, stepsExecuted: 2, executionLog: [{ partiallyResolved: true }] };
    const evaluation = war.evaluate({ intent, plan: {}, result });
    assert.equal(evaluation.outcome, Outcome.PARTIALLY_RESOLVED);
    assert.equal(evaluation.outcomeWeight, 0.04);
  });

  test('scales weight by intent confidence', () => {
    const lowConfidence = { primary: { class: 'X', confidence: 0.5 } };
    const evaluation = war.evaluate({ intent: lowConfidence, plan: {}, result: { outcome: Outcome.UNRESOLVED, stepsExecuted: 1, executionLog: [] } });
    assert.equal(evaluation.outcomeWeight, 0.04); // 0.08 * 0.5
  });
});
