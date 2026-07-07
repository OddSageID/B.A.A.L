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
    assert.match(sqls[2], /INSERT INTO baselines/);
    assert.match(sqls[3], /INSERT INTO signal_events/);
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
});
