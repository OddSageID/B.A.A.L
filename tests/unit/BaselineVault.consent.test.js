import { describe, test, expect, jest } from '@jest/globals';
import { BaselineVault } from '../../src/memory/BaselineVault.js';

function makePool() {
  return {
    query: jest.fn(),
    connect: jest.fn(async () => ({
      query: jest.fn(),
      release: jest.fn(),
    })),
  };
}

describe('BaselineVault consent transitions', () => {
  test('returns null when no consent record exists', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rows: [] });
    const vault = BaselineVault.fromPool(pool);
    const rec = await vault.getConsentRecord('s1');
    expect(rec).toBeNull();
  });

  test('activateConsent writes active consent row', async () => {
    const pool = makePool();
    const client = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValue(client);
    const vault = BaselineVault.fromPool(pool);
    await vault.activateConsent('s1', ['haptic', 'auditory'], 3);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE consent_records'), ['s1']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO consent_records'), ['s1', ['haptic', 'auditory'], 3]);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  test('revokeConsent deactivates active rows and stamps revoked_at', async () => {
    const pool = makePool();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });
    const vault = BaselineVault.fromPool(pool);
    await vault.revokeConsent('s1');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE consent_records'), ['s1']);
  });
});
