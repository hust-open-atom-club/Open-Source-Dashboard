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
    name VARCHAR(255) NOT NULL, -- SIG 名称，如 镜像站运维 SIG
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (org_id, name)
);

-- Table: repositories
-- 重点仓库表
CREATE TABLE repositories (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    sig_id INTEGER NOT NULL REFERENCES special_interest_groups(id) ON DELETE CASCADE, -- 新增 SIG 关联
    name VARCHAR(255) NOT NULL, -- 仓库名称，如 hust-mirrors
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (org_id, name)
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
