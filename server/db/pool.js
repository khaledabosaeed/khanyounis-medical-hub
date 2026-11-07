import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the managed database');
}

function splitTopLevelArgs(text) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

function replaceFunction(sql, name, replacer) {
  let output = sql;
  let cursor = 0;
  while (true) {
    const match = new RegExp(`\\b${name}\\s*\\(`, 'ig').exec(output.slice(cursor));
    if (!match) break;
    const start = cursor + match.index;
    const open = start + match[0].length - 1;
    let depth = 1;
    let index = open + 1;
    let quote = null;
    for (; index < output.length && depth > 0; index += 1) {
      const char = output[index];
      if (quote) {
        if (char === quote && output[index - 1] !== '\\') quote = null;
      } else if (char === "'" || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
    }
    if (depth !== 0) break;
    const args = splitTopLevelArgs(output.slice(open + 1, index - 1));
    const replacement = replacer(args);
    output = `${output.slice(0, start)}${replacement}${output.slice(index)}`;
    cursor = start + replacement.length;
  }
  return output;
}

function toPostgres(sql, params) {
  let text = String(sql)
    .replace(/SELECT\s+GET_LOCK\(\s*\?\s*,\s*20\s*\)\s+AS\s+acquired/ig, 'SELECT pg_try_advisory_lock(hashtext(?)) AS acquired')
    .replace(/SELECT\s+RELEASE_LOCK\(\s*\?\s*\)/ig, 'SELECT pg_advisory_unlock(hashtext(?)) AS released')
    .replace(/DATE_SUB\(\s*UTC_TIMESTAMP\(\s*3\s*\)\s*,\s*INTERVAL\s+1\s+DAY\s*\)/ig, "((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 day')")
    .replace(/DATE_ADD\(\s*UTC_TIMESTAMP\(\s*3\s*\)\s*,\s*INTERVAL\s+\?\s+SECOND\s*\)/ig, "((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + (? * INTERVAL '1 second'))")
    .replace(/DATE_ADD\(\s*UTC_TIMESTAMP\(\s*3\s*\)\s*,\s*INTERVAL\s+8\s+HOUR\s*\)/ig, "((CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '8 hours')")
    .replace(/UTC_TIMESTAMP\(\s*3\s*\)/ig, "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
    .replace(/INSERT\s+IGNORE\s+INTO/ig, 'INSERT INTO');

  text = replaceFunction(text, 'TIMESTAMPDIFF', (args) => {
    if (args.length !== 3 || args[0].toUpperCase() !== 'SECOND') return `TIMESTAMPDIFF(${args.join(', ')})`;
    return `FLOOR(EXTRACT(EPOCH FROM (${args[2]} - ${args[1]})))`;
  });
  text = replaceFunction(text, 'DATE_FORMAT', (args) => {
    if (args.length !== 2) return `DATE_FORMAT(${args.join(', ')})`;
    return `to_char(${args[0]} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  });

  text = text.replace(/SUM\(\s*([\w.]+)\s*=\s*'([^']+)'\s*\)/g, "SUM(CASE WHEN $1 = '$2' THEN 1 ELSE 0 END)");
  text = text.replace(/SUM\(\s*([\w.]+)\s*=\s*'([^']+)'\s+AND\s+\(([^()]*)\)\s*\)/g,
    "SUM(CASE WHEN $1 = '$2' AND ($3) THEN 1 ELSE 0 END)");
  text = text.replace(/AS\s+([A-Za-z_][A-Za-z0-9_]*)/g, (_match, alias) => {
    // IDENTITY is PostgreSQL DDL syntax, not a MySQL-style camelCase alias.
    // Quoting it turns `GENERATED ... AS IDENTITY` into invalid SQL.
    if (alias.toUpperCase() === 'IDENTITY') return 'AS IDENTITY';
    return /[A-Z]/.test(alias) ? `AS "${alias}"` : `AS ${alias}`;
  });

  let parameterIndex = 0;
  text = text.replace(/\?/g, () => `$${++parameterIndex}`);
  return { text, params };
}

function adaptError(error) {
  if (error?.code === '23505') error.code = 'ER_DUP_ENTRY';
  if (error?.code === '23503') error.code = 'ER_NO_REFERENCED_ROW_2';
  return error;
}

class PostgresConnection {
  constructor(client) {
    this.client = client;
  }

  async query(sql, params = []) {
    return runQuery(this.client, sql, params);
  }

  async execute(sql, params = []) {
    return runQuery(this.client, sql, params);
  }

  async beginTransaction() {
    await this.client.query('BEGIN');
  }

  async commit() {
    await this.client.query('COMMIT');
  }

  async rollback() {
    await this.client.query('ROLLBACK');
  }

  release() {
    this.client.release();
  }
}

async function runQuery(client, sql, params = []) {
  const converted = toPostgres(sql, params);
  let text = converted.text.trim();
  const insertTable = text.match(/^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i)?.[1]?.toLowerCase();
  if (insertTable && ['students', 'study_sessions', 'messages', 'admins', 'admin_study_counter_archive', 'admin_login_attempts'].includes(insertTable) && !/\bRETURNING\b/i.test(text)) {
    text = `${text.replace(/;\s*$/, '')} RETURNING id`;
  }
  try {
    const result = await client.query({ text, values: converted.params });
    const metadata = {
      affectedRows: result.rowCount,
      insertId: result.rows[0]?.id == null ? undefined : result.rows[0].id,
      rowCount: result.rowCount,
    };
    return [result.rows, metadata];
  } catch (error) {
    throw adaptError(error);
  }
}

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

export const pool = {
  query: (sql, params = []) => runQuery(pgPool, sql, params),
  execute: (sql, params = []) => runQuery(pgPool, sql, params),
  getConnection: async () => new PostgresConnection(await pgPool.connect()),
  end: () => pgPool.end(),
};

export async function pingDatabase() {
  await pool.query('SELECT 1');
}
