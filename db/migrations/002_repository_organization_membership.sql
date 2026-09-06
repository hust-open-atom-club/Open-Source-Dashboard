\encoding UTF8
\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE repositories
ADD COLUMN IF NOT EXISTS is_in_organization BOOLEAN;

-- Existing rows remain current until the required metadata synchronization
-- below compares them with the complete GitHub Custom Property assignment set.
UPDATE repositories
SET is_in_organization = TRUE
WHERE is_in_organization IS NULL;

ALTER TABLE repositories
ALTER COLUMN is_in_organization SET DEFAULT TRUE;

ALTER TABLE repositories
ALTER COLUMN is_in_organization SET NOT NULL;

COMMIT;

-- After applying this migration, run the repository metadata synchronization:
-- npm run sync-repository-sigs
