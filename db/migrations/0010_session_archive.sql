-- Counter resets now move completed sessions into the archive period they
-- belong to. Sessions stay in study_sessions (students keep their history);
-- archived ones are hidden from the live admin dashboard and shown in the
-- daily archive instead.
ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ(3) NULL;
ALTER TABLE study_sessions
  ADD COLUMN IF NOT EXISTS archive_period_id BIGINT NULL REFERENCES admin_study_counter_archive(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_study_sessions_archived ON study_sessions (archived_at, started_at);
-- Backfill: sessions that ended before the last reset belong to past periods.
UPDATE study_sessions AS session
SET archived_at = counter.reset_at
FROM admin_study_counter AS counter
WHERE counter.id = 1 AND counter.reset_at IS NOT NULL
  AND session.status = 'completed' AND session.archived_at IS NULL
  AND session.ended_at < counter.reset_at;
UPDATE study_sessions AS session
SET archive_period_id = period.id
FROM admin_study_counter_archive AS period
WHERE session.archived_at IS NOT NULL AND session.archive_period_id IS NULL
  AND session.ended_at >= COALESCE(period.period_started_at, '-infinity'::timestamptz)
  AND session.ended_at < period.period_ended_at;
