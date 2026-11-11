import { inTransaction } from './db/transaction.js';
import { hubDay, sessionSecondsSql, toIsoUtc } from './time.js';

// The counter covers every session that has not been moved to the archive yet.
// A session that was still running at the last reset keeps going, but the
// seconds it had before the reset (previous_period_seconds) were already
// counted by the earlier period.
export async function getStudyCounterOverview(pool) {
  const [[row]] = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN session.status = 'active' THEN 1 ELSE 0 END), 0) AS activeCount,
      COALESCE(SUM(CASE WHEN session.status = 'completed' THEN 1 ELSE 0 END), 0) AS completedCount,
      COALESCE(SUM(CASE WHEN session.id IS NULL THEN 0
        ELSE GREATEST(0, ${sessionSecondsSql()} - session.previous_period_seconds) END), 0) AS totalSeconds,
      MAX(counter.reset_at) AS resetAt,
      MAX(counter.reset_version) AS counterVersion
    FROM admin_study_counter AS counter
    LEFT JOIN study_sessions AS session ON session.archived_at IS NULL
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

// Archived counter periods, newest first. Each one is normally a month: the
// owner resets the counter at the start of every month.
export async function listStudyCounterArchive(pool) {
  const [rows] = await pool.query(`
    SELECT period.id, period.period_started_at AS periodStartedAt, period.period_ended_at AS periodEndedAt,
           period.completed_session_count AS completedSessionCount, period.total_seconds AS totalSeconds,
           (SELECT MIN(session.started_at) FROM study_sessions AS session
            WHERE session.archive_period_id = period.id) AS firstSessionAt,
           (SELECT MAX(session.started_at) FROM study_sessions AS session
            WHERE session.archive_period_id = period.id) AS lastSessionAt
    FROM admin_study_counter_archive AS period
    ORDER BY period.period_ended_at DESC
    LIMIT 120
  `);
  return rows.map((row) => {
    const periodStartedAt = toIsoUtc(row.periodStartedAt);
    const periodEndedAt = toIsoUtc(row.periodEndedAt);
    const sessionCount = Number(row.completedSessionCount || 0);
    const startDay = hubDay(periodStartedAt);
    // A reset just after midnight on the 1st closes the previous month: the
    // reset day only belongs to it if some of its sessions started that day.
    const resetDay = hubDay(periodEndedAt);
    const lastDay = hubDay(toIsoUtc(row.lastSessionAt));
    let endDay = lastDay === resetDay ? resetDay : previousDay(resetDay);
    if (startDay && endDay < startDay) endDay = startDay;
    return {
      id: String(row.id),
      periodStartedAt,
      periodEndedAt,
      startDay,
      endDay,
      firstDay: hubDay(toIsoUtc(row.firstSessionAt)),
      completedSessionCount: sessionCount,
      sessionCount,
      totalSeconds: Number(row.totalSeconds || 0),
    };
  });
}

function previousDay(day) {
  return new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

export async function resetStudyCounter(pool, adminId) {
  return inTransaction(pool, async (connection) => {
    const [counterRows] = await connection.execute('SELECT id FROM admin_study_counter WHERE id = 1 FOR UPDATE');
    if (counterRows.length !== 1) throw new Error('Study counter configuration is missing');
    const [[counter]] = await connection.execute(`
      SELECT reset_at AS resetAt, reset_version AS counterVersion,
             CURRENT_TIMESTAMP(3) AS resetNow
      FROM admin_study_counter WHERE id = 1
    `);

    // CURRENT_TIMESTAMP is fixed for the whole transaction, so this is the
    // same instant as resetNow.
    const secondsNow = sessionSecondsSql('session', 'CURRENT_TIMESTAMP(3)');
    const [[period]] = await connection.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN session.status = 'completed' THEN 1 ELSE 0 END), 0) AS completedCount,
        COALESCE(SUM(GREATEST(0, ${secondsNow} - session.previous_period_seconds)), 0) AS totalSeconds
      FROM study_sessions AS session
      WHERE session.archived_at IS NULL
    `);

    const [archived] = await connection.execute(`
      INSERT INTO admin_study_counter_archive
        (period_started_at, period_ended_at, completed_session_count, total_seconds, archived_by_admin_id)
      VALUES (?, ?, ?, ?, ?)
    `, [counter.resetAt, counter.resetNow, Number(period.completedCount || 0), Number(period.totalSeconds || 0), adminId]);

    // Running sessions stay live; the time they already have belongs to the
    // period that just closed.
    await connection.execute(`
      UPDATE study_sessions AS session
      SET previous_period_seconds = ${secondsNow}
      WHERE session.status = 'active' AND session.archived_at IS NULL
    `);

    // Move every completed session into this archive period. Active sessions
    // are archived by a later reset once they have ended.
    const [moved] = await connection.execute(`
      UPDATE study_sessions
      SET archived_at = ?, archive_period_id = ?
      WHERE status = 'completed' AND archived_at IS NULL
    `, [counter.resetNow, archived.insertId ?? null]);

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
      archivedSessionCount: Number(moved.affectedRows || 0),
      archivedSessionSeconds: Number(period.totalSeconds || 0),
      archivedPeriodSessionCount: Number(period.completedCount || 0),
      activeSessionCount: Number(updated.activeCount || 0),
      counterResetAt: toIsoUtc(updated.resetAt),
      counterVersion: Number(updated.counterVersion),
    };
  });
}
