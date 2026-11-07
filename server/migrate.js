import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(currentDirectory, '../../db/migrations');
const lockName = 'khanyonis-medical-hub-migrations-v1';

export async function migrateDatabase(pool) {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [lockRows] = await connection.query('SELECT pg_try_advisory_lock(hashtext(?)) AS acquired', [lockName]);
    locked = Boolean(lockRows[0]?.acquired);
    if (!locked) throw new Error('Could not acquire the database migration lock');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();

    for (const filename of files) {
      const [rows] = await connection.execute(
        'SELECT version FROM schema_migrations WHERE version = ?',
        [filename],
      );
      if (rows.length > 0) continue;

      const source = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      const statements = source.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
      await connection.beginTransaction();
      try {
        for (const statement of statements) await connection.query(statement);
        await connection.execute(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, (CURRENT_TIMESTAMP AT TIME ZONE \'UTC\'))',
          [filename],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    if (locked) {
      try { await connection.query('SELECT pg_advisory_unlock(hashtext(?)) AS released', [lockName]); } catch {}
    }
    connection.release();
  }
}
