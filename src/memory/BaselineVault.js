import pg from 'pg';
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

  async #migrate() {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS subjects (
        subject_id      TEXT        PRIMARY KEY,
        enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        consent_version INTEGER     NOT NULL DEFAULT 1,
        opted_out       BOOLEAN     NOT NULL DEFAULT false,
        metadata        JSONB
      );
      CREATE TABLE IF NOT EXISTS baselines (
        id           BIGSERIAL   PRIMARY KEY,
        subject_id   TEXT        NOT NULL REFERENCES subjects(subject_id),
        dimension    TEXT        NOT NULL,
        mean         NUMERIC     NOT NULL,
        std_dev      NUMERIC     NOT NULL DEFAULT 0.1,
        sample_count INTEGER     NOT NULL DEFAULT 1,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (subject_id, dimension)
      );
      CREATE TABLE IF NOT EXISTS signal_events (
        id          BIGSERIAL   PRIMARY KEY,
        subject_id  TEXT        NOT NULL REFERENCES subjects(subject_id),
        source      TEXT        NOT NULL,
        dimensions  JSONB       NOT NULL,
        deviation   JSONB,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS interventions (
        id             BIGSERIAL   PRIMARY KEY,
        subject_id     TEXT        NOT NULL REFERENCES subjects(subject_id),
        intent_class   TEXT        NOT NULL,
        confidence     NUMERIC     NOT NULL,
        plan           JSONB       NOT NULL,
        result         JSONB,
        outcome        TEXT,
        outcome_weight NUMERIC,
        vetoed         BOOLEAN     NOT NULL DEFAULT false,
        veto_reason    TEXT,
        executed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS consent_records (
        id                      BIGSERIAL   PRIMARY KEY,
        subject_id              TEXT        NOT NULL REFERENCES subjects(subject_id),
        active                  BOOLEAN     NOT NULL DEFAULT true,
        opted_out               BOOLEAN     NOT NULL DEFAULT false,
        max_permitted_intensity INTEGER     NOT NULL DEFAULT 3,
        consented_modalities    TEXT[]      NOT NULL DEFAULT '{}',
        consented_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at              TIMESTAMPTZ,
        revoked_at              TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_baselines_subject     ON baselines       (subject_id);
      CREATE INDEX IF NOT EXISTS idx_signal_events_subject ON signal_events   (subject_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interventions_subject ON interventions    (subject_id, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interventions_class   ON interventions    (intent_class, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_consent_active        ON consent_records  (subject_id, active) WHERE active = true;
    `);
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
        `INSERT INTO consent_records (subject_id, active, consented_modalities, max_permitted_intensity)
         VALUES ($1, false, '{}', 1) ON CONFLICT DO NOTHING`,
        [subjectId]
      );
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  }

  async disconnect() { await this.#pool.end(); }
}
