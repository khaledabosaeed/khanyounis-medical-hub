-- Some databases already had admins.is_active as SMALLINT (0/1) before
-- 0003 ran, so its ADD COLUMN IF NOT EXISTS ... BOOLEAN was skipped and
-- queries like `is_active = TRUE` fail with 42883 (smallint = boolean).
-- Normalize the column to BOOLEAN. The cast works for both SMALLINT and an
-- existing BOOLEAN column, so this is safe to run on every database.
ALTER TABLE admins ALTER COLUMN is_active DROP DEFAULT;
ALTER TABLE admins ALTER COLUMN is_active TYPE BOOLEAN USING (is_active::INTEGER <> 0);
ALTER TABLE admins ALTER COLUMN is_active SET DEFAULT TRUE;
ALTER TABLE admins ALTER COLUMN is_active SET NOT NULL;
