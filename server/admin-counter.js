import { inTransaction } from './db/transaction.js';
import { toIsoUtc } from './time.js';

export async function getStudyCounterOverview(pool) {
  const [[row]] = await pool.query(`
    SELECT
      COALESCE(SUM(session.status = 'active'), 0) AS activeCount,
      COALESCE(SUM(session.status = 'completed'
        AND (counter.reset_at IS NULL OR session.ended_at >= counter.reset_at)), 0) AS completedCount,
      COALESCE(SUM(CASE
        WHEN session.id IS NULL THEN 0
        WHEN counter.reset_at IS NULL AND session.status = 'completed' THEN session.duration_seconds
        WHEN counter.reset_at IS NULL THEN GREATEST(0, TIMESTAMPDIFF(SECOND, session.started_at, UTC_TIMESTAMP(3)))
        ELSE GREATEST(0, TIMESTAMPDIFF(SECOND,
          GREATEST(session.started_at, counter.reset_at),
          LEAST(COALESCE(session.ended_at, UTC_TIMESTAMP(3)), UTC_TIMESTAMP(3))))
      END), 0) AS totalSeconds,
      MAX(counter.reset_at) AS resetAt,
      MAX(counter.reset_version) AS counterVersion
    FROM admin_study_counter AS counter
    LEFT JOIN study_sessions AS session ON 1 = 1
    WHERE counter.id = 1
  `);
  return {
    activeSessionCount: Number(row.activeCount || 0),
    completedSessionCount: Number(row.completedCount || 0),
    totalSeconds: Number(row.totalSeconds || 0),
    counterResetAt: toIsoUtc(row.resetAt),
    counterVersion: Number(row.counterVersion || 0),
  };
}

export async function listStudyCounterArchive(pool) {
  const [rows] = await pool.query(`
    SELECT id, period_started_at AS periodStartedAt, period_ended_at AS periodEndedAt,
           completed_session_count AS completedSessionCount, total_seconds AS totalSeconds
    FROM admin_study_counter_archive
    ORDER BY period_ended_at DESC
    LIMIT 120
  `);
  return rows.map((row) => ({
    id: String(row.id),
    periodStartedAt: toIsoUtc(row.periodStartedAt),
    periodEndedAt: toIsoUtc(row.periodEndedAt),
    completedSessionCount: Number(row.completedSessionCount || 0),
    totalSeconds: Number(row.totalSeconds || 0),
  }));
}

export async function resetStudyCounter(pool, adminId) {
  return inTransaction(pool, async (connection) => {
    const [counterRows] = await connection.execute('SELECT id FROM admin_study_counter WHERE id = 1 FOR UPDATE');
    if (counterRows.length !== 1) throw new Error('Study counter configuration is missing');
    const [[counter]] = await connection.execute(`
      SELECT reset_at AS resetAt, reset_version AS counterVersion,
             UTC_TIMESTAMP(3) AS resetNow
      FROM admin_study_counter WHERE id = 1
    `);

    const [[period]] = await connection.execute(`
      SELECT
        COALESCE(SUM(session.status = 'completed'
          AND (? IS NULL OR session.ended_at >= ?)), 0) AS completedCount,
        COALESCE(SUM(CASE
          WHEN ? IS NULL AND session.status = 'completed' THEN session.duration_seconds
          WHEN ? IS NULL THEN GREATEST(0, TIMESTAMPDIFF(SECOND, session.started_at, ?))
          ELSE GREATEST(0, TIMESTAMPDIFF(SECOND,
            GREATEST(session.started_at, ?),
            LEAST(COALESCE(session.ended_at, ?), ?)))
        END), 0) AS totalSeconds
      FROM study_sessions AS session
    `, [counter.resetAt, counter.resetAt, counter.resetAt, counter.resetAt, counter.resetNow,
      counter.resetAt, counter.resetNow, counter.resetNow]);

    await connection.execute(`
      INSERT INTO admin_study_counter_archive
        (period_started_at, period_ended_at, completed_session_count, total_seconds, archived_by_admin_id)
      VALUES (?, ?, ?, ?, ?)
    `, [counter.resetAt, counter.resetNow, Number(period.completedCount || 0), Number(period.totalSeconds || 0), adminId]);

    await connection.execute(`
      UPDATE admin_study_counter
      SET reset_at = ?, reset_version = reset_version + 1, reset_by_admin_id = ?
      WHERE id = 1
    `, [counter.resetNow, adminId]);

    const [[updated]] = await connection.execute(`
      SELECT reset_at AS resetAt, reset_version AS counterVersion,
        (SELECT COUNT(*) FROM study_sessions WHERE status = 'active') AS activeCount
      FROM admin_study_counter WHERE id = 1
    `);
    return {
      ok: true,
      totalSeconds: 0,
      completedSessionCount: 0,
      activeSessionCount: Number(updated.activeCount || 0),
      counterResetAt: toIsoUtc(updated.resetAt),
      counterVersion: Number(updated.counterVersion),
    };
  });
}
