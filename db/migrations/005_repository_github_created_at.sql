-- GitHub's creation timestamp is not the local registration time or an
-- organization's membership start. NULL means it has not been fetched yet.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS github_created_at TIMESTAMPTZ;
