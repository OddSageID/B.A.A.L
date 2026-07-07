import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { InterventionLock } from '../../src/execution/InterventionLock.js';

function fakeRedis() {
  const store = new Map();
  return {
    store,
    async set(key, value, opts) {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(script, { keys, arguments: args }) {
      // Mirrors the compare-and-delete script.
      if (store.get(keys[0]) === args[0]) { store.delete(keys[0]); return 1; }
      return 0;
    },
  };
}

describe('InterventionLock', () => {
  test('acquire returns a token; second acquire is refused', async () => {
    const lock = new InterventionLock(fakeRedis());
    const token = await lock.acquire('s1');
    assert.ok(token);
    assert.equal(await lock.acquire('s1'), null);
  });

  test('release frees the lock for the next acquirer', async () => {
    const redis = fakeRedis();
    const lock = new InterventionLock(redis);
    const token = await lock.acquire('s1');
    await lock.release('s1', token);
    assert.ok(await lock.acquire('s1'));
  });

  test('release with a stale token does not free a successor lock', async () => {
    const redis = fakeRedis();
    const lock = new InterventionLock(redis);
    const stale = await lock.acquire('s1');
    await lock.release('s1', stale);
    const current = await lock.acquire('s1');
    await lock.release('s1', stale); // expired holder retries its release
    assert.equal(await lock.acquire('s1'), null, 'current holder must still own the lock');
    await lock.release('s1', current);
  });

  test('locks are per subject', async () => {
    const lock = new InterventionLock(fakeRedis());
    assert.ok(await lock.acquire('s1'));
    assert.ok(await lock.acquire('s2'));
  });
});
