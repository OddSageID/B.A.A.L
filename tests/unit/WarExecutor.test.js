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

describe('WarExecutor.execute — abort paths', () => {
  test('a pre-aborted signal executes nothing', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(true));
    const controller = new AbortController();
    controller.abort('operator_abort');
    const result = await war.execute(planOf([step(1, Modality.HAPTIC, Intensity.WHISPER)]), 's1', { abortSignal: controller.signal });
    assert.equal(result.outcome, Outcome.ABORTED);
    assert.equal(result.stepsExecuted, 0);
    assert.equal(result.abortReason, 'operator_abort');
  });

  test('abort during a resolution window stops the ladder', async () => {
    const war = new WarExecutor();
    war.setMonitor({ waitForResolution: () => new Promise(r => setTimeout(() => r({ resolved: false, partiallyResolved: false, signal: null, timedOut: true }), 200)) });
    const controller = new AbortController();
    const running = war.execute(planOf([
      step(1, Modality.HAPTIC, Intensity.WHISPER),
      step(2, Modality.AUDITORY, Intensity.NUDGE, 'if_step_1_unresolved'),
    ]), 's1', { abortSignal: controller.signal });
    setTimeout(() => controller.abort('kill_switch'), 20);
    const result = await running;
    assert.equal(result.outcome, Outcome.ABORTED);
    assert.equal(result.stepsExecuted, 1, 'step 2 must never fire after abort');
  });

  test('consent revoked mid-ladder aborts before the next stimulating step', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(false));
    let calls = 0;
    const consentCheck = async () => { calls += 1; return calls === 1; }; // consented for step 1 only
    const result = await war.execute(planOf([
      step(1, Modality.HAPTIC, Intensity.WHISPER),
      step(2, Modality.AUDITORY, Intensity.NUDGE, 'if_step_1_unresolved'),
    ]), 's1', { consentCheck });
    assert.equal(result.outcome, Outcome.ABORTED);
    assert.equal(result.abortReason, 'consent_revoked_mid_ladder');
    assert.equal(result.stepsExecuted, 1);
  });

  test('a consent check error fails closed (aborts)', async () => {
    const war = new WarExecutor();
    war.setMonitor(monitorResolving(false));
    const result = await war.execute(planOf([step(1, Modality.HAPTIC, Intensity.WHISPER)]), 's1', {
      consentCheck: async () => { throw new Error('pg down'); },
    });
    assert.equal(result.outcome, Outcome.ABORTED);
    assert.equal(result.stepsExecuted, 0);
  });

  test('ABORTED evaluates with zero baseline weight', () => {
    const war = new WarExecutor();
    const evaluation = war.evaluate({
      intent: { primary: { class: 'X', confidence: 1 } },
      plan: {},
      result: { outcome: Outcome.ABORTED, stepsExecuted: 1, executionLog: [] },
    });
    assert.equal(evaluation.outcome, Outcome.ABORTED);
    assert.equal(evaluation.outcomeWeight, 0);
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
