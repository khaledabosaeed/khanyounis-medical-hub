CREATE TABLE IF NOT EXISTS admin_study_counter (
  id SMALLINT NOT NULL PRIMARY KEY,
  reset_at TIMESTAMPTZ(3) NULL,
  reset_version BIGINT NOT NULL DEFAULT 0,
  reset_by_admin_id BIGINT NULL,
  CONSTRAINT fk_admin_counter_owner FOREIGN KEY (reset_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
);
INSERT INTO admin_study_counter (id, reset_at, reset_version)
VALUES (1, NULL, 0)
ON CONFLICT (id) DO NOTHING;
