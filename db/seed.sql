-- 1. Insert the single monitored organization
INSERT INTO organizations (name) VALUES
('hust-open-atom-club')
ON CONFLICT (name) DO NOTHING;

-- 2. Insert the 8 key repositories
INSERT INTO repositories (org_id, name, description) VALUES
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'hust-mirrors',
    '华科大开源镜像站点前端'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'open-source-deadlines',
    '开源活动截止日期站点'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'hustmirror-cli',
    '华科大开源镜像站点 CLI 工具'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'TranslateProject',
    'HCTT 翻译项目'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'linux-insides-zh',
    'Linux 内核揭秘'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'dojo',
    '网络空间安全教育实践平台'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'linux-edu-rank',
    'Linux 内核高校贡献榜'
),
(
    (SELECT id FROM organizations WHERE name = 'hust-open-atom-club'),
    'riscv-online',
    '在线 RISC-V 汇编反汇编工具'
)
ON CONFLICT (org_id, name) DO NOTHING;
