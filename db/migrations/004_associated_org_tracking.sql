-- 004: 关联组织跟踪（associated org tracking）
-- 目标：仪表盘可以跟踪 hust-open-atom-club 之外的 GitHub 关联组织（如 rustsbi）。
-- 关联组织的仓库通过与仪表盘组织相同的 osd_sig Custom Property 声明归属
-- SIG（如 osd_sig=r2）：
--   - 属性值为受支持 SIG 的公开仓库被跟踪到对应 SIG；
--   - 未设置属性或值为 untracked 的仓库不跟踪；私有仓库原则上不跟踪；
--   - 移除声明或从组织删除后停止跟踪（历史保留）；
--   - commit 统计与其他仓库一致，仅取默认分支。
--
-- 变更：
--   1. repositories 增加 owner_login 列；
--   2. 唯一约束从 (org_id, name) 放宽为 (org_id, owner_login, name)，
--      允许 club 的 fork（如 hust-open-atom-club/rustsbi）与关联组织同名
--      仓库（rustsbi/rustsbi）同时保留历史；
--   3. 新增 associated_org_trackings 关联组织配置表，预置 rustsbi。
--
-- 部署后需将 club fork hust-open-atom-club/rustsbi 的 osd_sig 属性改为
-- untracked，并在需要跟踪的关联组织仓库（如 rustsbi/rustsbi）设置
-- osd_sig 属性为 r2，避免双计。

BEGIN;

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS owner_login VARCHAR(255) NOT NULL DEFAULT 'hust-open-atom-club';
-- 早期版本的迁移曾引入全分支统计列；关联组织统一按默认分支统计，清理该列。
ALTER TABLE repositories DROP COLUMN IF EXISTS track_all_branches;

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

-- 早期 PR 版本曾将该表命名为 upstream_org_trackings（并含按整组织映射 SIG
-- 的旧列 sig_slug/main_repo_name/include_*）；按评审意见统一改名为
-- associated_org_trackings 并清理旧列，保证幂等重放。
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'upstream_org_trackings'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'associated_org_trackings'
    ) THEN
        ALTER TABLE upstream_org_trackings RENAME TO associated_org_trackings;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS associated_org_trackings (
    owner_login VARCHAR(255) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE associated_org_trackings DROP COLUMN IF EXISTS sig_slug;
ALTER TABLE associated_org_trackings DROP COLUMN IF EXISTS main_repo_name;
ALTER TABLE associated_org_trackings DROP COLUMN IF EXISTS include_archived;
ALTER TABLE associated_org_trackings DROP COLUMN IF EXISTS include_forks;

INSERT INTO associated_org_trackings (owner_login)
VALUES ('rustsbi')
ON CONFLICT (owner_login) DO NOTHING;

COMMIT;
