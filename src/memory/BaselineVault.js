import pg from 'pg';
import { MigrationRunner } from './MigrationRunner.js';
const { Pool } = pg;

export class BaselineVault {
  #pool = null;

  static async connect(config = {}) {
    const vault = new BaselineVault();
    vault.#pool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     process.env.PGPORT     ?? 5432,
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
      `SELECT dimension, mean, std_dev, sample_count, last_updated FROM baselines WHERE subject_id = $1`,
      [subjectId]
    );
    if (result.rows.length === 0) return null;
    const dimensions = {};
    for (const row of result.rows) {
      dimensions[row.dimension] = { mean: parseFloat(row.mean), stdDev: parseFloat(row.std_dev), sampleCount: row.sample_count, lastUpdated: row.last_updated };
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

  async updateBaseline(subjectId, signal, weight = 0.05) {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
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
        `INSERT INTO signal_events (subject_id, source, dimensions) VALUES ($1, $2, $3)`,
        [subjectId, signal.source, JSON.stringify(signal.dimensions)]
      );
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async logIntervention({ subjectId, intentClass, confidence, plan, result, evaluation }) {
    await this.#pool.query(
      `INSERT INTO interventions (subject_id, intent_class, confidence, plan, result, outcome, outcome_weight)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [subjectId, intentClass, confidence, JSON.stringify(plan), JSON.stringify(result), evaluation?.outcome, evaluation?.outcomeWeight]
    );
  }

  async logVeto({ subjectId, plan, vetoReason }) {
    await this.#pool.query(
      `INSERT INTO interventions (subject_id, intent_class, confidence, plan, vetoed, veto_reason)
       VALUES ($1,$2,$3,$4,true,$5)`,
      [subjectId, plan.intentClass, plan.confidence, JSON.stringify(plan), vetoReason]
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

  async health() {
    try { await this.#pool.query('SELECT 1'); return { connected: true }; }
    catch (err) { return { connected: false, error: err.message }; }
  }

  async disconnect() { await this.#pool.end(); }
}
