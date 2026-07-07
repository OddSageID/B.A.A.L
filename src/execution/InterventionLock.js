import crypto from 'node:crypto';

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const keyFor = (subjectId) => `baal:intervention-lock:${subjectId}`;

/**
 * Cross-instance guard: at most one intervention per subject across every
 * B.A.A.L. replica. SET NX with a TTL backstop (a crashed holder self-heals),
 * compare-and-delete release so an expired holder cannot free a successor's
 * lock. Redis unavailable ⇒ acquire fails ⇒ no intervention (fail closed).
 */
export class InterventionLock {
  #client;

  constructor(client) { this.#client = client; }

  /** Returns a release token, or null if another instance holds the lock. */
  async acquire(subjectId, ttlMs = 120000) {
    const token = crypto.randomUUID();
    const result = await this.#client.set(keyFor(subjectId), token, { NX: true, PX: ttlMs });
    return result === 'OK' ? token : null;
  }

  async release(subjectId, token) {
    await this.#client.eval(RELEASE_SCRIPT, { keys: [keyFor(subjectId)], arguments: [token] });
  }
}
