ALTER TABLE messages
  ADD COLUMN sender_role ENUM('admin', 'student') NOT NULL DEFAULT 'admin',
  MODIFY COLUMN created_by_admin_open_id VARCHAR(191) NULL;
