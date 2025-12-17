-- 贡献者追踪系统数据库表
-- 执行: psql -d oss_dashboard -f db/contributors_schema.sql

-- 贡献者表
CREATE TABLE IF NOT EXISTS contributors (
    id SERIAL PRIMARY KEY,
    github_username VARCHAR(255) UNIQUE NOT NULL,
    github_id BIGINT UNIQUE,  -- GitHub 用户 ID
    avatar_url TEXT,
    name VARCHAR(255),
    email VARCHAR(255),
    first_seen_date DATE NOT NULL,  -- 首次出现日期
    last_seen_date DATE NOT NULL,   -- 最后活跃日期
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 贡献者每日活动表（组织级别聚合）
CREATE TABLE IF NOT EXISTS contributor_daily_activities (
    id SERIAL PRIMARY KEY,
    contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    
    -- 当日贡献统计
    prs_opened INTEGER DEFAULT 0,
    prs_closed INTEGER DEFAULT 0,
    issues_opened INTEGER DEFAULT 0,
    issues_closed INTEGER DEFAULT 0,
    commits_count INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    
    -- 活跃的仓库数量
    active_repos_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE (contributor_id, org_id, snapshot_date)
);

-- 贡献者-仓库关联表（仓库级别详细数据）
CREATE TABLE IF NOT EXISTS contributor_repo_activities (
    id SERIAL PRIMARY KEY,
    contributor_id INTEGER NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
    repo_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    
    prs_opened INTEGER DEFAULT 0,
    prs_closed INTEGER DEFAULT 0,
    issues_opened INTEGER DEFAULT 0,
    issues_closed INTEGER DEFAULT 0,
    commits_count INTEGER DEFAULT 0,
    lines_added INTEGER DEFAULT 0,
    lines_deleted INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE (contributor_id, repo_id, snapshot_date)
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_contributors_username ON contributors(github_username);
CREATE INDEX IF NOT EXISTS idx_contributors_github_id ON contributors(github_id);
CREATE INDEX IF NOT EXISTS idx_contributors_last_seen ON contributors(last_seen_date);

CREATE INDEX IF NOT EXISTS idx_contributor_activities_date ON contributor_daily_activities(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_contributor_activities_contributor ON contributor_daily_activities(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributor_activities_org ON contributor_daily_activities(org_id);

CREATE INDEX IF NOT EXISTS idx_contributor_repo_activities_date ON contributor_repo_activities(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_contributor_repo_activities_contributor ON contributor_repo_activities(contributor_id);
CREATE INDEX IF NOT EXISTS idx_contributor_repo_activities_repo ON contributor_repo_activities(repo_id);

-- 添加注释
COMMENT ON TABLE contributors IS '贡献者基本信息表';
COMMENT ON TABLE contributor_daily_activities IS '贡献者每日活动表（组织级别）';
COMMENT ON TABLE contributor_repo_activities IS '贡献者仓库活动表（仓库级别）';

COMMENT ON COLUMN contributors.github_username IS 'GitHub 用户名';
COMMENT ON COLUMN contributors.github_id IS 'GitHub 用户 ID（数字）';
COMMENT ON COLUMN contributors.first_seen_date IS '首次出现在系统中的日期';
COMMENT ON COLUMN contributors.last_seen_date IS '最后一次活跃的日期';

