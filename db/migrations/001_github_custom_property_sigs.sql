\encoding UTF8
\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE special_interest_groups
ADD COLUMN IF NOT EXISTS slug VARCHAR(255);

UPDATE special_interest_groups
SET slug = CASE name
    WHEN '镜像站运维 SIG' THEN 'hustmirror'
    WHEN 'Linux内核SIG' THEN 'linux-kernel'
    WHEN 'RUSTSBI SIG' THEN 'r2'
    WHEN 'R² SIG' THEN 'r2'
    WHEN 'HCTT SIG' THEN 'hctt'
    WHEN 'Dojo SIG' THEN 'pwnhustcollege'
    WHEN 'pwn.hust.college SIG' THEN 'pwnhustcollege'
    WHEN '数字基础设施维护 SIG' THEN 'infrastructure'
    WHEN 'Agent SIG' THEN 'llmagent'
    WHEN 'OpenHarmony SIG' THEN 'openharmony'
    WHEN 'RT-thread SIG' THEN 'rtthread'
    ELSE slug
END
WHERE slug IS NULL;

-- Keep existing SIG ids so historical sig_snapshots remain attached.
UPDATE special_interest_groups SET name = 'R² SIG' WHERE slug = 'r2';
UPDATE special_interest_groups SET name = 'pwn.hust.college SIG' WHERE slug = 'pwnhustcollege';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM special_interest_groups WHERE slug IS NULL) THEN
        RAISE EXCEPTION 'Cannot migrate unknown SIG rows without an osd_sig slug';
    END IF;
END $$;

ALTER TABLE special_interest_groups
ALTER COLUMN slug SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'special_interest_groups_org_id_slug_key'
    ) THEN
        ALTER TABLE special_interest_groups
        ADD CONSTRAINT special_interest_groups_org_id_slug_key UNIQUE (org_id, slug);
    END IF;
END $$;

ALTER TABLE repositories
ALTER COLUMN sig_id DROP NOT NULL;

ALTER TABLE repositories
ADD COLUMN IF NOT EXISTS github_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'repositories'::regclass
          AND conname = 'repositories_github_id_key'
    ) THEN
        ALTER TABLE repositories
        ADD CONSTRAINT repositories_github_id_key UNIQUE (github_id);
    END IF;
END $$;

ALTER TABLE repositories
DROP CONSTRAINT IF EXISTS repositories_sig_id_fkey;

ALTER TABLE repositories
ADD CONSTRAINT repositories_sig_id_fkey
FOREIGN KEY (sig_id) REFERENCES special_interest_groups(id) ON DELETE SET NULL;

COMMIT;
