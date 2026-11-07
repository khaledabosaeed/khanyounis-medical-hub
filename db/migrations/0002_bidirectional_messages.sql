ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sender_role VARCHAR(20) NOT NULL DEFAULT 'admin';
ALTER TABLE messages
  ALTER COLUMN created_by_admin_open_id DROP NOT NULL;
