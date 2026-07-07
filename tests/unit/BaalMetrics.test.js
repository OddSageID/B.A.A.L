import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaalMetrics } from '../../src/observability/BaalMetrics.js';

describe('BaalMetrics', () => {
  test('counts interventions, vetoes, and resolutions', () => {
    const metrics = new BaalMetrics();
    metrics.markIntervention('PANIC_ONSET');
    metrics.markIntervention('PANIC_ONSET');
    metrics.markIntervention();
    metrics.markVeto('CONSENT_NOT_ESTABLISHED');
    metrics.markResolution('RESOLVED');
    metrics.markResolution('PARTIALLY_RESOLVED');
    metrics.markResolution('UNRESOLVED');
    const snap = metrics.snapshot();
    assert.equal(snap.interventionsByIntent.PANIC_ONSET, 2);
    assert.equal(snap.interventionsByIntent.UNKNOWN, 1);
    assert.equal(snap.vetoByReason.CONSENT_NOT_ESTABLISHED, 1);
    assert.deepEqual(snap.resolution, { resolved: 2, unresolved: 1 });
  });

  test('snapshot is a copy, not a live view', () => {
    const metrics = new BaalMetrics();
    const snap = metrics.snapshot();
    snap.resolution.resolved = 999;
    assert.equal(metrics.snapshot().resolution.resolved, 0);
  });
});
