CREATE TABLE IF NOT EXISTS admin_auth_sessions (
  token_hash CHAR(64) NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL,
  csrf_token VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_admin_auth_sessions_admin (admin_id),
  KEY idx_admin_auth_sessions_expiry (expires_at),
  CONSTRAINT fk_admin_auth_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
