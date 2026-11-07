import { pool } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';

try {
  await migrateDatabase(pool);
  console.log('Database migrations are up to date.');
} finally {
  await pool.end();
}
