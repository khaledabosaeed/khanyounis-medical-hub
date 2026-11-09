-- Sub-admins ("viewer" role): read-only dashboard accounts created by the owner.
-- last_login_at becomes nullable so a sub-admin who never signed in shows as such.
ALTER TABLE admins ALTER COLUMN last_login_at DROP NOT NULL;
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS created_by_admin_id BIGINT NULL REFERENCES admins(id) ON DELETE SET NULL;
-- The admin dashboard is now English; rename the default owner display name.
UPDATE admins SET full_name = 'Medical Hub Owner'
WHERE admin_role = 'owner' AND full_name = 'مالك منصة الميدكال هب';
