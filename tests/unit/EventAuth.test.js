import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventAuth } from '../../src/transport/EventAuth.js';

const KEYS = {
  'wearable-1': { secret: 'a-sufficiently-long-secret', sources: ['biometric', 'eeg'] },
  'kiosk-1':    { secret: 'another-long-shared-secret' },
};

describe('EventAuth', () => {
  test('open mode when no keys configured (non-production)', () => {
    const auth = EventAuth.fromEnv({});
    assert.equal(auth.enforced, false);
    assert.deepEqual(auth.verify(Buffer.from('x'), {}, 'behavioral'), { ok: true, mode: 'open' });
  });

  test('production without keys refuses to start', () => {
    assert.throws(() => EventAuth.fromEnv({ NODE_ENV: 'production' }), /mandatory in production/);
  });

  test('rejects malformed key config and short secrets', () => {
    assert.throws(() => EventAuth.fromEnv({ BAAL_INGEST_KEYS: 'not json' }), /valid JSON/);
    assert.throws(() => EventAuth.fromEnv({ BAAL_INGEST_KEYS: JSON.stringify({ k: { secret: 'short' } }) }), /at least 16/);
  });

  test('sign/verify roundtrip', () => {
    const auth = EventAuth.fromKeys(KEYS);
    const body = Buffer.from(JSON.stringify({ eventId: 'e1' }));
    const signature = auth.sign(body, 'wearable-1');
    const verdict = auth.verify(body, { keyId: 'wearable-1', signature }, 'biometric');
    assert.equal(verdict.ok, true);
  });

  test('rejects tampered payloads', () => {
    const auth = EventAuth.fromKeys(KEYS);
    const signature = auth.sign(Buffer.from('original'), 'kiosk-1');
    const verdict = auth.verify(Buffer.from('tampered'), { keyId: 'kiosk-1', signature }, 'behavioral');
    assert.deepEqual(verdict, { ok: false, reason: 'signature_mismatch' });
  });

  test('rejects unknown keys, missing signatures, and wrong key signatures', () => {
    const auth = EventAuth.fromKeys(KEYS);
    const body = Buffer.from('x');
    assert.equal(auth.verify(body, { keyId: 'nope', signature: 'aa' }, 'eeg').reason, 'unknown_key');
    assert.equal(auth.verify(body, {}, 'eeg').reason, 'missing_signature');
    const crossSigned = auth.sign(body, 'kiosk-1');
    assert.equal(auth.verify(body, { keyId: 'wearable-1', signature: crossSigned }, 'eeg').reason, 'signature_mismatch');
  });

  test('enforces per-key source scoping', () => {
    const auth = EventAuth.fromKeys(KEYS);
    const body = Buffer.from('x');
    const signature = auth.sign(body, 'wearable-1');
    assert.equal(auth.verify(body, { keyId: 'wearable-1', signature }, 'behavioral').reason, 'source_not_authorized');
    assert.equal(auth.verify(body, { keyId: 'wearable-1', signature }, 'eeg').ok, true);
    // Unscoped key may emit any source.
    const kioskSig = auth.sign(body, 'kiosk-1');
    assert.equal(auth.verify(body, { keyId: 'kiosk-1', signature: kioskSig }, 'interaction').ok, true);
  });
});
