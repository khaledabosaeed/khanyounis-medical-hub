CREATE TABLE IF NOT EXISTS admin_auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  csrf_token VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  expires_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT fk_admin_auth_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_auth_sessions_admin ON admin_auth_sessions (admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_auth_sessions_expiry ON admin_auth_sessions (expires_at);
