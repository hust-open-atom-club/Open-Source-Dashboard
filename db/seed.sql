\encoding UTF8
SET client_encoding = 'UTF8';

-- 1. Insert the single monitored organization
INSERT INTO organizations (name) VALUES
('hust-open-atom-club')
ON CONFLICT (name) DO NOTHING;

-- 2. Insert Special Interest Groups (SIGs)
-- Ensure the org_id subquery is correct
INSERT INTO special_interest_groups (org_id, name) VALUES
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), '镜像站运维 SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'Linux内核SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'RUSTSBI SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'HCTT SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), 'Dojo SIG'),
((SELECT id FROM organizations WHERE name = 'hust-open-atom-club'), '数字基础设施维护 SIG')
ON CONFLICT (org_id, name) DO NOTHING; -- Added for idempotency

-- 3. Insert Repositories and link to SIGs
-- Helper function to get IDs (CORRECTED SYNTAX)
CREATE OR REPLACE FUNCTION get_org_id() RETURNS INTEGER AS $$
  SELECT id FROM organizations WHERE name = 'hust-open-atom-club';
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION get_sig_id(sig_name VARCHAR) RETURNS INTEGER AS $$
  SELECT id FROM special_interest_groups WHERE name = sig_name AND org_id = get_org_id();
$$ LANGUAGE SQL;

-- Mirror SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hust-mirrors'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hustmirror-cli'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hustmirror-cli-archive'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hustmirror-cli-pypi'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'mirrorrequest'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hm-admin-tui'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'cloc-debian'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'tunasync'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'tunasync-scripts'),
(get_org_id(), get_sig_id('镜像站运维 SIG'), 'hustsync.rs');

-- Linux Kernel SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('Linux内核SIG'), 'LT'),
(get_org_id(), get_sig_id('Linux内核SIG'), 'linux-edu-rank'),
(get_org_id(), get_sig_id('Linux内核SIG'), 'HUST-OS-Kernel-Contribution'),
(get_org_id(), get_sig_id('Linux内核SIG'), 'KTestRobot'),
(get_org_id(), get_sig_id('Linux内核SIG'), 'larkbot_v2');

-- RUSTSBI SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('RUSTSBI SIG'), 'hustoa-vm'),
(get_org_id(), get_sig_id('RUSTSBI SIG'), 'rustsbi'),
(get_org_id(), get_sig_id('RUSTSBI SIG'), 'RISCV-ONLINE');

-- HCTT SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('HCTT SIG'), 'check_trans_update'),
(get_org_id(), get_sig_id('HCTT SIG'), 'open-source-deadlines-rn'),
(get_org_id(), get_sig_id('HCTT SIG'), 'open-source-deadlines-openharmony'),
(get_org_id(), get_sig_id('HCTT SIG'), 'TranslateProject'),
(get_org_id(), get_sig_id('HCTT SIG'), 'docs'),
(get_org_id(), get_sig_id('HCTT SIG'), 'linux-insides-zh'),
(get_org_id(), get_sig_id('HCTT SIG'), 'intro2oss'),
(get_org_id(), get_sig_id('HCTT SIG'), 'intro2oss-lab'),
(get_org_id(), get_sig_id('HCTT SIG'), 'markdown-nice-build'),
(get_org_id(), get_sig_id('HCTT SIG'), 'OpenAtomClub'),
(get_org_id(), get_sig_id('HCTT SIG'), 'hctt-scripts'),
(get_org_id(), get_sig_id('HCTT SIG'), 'lwn2md'),
(get_org_id(), get_sig_id('HCTT SIG'), 'linuxsoftwarelist');

-- Dojo SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('Dojo SIG'), 'dojo_auto_compilation'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Kernel_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'git-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Repo2Kook'),
(get_org_id(), get_sig_id('Dojo SIG'), 'pwn.hust.college'),
(get_org_id(), get_sig_id('Dojo SIG'), 'example-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'official-dojos'),
(get_org_id(), get_sig_id('Dojo SIG'), 'welcome-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'linux101-dojo-x64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'pwntools-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Pokemon_League_Conference_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Pokemon_League_Conference_ARM64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Pewter_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Cerulean_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Saffron_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Vermilion_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Saffron_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Vermilion_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Cerulean_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Pewter_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Celadon_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Celadon_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Cinnabar_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Cinnabar_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Viridian_Dojo_X64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Viridian_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'Fuchsia_Dojo_Arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'L3H-CTF-Club-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'software-security-dojo-x64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'software-security-materials'),
(get_org_id(), get_sig_id('Dojo SIG'), 'software-security-lab-dojo-x64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'software-security-dojo-arm64'),
(get_org_id(), get_sig_id('Dojo SIG'), 'giteerank'),
(get_org_id(), get_sig_id('Dojo SIG'), 'HUST_SoftwareSecurity'),
(get_org_id(), get_sig_id('Dojo SIG'), 'test-dojo'),
(get_org_id(), get_sig_id('Dojo SIG'), 'system-security-dojo-x64-2025');


-- Infrastructure SIG
INSERT INTO repositories (org_id, sig_id, name) VALUES
(get_org_id(), get_sig_id('数字基础设施维护 SIG'), 'OpenSift'),
(get_org_id(), get_sig_id('数字基础设施维护 SIG'), 'logos'),
(get_org_id(), get_sig_id('数字基础设施维护 SIG'), '.github'),
(get_org_id(), get_sig_id('数字基础设施维护 SIG'), 'larkapp');

-- Clean up helper functions
DROP FUNCTION get_org_id();
DROP FUNCTION get_sig_id(sig_name VARCHAR);

