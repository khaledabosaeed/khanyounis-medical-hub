ALTER TABLE admins
  ADD COLUMN password_hash VARCHAR(255) NULL,
  ADD COLUMN admin_role ENUM('owner', 'admin') NOT NULL DEFAULT 'owner',
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;
