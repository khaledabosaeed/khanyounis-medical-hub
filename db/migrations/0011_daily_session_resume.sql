-- One study session per student per day: logging in again on the same day
-- reopens that day's session instead of starting a new one. Time is counted
-- per stretch: duration_seconds holds the finished stretches and
-- segment_started_at marks the start of the stretch that is running now.
ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS segment_started_at TIMESTAMPTZ(3) NULL;
UPDATE study_sessions SET segment_started_at = started_at WHERE segment_started_at IS NULL;

-- Seconds of this session already counted by an earlier counter period
-- (a session that was still running when the counter was reset).
ALTER TABLE study_sessions ADD COLUMN IF NOT EXISTS previous_period_seconds BIGINT NOT NULL DEFAULT 0;
UPDATE study_sessions AS session
SET previous_period_seconds = CASE
  WHEN session.status = 'completed' THEN LEAST(session.duration_seconds,
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (counter.reset_at - session.started_at)))))
  ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (counter.reset_at - session.started_at))))
END
FROM admin_study_counter AS counter
WHERE counter.id = 1 AND counter.reset_at IS NOT NULL
  AND session.archived_at IS NULL AND session.started_at < counter.reset_at
  AND session.previous_period_seconds = 0;

CREATE INDEX IF NOT EXISTS idx_study_sessions_student_status ON study_sessions (student_id, status, started_at);
