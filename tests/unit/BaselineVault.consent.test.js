import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaselineVault } from '../../src/memory/BaselineVault.js';

function makeClient() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    release: () => { calls.push({ sql: '<release>' }); },
  };
}

function makePool(client = makeClient()) {
  const calls = [];
  return {
    calls, client,
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    connect: async () => client,
  };
}

const sqlCalls = (calls) => calls.map(c => c.sql).filter(s => s !== '<release>');

describe('BaselineVault consent lifecycle', () => {
  test('getConsentRecord returns null when no record exists', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    assert.equal(await vault.getConsentRecord('s1'), null);
    assert.match(pool.calls[0].sql, /FROM consent_records/);
    assert.deepEqual(pool.calls[0].params, ['s1']);
  });

  test('getConsentRecord maps row fields', async () => {
    const pool = makePool();
    pool.query = async () => ({ rows: [{ active: true, opted_out: false, max_permitted_intensity: 3, consented_modalities: ['haptic'], consented_at: 't0', expires_at: null }] });
    const vault = BaselineVault.fromPool(pool);
    const rec = await vault.getConsentRecord('s1');
    assert.deepEqual(rec, {
      subjectId: 's1', active: true, optedOut: false, maxPermittedIntensity: 3,
      consentedModalities: ['haptic'], consentedAt: 't0', expiresAt: null,
    });
  });

  test('activateConsent runs in a transaction and deactivates prior consent', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.activateConsent('s1', ['haptic', 'auditory'], 3);
    const sqls = sqlCalls(pool.client.calls);
    assert.equal(sqls[0], 'BEGIN');
    assert.match(sqls[1], /INSERT INTO subjects/);
    assert.match(sqls[2], /UPDATE consent_records SET active = false/);
    assert.match(sqls[3], /INSERT INTO consent_records/);
    assert.equal(sqls[4], 'COMMIT');
  });

  test('activateConsent rolls back on failure', async () => {
    const pool = makePool();
    const original = pool.client.query.bind(pool.client);
    pool.client.query = async (sql, params) => {
      if (/INSERT INTO consent_records/.test(sql)) throw new Error('boom');
      return original(sql, params);
    };
    const vault = BaselineVault.fromPool(pool);
    await assert.rejects(() => vault.activateConsent('s1', ['haptic'], 2), /boom/);
    assert.ok(sqlCalls(pool.client.calls).includes('ROLLBACK'));
  });

  test('revokeConsent deactivates and stamps revoked_at', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.revokeConsent('s1');
    assert.match(pool.calls[0].sql, /SET active = false, opted_out = true, revoked_at = now\(\)/);
    assert.deepEqual(pool.calls[0].params, ['s1']);
  });
});

describe('BaselineVault.updateBaseline', () => {
  test('auto-enrolls the subject before writing (regression: first event FK crash)', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.updateBaseline('new-subject', { source: 'behavioral', dimensions: { cognitive_load: 0.5 } }, 0.05);
    const sqls = sqlCalls(pool.client.calls);
    assert.equal(sqls[0], 'BEGIN');
    assert.match(sqls[1], /INSERT INTO subjects .*ON CONFLICT \(subject_id\) DO NOTHING/);
    // signal_events precedes baselines: the eventId conflict check must run
    // before any baseline mutation so duplicates commit nothing.
    assert.match(sqls[2], /INSERT INTO signal_events/);
    assert.match(sqls[3], /INSERT INTO baselines/);
    assert.equal(sqls.at(-1), 'COMMIT');
  });

  test('skips null dimensions', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.updateBaseline('s1', { source: 'eeg', dimensions: { cognitive_load: null, arousal_level: 0.4 } });
    const baselineWrites = pool.client.calls.filter(c => /INSERT INTO baselines/.test(c.sql));
    assert.equal(baselineWrites.length, 1);
    assert.equal(baselineWrites[0].params[1], 'arousal_level');
  });

  test('duplicate eventId rolls back and reports duplicate (idempotency)', async () => {
    const pool = makePool();
    const original = pool.client.query.bind(pool.client);
    pool.client.query = async (sql, params) => {
      const result = await original(sql, params);
      if (/INSERT INTO signal_events/.test(sql)) return { ...result, rowCount: 0 }; // conflict: already seen
      return result;
    };
    const vault = BaselineVault.fromPool(pool);
    const outcome = await vault.updateBaseline('s1', { source: 'eeg', dimensions: { arousal_level: 0.4 } }, 0.05, { eventId: 'evt-dup' });
    assert.deepEqual(outcome, { duplicate: true });
    const sqls = sqlCalls(pool.client.calls);
    assert.ok(sqls.includes('ROLLBACK'));
    assert.equal(sqls.filter(s => /INSERT INTO baselines/.test(s)).length, 0, 'no baseline mutation on duplicate');
  });
});

describe('BaselineVault durable rate limits and lifecycle', () => {
  test('countRecentInterventions parses window counts', async () => {
    const pool = makePool();
    pool.query = async (sql, params) => {
      assert.match(sql, /vetoed = false AND holdout = false/);
      assert.deepEqual(params, ['s1']);
      return { rows: [{ last_hour: '3', last_day: '11' }] };
    };
    const vault = BaselineVault.fromPool(pool);
    assert.deepEqual(await vault.countRecentInterventions('s1'), { lastHour: 3, lastDay: 11 });
  });

  test('eraseSubject removes every table row in one transaction', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.eraseSubject('s1');
    const sqls = sqlCalls(pool.client.calls);
    assert.equal(sqls[0], 'BEGIN');
    for (const table of ['signal_events', 'baselines', 'interventions', 'consent_records', 'escalations', 'subjects']) {
      assert.ok(sqls.some(s => new RegExp(`DELETE FROM ${table}`).test(s)), `must delete from ${table}`);
    }
    assert.equal(sqls.at(-1), 'COMMIT');
  });

  test('escalation lifecycle: record, ack, alerted', async () => {
    const pool = makePool();
    const vault = BaselineVault.fromPool(pool);
    await vault.recordEscalation({ escalationId: 'esc-1', subjectId: 's1', reason: 'X', ackDeadline: new Date() });
    assert.match(pool.calls[0].sql, /INSERT INTO escalations/);
    pool.query = async () => ({ rowCount: 1 });
    assert.equal(await vault.ackEscalation('esc-1', 'op'), true);
    pool.query = async () => ({ rowCount: 0 });
    assert.equal(await vault.ackEscalation('esc-1', 'op'), false, 'double-ack must report false');
  });

  test('pruneExpiredData deletes by retention windows', async () => {
    const pool = makePool();
    const deletes = [];
    pool.query = async (sql, params) => { deletes.push({ sql, params }); return { rowCount: 2 }; };
    const vault = BaselineVault.fromPool(pool);
    const pruned = await vault.pruneExpiredData({ signalRetentionDays: 7 });
    assert.match(deletes[0].sql, /DELETE FROM signal_events/);
    assert.deepEqual(deletes[0].params, [7]);
    assert.deepEqual(pruned, { signalEvents: 2, escalations: 2 });
  });
});
