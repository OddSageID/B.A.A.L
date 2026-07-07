import pg from 'pg';
import { MigrationRunner } from './MigrationRunner.js';
const { Pool } = pg;

export class BaselineVault {
  #pool = null;

  static async connect(config = {}) {
    const vault = new BaselineVault();
    vault.#pool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'baal',
      user:     process.env.PGUSER     ?? 'baal',
      password: process.env.PGPASSWORD,
      max: 20, ...config,
    });
    await vault.#migrate();
    return vault;
  }

  static fromPool(pool) {
    const vault = new BaselineVault();
    vault.#pool = pool;
    return vault;
  }

  async #migrate() {
    await MigrationRunner.run(this.#pool);
  }

  async getBaseline(subjectId) {
    const result = await this.#pool.query(
      `SELECT dimension, mean, std_dev, sample_count, reference_mean, last_updated
       FROM baselines WHERE subject_id = $1`,
      [subjectId]
    );
    if (result.rows.length === 0) return null;
    const dimensions = {};
    for (const row of result.rows) {
      dimensions[row.dimension] = {
        mean: parseFloat(row.mean),
        stdDev: parseFloat(row.std_dev),
        sampleCount: row.sample_count,
        referenceMean: row.reference_mean == null ? null : parseFloat(row.reference_mean),
        lastUpdated: row.last_updated,
      };
    }
    return { subjectId, dimensions };
  }

  async getConsentRecord(subjectId) {
    const result = await this.#pool.query(
      `SELECT active, opted_out, max_permitted_intensity, consented_modalities, consented_at, expires_at
       FROM consent_records
       WHERE subject_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [subjectId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      subjectId,
      active: row.active,
      optedOut: row.opted_out,
      maxPermittedIntensity: row.max_permitted_intensity,
      consentedModalities: row.consented_modalities ?? [],
      consentedAt: row.consented_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Idempotent when eventId is provided: a duplicate event commits nothing
   * and returns { duplicate: true }. Pins a reference mean per dimension once
   * sample_count reaches pinAfterSamples (baseline-poisoning defense).
   */
  async updateBaseline(subjectId, signal, weight = 0.05, { eventId = null, pinAfterSamples = 30 } = {}) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // A subject's first signal must not violate the FK — enroll on sight.
      // Enrollment creates the subject row only; consent stays absent (fail closed).
      await client.query(
        `INSERT INTO subjects (subject_id) VALUES ($1) ON CONFLICT (subject_id) DO NOTHING`,
        [subjectId]
      );
      // The WHERE predicate must match the partial unique index exactly, or
      // Postgres rejects the ON CONFLICT target (42P10). Caught by the live suite.
      const eventInsert = await client.query(
        `INSERT INTO signal_events (subject_id, source, dimensions, event_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
        [subjectId, signal.source, JSON.stringify(signal.dimensions), eventId]
      );
      if (eventId != null && eventInsert.rowCount === 0) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }
      for (const [dim, value] of Object.entries(signal.dimensions)) {
        if (value == null) continue;
        await client.query(
          `INSERT INTO baselines (subject_id, dimension, mean, std_dev, sample_count)
           VALUES ($1, $2, $3, 0.1, 1)
           ON CONFLICT (subject_id, dimension) DO UPDATE SET
             mean         = baselines.mean * (1 - $4) + $3 * $4,
             std_dev      = GREATEST(SQRT(baselines.std_dev^2 * (1 - $4) + ($3 - baselines.mean)^2 * $4), 0.01),
             sample_count = baselines.sample_count + 1,
             last_updated = now()`,
          [subjectId, dim, value, weight]
        );
      }
      await client.query(
        `UPDATE baselines SET reference_mean = mean, reference_pinned_at = now()
         WHERE subject_id = $1 AND reference_mean IS NULL AND sample_count >= $2`,
        [subjectId, pinAfterSamples]
      );
      await client.query('COMMIT');
      return { duplicate: false };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  /** Durable rate-limit source: real (non-veto, non-holdout) interventions. */
  async countRecentInterventions(subjectId) {
    const result = await this.#pool.query(
      `SELECT
         count(*) FILTER (WHERE executed_at > now() - interval '1 hour') AS last_hour,
         count(*)                                                        AS last_day
       FROM interventions
       WHERE subject_id = $1
         AND executed_at > now() - interval '24 hours'
         AND vetoed = false AND holdout = false`,
      [subjectId]
    );
    const row = result.rows[0] ?? {};
    return { lastHour: parseInt(row.last_hour ?? '0', 10), lastDay: parseInt(row.last_day ?? '0', 10) };
  }

  async logIntervention({ subjectId, intentClass, confidence, plan, result, evaluation, holdout = false, rulesetVersion = null, strategyVersion = null }) {
    await this.#ensureSubject(subjectId);
    await this.#pool.query(
      `INSERT INTO interventions (subject_id, intent_class, confidence, plan, result, outcome, outcome_weight, holdout, ruleset_version, strategy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [subjectId, intentClass, confidence, JSON.stringify(plan), JSON.stringify(result), evaluation?.outcome, evaluation?.outcomeWeight, holdout, rulesetVersion, strategyVersion]
    );
  }

  async logVeto({ subjectId, plan, vetoReason, rulesetVersion = null, strategyVersion = null }) {
    await this.#ensureSubject(subjectId);
    await this.#pool.query(
      `INSERT INTO interventions (subject_id, intent_class, confidence, plan, vetoed, veto_reason, ruleset_version, strategy_version)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7)`,
      [subjectId, plan.intentClass ?? 'UNKNOWN', plan.confidence ?? 0, JSON.stringify(plan), vetoReason, rulesetVersion, strategyVersion]
    );
  }

  async #ensureSubject(subjectId) {
    await this.#pool.query(
      `INSERT INTO subjects (subject_id) VALUES ($1) ON CONFLICT (subject_id) DO NOTHING`,
      [subjectId]
    );
  }

  async enrollSubject(subjectId, metadata = {}) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO subjects (subject_id, metadata) VALUES ($1,$2) ON CONFLICT (subject_id) DO NOTHING`,
        [subjectId, JSON.stringify(metadata)]
      );
      await client.query(
        `INSERT INTO consent_records (subject_id, active, opted_out, consented_modalities, max_permitted_intensity, consented_at)
         VALUES ($1, false, false, '{}', 1, now())`,
        [subjectId]
      );
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async activateConsent(subjectId, modalities = [], maxIntensity = 3) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO subjects (subject_id) VALUES ($1) ON CONFLICT (subject_id) DO NOTHING`,
        [subjectId]
      );
      await client.query(
        `UPDATE consent_records SET active = false WHERE subject_id = $1 AND active = true`,
        [subjectId]
      );
      await client.query(
        `INSERT INTO consent_records (subject_id, active, opted_out, max_permitted_intensity, consented_modalities, consented_at, revoked_at)
         VALUES ($1, true, false, $3, $2::text[], now(), null)`,
        [subjectId, modalities, maxIntensity]
      );
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async revokeConsent(subjectId) {
    await this.#pool.query(
      `UPDATE consent_records
       SET active = false, opted_out = true, revoked_at = now()
       WHERE subject_id = $1 AND active = true`,
      [subjectId]
    );
  }

  // ── Escalation tracking (human oversight) ────────────────────────────────

  async recordEscalation({ escalationId, subjectId, reason, intentClass, payload, ackDeadline }) {
    await this.#pool.query(
      `INSERT INTO escalations (id, subject_id, reason, intent_class, payload, ack_deadline)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [escalationId, subjectId, reason, intentClass ?? null, JSON.stringify(payload ?? {}), ackDeadline]
    );
  }

  async ackEscalation(escalationId, ackedBy) {
    const result = await this.#pool.query(
      `UPDATE escalations SET acked_at = now(), acked_by = $2
       WHERE id = $1 AND acked_at IS NULL`,
      [escalationId, ackedBy]
    );
    return result.rowCount > 0;
  }

  async pendingEscalations() {
    const result = await this.#pool.query(
      `SELECT id, subject_id, reason, intent_class, created_at, ack_deadline
       FROM escalations WHERE acked_at IS NULL
       ORDER BY ack_deadline ASC LIMIT 100`
    );
    return result.rows;
  }

  async overdueEscalations() {
    const result = await this.#pool.query(
      `SELECT id, subject_id, reason, intent_class, created_at, ack_deadline
       FROM escalations
       WHERE acked_at IS NULL AND ack_deadline < now() AND overdue_alerted_at IS NULL
       ORDER BY ack_deadline ASC LIMIT 100`
    );
    return result.rows;
  }

  async markEscalationAlerted(escalationId) {
    await this.#pool.query(
      `UPDATE escalations SET overdue_alerted_at = now() WHERE id = $1`,
      [escalationId]
    );
  }

  // ── Data lifecycle ───────────────────────────────────────────────────────

  /** Retention sweep. Returns rows deleted per table. */
  async pruneExpiredData({ signalRetentionDays = 30, escalationRetentionDays = 90 } = {}) {
    const signals = await this.#pool.query(
      `DELETE FROM signal_events WHERE recorded_at < now() - make_interval(days => $1)`,
      [signalRetentionDays]
    );
    const escalations = await this.#pool.query(
      `DELETE FROM escalations WHERE acked_at IS NOT NULL AND acked_at < now() - make_interval(days => $1)`,
      [escalationRetentionDays]
    );
    return { signalEvents: signals.rowCount, escalations: escalations.rowCount };
  }

  /** Right-to-erasure: removes every trace of a subject, audit rows included. */
  async eraseSubject(subjectId) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM signal_events   WHERE subject_id = $1`, [subjectId]);
      await client.query(`DELETE FROM baselines       WHERE subject_id = $1`, [subjectId]);
      await client.query(`DELETE FROM interventions   WHERE subject_id = $1`, [subjectId]);
      await client.query(`DELETE FROM consent_records WHERE subject_id = $1`, [subjectId]);
      await client.query(`DELETE FROM escalations     WHERE subject_id = $1`, [subjectId]);
      await client.query(`DELETE FROM subjects        WHERE subject_id = $1`, [subjectId]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async health() {
    try { await this.#pool.query('SELECT 1'); return { connected: true }; }
    catch (err) { return { connected: false, error: err.message }; }
  }

  async disconnect() { await this.#pool.end(); }
}
