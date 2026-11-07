CREATE TABLE IF NOT EXISTS admin_study_counter (
  id TINYINT UNSIGNED NOT NULL,
  reset_at DATETIME(3) NULL,
  reset_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reset_by_admin_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_admin_counter_owner FOREIGN KEY (reset_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_study_counter (id, reset_at, reset_version) VALUES (1, NULL, 0);
