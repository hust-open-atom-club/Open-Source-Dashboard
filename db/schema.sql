\encoding UTF8
SET client_encoding = 'UTF8';

-- Table: organizations
-- 组织表 (现在只用于存储 hust-open-atom-club)
CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: special_interest_groups
-- SIG 表
CREATE TABLE special_interest_groups (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug VARCHAR(255) NOT NULL, -- GitHub osd_sig Custom Property value
    name VARCHAR(255) NOT NULL, -- SIG 名称，如 镜像站运维 SIG
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (org_id, name),
    UNIQUE (org_id, slug)
);

-- Table: repositories
-- 重点仓库表
-- owner_login: 仓库实际所属的 GitHub 账号/组织；对上游仓库（如 rustsbi org）
-- 与仪表盘组织（hust-open-atom-club）不同。
-- track_all_branches: 为 TRUE 时 commit 统计覆盖所有分支（按 commit oid 去重），
-- 而非仅默认分支。
CREATE TABLE repositories (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sig_id INTEGER REFERENCES special_interest_groups(id) ON DELETE SET NULL, -- NULL means osd_sig=untracked
    github_id BIGINT UNIQUE, -- Stable GitHub repository identity, preserved across renames
    is_in_organization BOOLEAN NOT NULL DEFAULT TRUE, -- False retains history for repositories no longer in the GitHub organization
    name VARCHAR(255) NOT NULL, -- 仓库名称，如 hust-mirrors
    owner_login VARCHAR(255) NOT NULL DEFAULT 'hust-open-atom-club', -- GitHub owner（组织或用户），上游仓库时与 org 不同
    track_all_branches BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE 时 commit 统计聚合所有分支并按 oid 去重
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT repositories_org_owner_name_unique UNIQUE (org_id, owner_login, name)
);

-- Table: activity_snapshots
-- 组织级别活动快照 (总览数据)
CREATE TABLE activity_snapshots (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    new_prs INTEGER DEFAULT 0,
    closed_merged_prs INTEGER DEFAULT 0,
    new_issues INTEGER DEFAULT 0,
    closed_issues INTEGER DEFAULT 0,
    active_contributors INTEGER DEFAULT 0,
    new_repos INTEGER DEFAULT 0,
    new_commits INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same organization
    UNIQUE (org_id, snapshot_date)
);

-- Table: sig_snapshots
-- SIG 级别活动快照 (聚合数据)
CREATE TABLE sig_snapshots (
    id SERIAL PRIMARY KEY,
    sig_id INTEGER NOT NULL REFERENCES special_interest_groups(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    new_prs INTEGER DEFAULT 0,
    closed_merged_prs INTEGER DEFAULT 0,
    new_issues INTEGER DEFAULT 0,
    closed_issues INTEGER DEFAULT 0,
    active_contributors INTEGER DEFAULT 0,
    new_commits INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same SIG
    UNIQUE (sig_id, snapshot_date)
);

-- Table: repo_snapshots
-- 仓库级别活动快照 (精细数据)
CREATE TABLE repo_snapshots (
    id SERIAL PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    new_prs INTEGER DEFAULT 0,
    closed_merged_prs INTEGER DEFAULT 0,
    new_issues INTEGER DEFAULT 0,
    closed_issues INTEGER DEFAULT 0,
    active_contributors INTEGER DEFAULT 0,
    new_commits INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same repository
    UNIQUE (repo_id, snapshot_date)
);

-- Index for faster lookups
CREATE INDEX idx_activity_snapshots_org_date ON activity_snapshots (org_id, snapshot_date);
CREATE INDEX idx_sig_snapshots_sig_date ON sig_snapshots (sig_id, snapshot_date);
CREATE INDEX idx_repo_snapshots_repo_date ON repo_snapshots (repo_id, snapshot_date);

-- Table: upstream_org_trackings
-- 上游组织跟踪配置：枚举指定 GitHub 组织下的所有仓库并归入指定 SIG。
-- main_repo_name 指定的仓库会启用全分支 commit 统计（track_all_branches）。
CREATE TABLE upstream_org_trackings (
    owner_login VARCHAR(255) PRIMARY KEY, -- 上游组织登录名，如 rustsbi
    sig_slug VARCHAR(255) NOT NULL, -- 归入的 SIG（osd_sig 取值，如 r2）
    main_repo_name VARCHAR(255), -- 主仓库名；该仓库统计所有分支
    include_archived BOOLEAN NOT NULL DEFAULT TRUE,
    include_forks BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
