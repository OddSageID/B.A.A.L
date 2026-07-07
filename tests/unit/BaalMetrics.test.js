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

  test('Prometheus exposition renders counters with escaped labels', () => {
    const metrics = new BaalMetrics();
    metrics.markIntervention('PANIC_ONSET');
    metrics.markVeto('bad"reason\\with\nnasty chars');
    metrics.markResolution('RESOLVED');
    metrics.markAbort();
    const text = metrics.toPrometheus();
    assert.match(text, /# TYPE baal_interventions_total counter/);
    assert.match(text, /baal_interventions_total\{intent_class="PANIC_ONSET"\} 1/);
    assert.match(text, /baal_vetoes_total\{reason="bad\\"reason\\\\with\\nnasty chars"\} 1/);
    assert.match(text, /baal_resolutions_total\{outcome="resolved"\} 1/);
    assert.match(text, /baal_aborts_total 1/);
    assert.ok(text.endsWith('\n'));
  });
});
