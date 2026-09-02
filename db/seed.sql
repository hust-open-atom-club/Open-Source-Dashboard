\encoding UTF8
SET client_encoding = 'UTF8';

-- Repository-to-SIG assignments are synchronized from GitHub's osd_sig
-- Custom Property. This seed only creates the organization and supported SIGs.
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
