import crypto from 'node:crypto';

/** AMQP header names shared by producers and the consuming daemon. */
export const KEY_HEADER = 'x-baal-key-id';
export const SIG_HEADER = 'x-baal-signature';

/**
 * Producer authentication for the ingestion boundary.
 *
 * Threat model: anyone who can reach RabbitMQ can otherwise fabricate
 * behavioral signals for any subject and trigger real interventions, or
 * exhaust a subject's rate budget. Producers therefore sign the raw message
 * bytes with a shared HMAC key; each key is optionally scoped to the event
 * sources it may emit.
 *
 * Keys come from BAAL_INGEST_KEYS (JSON):
 *   { "wearable-fleet": { "secret": "…", "sources": ["biometric", "eeg"] } }
 *
 * Not defended here: a compromised producer key holder can still sign forged
 * events for its permitted sources — key rotation and producer-side security
 * remain deployment concerns.
 */
export class EventAuth {
  #keys = new Map(); // keyId -> { secret: Buffer, sources: Set<string> | null }

  static fromEnv(env = process.env) {
    const auth = new EventAuth();
    const raw = env.BAAL_INGEST_KEYS;
    if (raw) {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error('BAAL_INGEST_KEYS must be valid JSON'); }
      for (const [keyId, def] of Object.entries(parsed)) {
        if (!def || typeof def.secret !== 'string' || def.secret.length < 16) {
          throw new Error(`Ingest key '${keyId}': secret must be a string of at least 16 characters`);
        }
        auth.#keys.set(keyId, {
          secret: Buffer.from(def.secret, 'utf8'),
          sources: Array.isArray(def.sources) ? new Set(def.sources) : null,
        });
      }
    }
    if (auth.#keys.size === 0 && env.NODE_ENV === 'production') {
      throw new Error('Producer authentication is mandatory in production: set BAAL_INGEST_KEYS');
    }
    return auth;
  }

  static fromKeys(keys) {
    const auth = new EventAuth();
    for (const [keyId, def] of Object.entries(keys)) {
      auth.#keys.set(keyId, {
        secret: Buffer.from(def.secret, 'utf8'),
        sources: Array.isArray(def.sources) ? new Set(def.sources) : null,
      });
    }
    return auth;
  }

  /** True when at least one key is configured — verification is enforced. */
  get enforced() { return this.#keys.size > 0; }

  sign(buffer, keyId) {
    const key = this.#keys.get(keyId);
    if (!key) throw new Error(`Unknown ingest key: ${keyId}`);
    return crypto.createHmac('sha256', key.secret).update(buffer).digest('hex');
  }

  /**
   * Verifies raw message bytes against the signature headers.
   * Fail closed: any missing/unknown/invalid element rejects.
   */
  verify(buffer, { keyId, signature } = {}, source) {
    if (!this.enforced) return { ok: true, mode: 'open' };
    if (typeof keyId !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'missing_signature' };
    const key = this.#keys.get(keyId);
    if (!key) return { ok: false, reason: 'unknown_key' };
    const expected = crypto.createHmac('sha256', key.secret).update(buffer).digest();
    let provided;
    try { provided = Buffer.from(signature, 'hex'); }
    catch { return { ok: false, reason: 'malformed_signature' }; }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return { ok: false, reason: 'signature_mismatch' };
    }
    if (key.sources && !key.sources.has(source)) return { ok: false, reason: 'source_not_authorized' };
    return { ok: true, keyId };
  }
}
