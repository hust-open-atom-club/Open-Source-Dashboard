-- Table: organizations
-- 组织表 (现在只用于存储 hust-open-atom-club)
CREATE TABLE organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: repositories
-- 重点仓库表
CREATE TABLE repositories (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same organization
    UNIQUE (org_id, snapshot_date)
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    -- Unique constraint to prevent duplicate daily entries for the same repository
    UNIQUE (repo_id, snapshot_date)
);

-- Index for faster lookups by organization and date
CREATE INDEX idx_activity_snapshots_org_date ON activity_snapshots (org_id, snapshot_date);
CREATE INDEX idx_repo_snapshots_repo_date ON repo_snapshots (repo_id, snapshot_date);
