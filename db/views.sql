-- Aggregation Views for Performance Optimization
-- These materialized views can be used to speed up aggregated queries

-- Weekly Activity Snapshots for Organizations
CREATE MATERIALIZED VIEW IF NOT EXISTS weekly_activity_snapshots AS
SELECT 
    org_id,
    date_trunc('week', snapshot_date)::date as week_start,
    SUM(new_prs) as new_prs,
    SUM(closed_merged_prs) as closed_merged_prs,
    SUM(new_issues) as new_issues,
    SUM(closed_issues) as closed_issues,
    SUM(new_commits) as new_commits,
    SUM(lines_added) as lines_added,
    SUM(lines_deleted) as lines_deleted,
    AVG(active_contributors) as avg_active_contributors
FROM activity_snapshots
GROUP BY org_id, date_trunc('week', snapshot_date)
ORDER BY org_id, week_start;

-- Monthly Activity Snapshots for Organizations
CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_activity_snapshots AS
SELECT 
    org_id,
    date_trunc('month', snapshot_date)::date as month_start,
    SUM(new_prs) as new_prs,
    SUM(closed_merged_prs) as closed_merged_prs,
    SUM(new_issues) as new_issues,
    SUM(closed_issues) as closed_issues,
    SUM(new_commits) as new_commits,
    SUM(lines_added) as lines_added,
    SUM(lines_deleted) as lines_deleted,
    AVG(active_contributors) as avg_active_contributors
FROM activity_snapshots
GROUP BY org_id, date_trunc('month', snapshot_date)
ORDER BY org_id, month_start;

-- Weekly SIG Snapshots
CREATE MATERIALIZED VIEW IF NOT EXISTS weekly_sig_snapshots AS
SELECT 
    sig_id,
    date_trunc('week', snapshot_date)::date as week_start,
    SUM(new_prs) as new_prs,
    SUM(closed_merged_prs) as closed_merged_prs,
    SUM(new_issues) as new_issues,
    SUM(closed_issues) as closed_issues,
    SUM(new_commits) as new_commits,
    SUM(lines_added) as lines_added,
    SUM(lines_deleted) as lines_deleted,
    AVG(active_contributors) as avg_active_contributors
FROM sig_snapshots
GROUP BY sig_id, date_trunc('week', snapshot_date)
ORDER BY sig_id, week_start;

-- Monthly SIG Snapshots
CREATE MATERIALIZED VIEW IF NOT EXISTS monthly_sig_snapshots AS
SELECT 
    sig_id,
    date_trunc('month', snapshot_date)::date as month_start,
    SUM(new_prs) as new_prs,
    SUM(closed_merged_prs) as closed_merged_prs,
    SUM(new_issues) as new_issues,
    SUM(closed_issues) as closed_issues,
    SUM(new_commits) as new_commits,
    SUM(lines_added) as lines_added,
    SUM(lines_deleted) as lines_deleted,
    AVG(active_contributors) as avg_active_contributors
FROM sig_snapshots
GROUP BY sig_id, date_trunc('month', snapshot_date)
ORDER BY sig_id, month_start;

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_weekly_activity_org_week ON weekly_activity_snapshots(org_id, week_start);
CREATE INDEX IF NOT EXISTS idx_monthly_activity_org_month ON monthly_activity_snapshots(org_id, month_start);
CREATE INDEX IF NOT EXISTS idx_weekly_sig_week ON weekly_sig_snapshots(sig_id, week_start);
CREATE INDEX IF NOT EXISTS idx_monthly_sig_month ON monthly_sig_snapshots(sig_id, month_start);

-- Function to refresh all materialized views
CREATE OR REPLACE FUNCTION refresh_aggregation_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY weekly_activity_snapshots;
    REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_activity_snapshots;
    REFRESH MATERIALIZED VIEW CONCURRENTLY weekly_sig_snapshots;
    REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_sig_snapshots;
END;
$$ LANGUAGE plpgsql;

-- Note: To use these views, you can:
-- 1. Manually run: SELECT refresh_aggregation_views();
-- 2. Set up a cron job to refresh periodically
-- 3. Call the function from your application after data ingestion

