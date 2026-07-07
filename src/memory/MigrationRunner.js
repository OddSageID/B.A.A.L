import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

export class MigrationRunner {
  static async run(pool, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1', [filename]);
      if (exists.rowCount > 0) continue;
      const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  }
}
