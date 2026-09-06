\encoding UTF8
SET client_encoding = 'UTF8';

-- Repository-to-SIG assignments are synchronized from GitHub's osd_sig
-- Custom Property. This seed only creates the organization and supported SIGs.
-- Upstream organizations (outside hust-open-atom-club) are configured in
-- upstream_org_trackings (see schema.sql); rustsbi org is pre-configured for R² SIG.
INSERT INTO organizations (name) VALUES
('hust-open-atom-club')
ON CONFLICT (name) DO NOTHING;

INSERT INTO special_interest_groups (org_id, slug, name) VALUES
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'hustmirror', '镜像站运维 SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'linux-kernel', 'Linux内核SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'r2', 'R² SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'hctt', 'HCTT SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'pwnhustcollege', 'pwn.hust.college SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'infrastructure', '数字基础设施维护 SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'llmagent', 'Agent SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'openharmony', 'OpenHarmony SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'rtthread', 'RT-thread SIG')
ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name;

-- Upstream org tracking: enumerate every repository of the rustsbi
-- organization into R² SIG. The main repository rustsbi/rustsbi collects
-- commit statistics across ALL branches (deduplicated by commit oid).
INSERT INTO upstream_org_trackings (owner_login, sig_slug, main_repo_name)
VALUES ('rustsbi', 'r2', 'rustsbi')
ON CONFLICT (owner_login) DO UPDATE
SET sig_slug = EXCLUDED.sig_slug,
    main_repo_name = EXCLUDED.main_repo_name;
