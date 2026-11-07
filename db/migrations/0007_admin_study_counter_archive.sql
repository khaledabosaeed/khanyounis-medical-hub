CREATE TABLE IF NOT EXISTS admin_study_counter_archive (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_started_at DATETIME(3) NULL,
  period_ended_at DATETIME(3) NOT NULL,
  completed_session_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_seconds BIGINT UNSIGNED NOT NULL DEFAULT 0,
  archived_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_counter_archive_period (period_ended_at),
  CONSTRAINT fk_counter_archive_admin FOREIGN KEY (archived_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
