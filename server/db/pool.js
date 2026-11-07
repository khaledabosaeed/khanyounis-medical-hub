import mysql from 'mysql2/promise';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the managed database');
}

// Pass the managed URI directly so mysql2 preserves its TLS settings.
export const pool = mysql.createPool(process.env.DATABASE_URL);

export async function pingDatabase() {
  await pool.query('SELECT 1');
}
