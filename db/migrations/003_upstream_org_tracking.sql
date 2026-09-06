-- 003: 上游组织跟踪（upstream org tracking）
-- 目标：仪表盘可以跟踪 hust-open-atom-club 之外的 GitHub 组织（如 rustsbi），
-- 并对配置的主仓库启用全分支 commit 统计。
--
-- 变更：
--   1. repositories 增加 owner_login / track_all_branches 列；
--   2. 唯一约束从 (org_id, name) 放宽为 (org_id, owner_login, name)，
--      允许 club 的 fork（如 hust-open-atom-club/rustsbi）与上游同名仓库
--      （rustsbi/rustsbi）同时保留历史；
--   3. 新增 upstream_org_trackings 配置表，并预置 rustsbi 组织（R² SIG），
--      主仓库 rustsbi/rustsbi 启用全分支统计。
--
-- 部署后需将 club fork hust-open-atom-club/rustsbi 的 osd_sig 属性改为
-- untracked，避免与上游仓库双计。

BEGIN;

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS owner_login VARCHAR(255) NOT NULL DEFAULT 'hust-open-atom-club';
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS track_all_branches BOOLEAN NOT NULL DEFAULT FALSE;

-- 幂等：本脚本在每次部署时都会重放（run-migrations.sh 不记录已应用状态）。
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_org_id_name_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'repositories_org_owner_name_unique'
    ) THEN
        ALTER TABLE repositories ADD CONSTRAINT repositories_org_owner_name_unique UNIQUE (org_id, owner_login, name);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS upstream_org_trackings (
    owner_login VARCHAR(255) PRIMARY KEY,
    sig_slug VARCHAR(255) NOT NULL,
    main_repo_name VARCHAR(255),
    include_archived BOOLEAN NOT NULL DEFAULT TRUE,
    include_forks BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO upstream_org_trackings (owner_login, sig_slug, main_repo_name)
VALUES ('rustsbi', 'r2', 'rustsbi')
ON CONFLICT (owner_login) DO UPDATE
SET sig_slug = EXCLUDED.sig_slug,
    main_repo_name = EXCLUDED.main_repo_name;

COMMIT;
