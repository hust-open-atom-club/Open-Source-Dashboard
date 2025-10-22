import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';
import './index.css'; // Import the basic styles

const API_BASE_URL = 'http://localhost:3000/api/v1';
const ITEMS_PER_PAGE = 10; // Default items per page

// Component for Pagination Controls
const Pagination = ({ currentPage, totalCount, onPageChange, type }) => {
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalCount);

  if (totalCount === 0) return null;

  return (
    <div className="pagination-controls">
      <span>
        {type === 'prs' ? 'PR' : 'Issue'} 总数: {totalCount} | 显示 {startItem}-{endItem} 条
      </span>
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
      >
        &larr; 上一页
      </button>
      <span className="page-info">
        第 {currentPage} / {totalPages} 页
      </span>
      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
      >
        下一页 &rarr;
      </button>
    </div>
  );
};

// Component to display a list of activities (PRs or Issues)
const ActivityList = ({ title, activities, totalCount, currentPage, onPageChange, type }) => (
  <div className="activity-list-container">
    <h3>{title}</h3>
    <Pagination
      currentPage={currentPage}
      totalCount={totalCount}
      onPageChange={onPageChange}
      type={type}
    />
    {activities.length === 0 ? (
      <p>暂无最新活动。</p>
    ) : (
      <ul className="activity-list">
        {activities.map((item) => (
          <li key={item.id} className="activity-item">
            <a href={item.url} target="_blank" rel="noopener noreferrer" title={item.title}>
              {item.title}
            </a>
            <div className="activity-meta">
              <span className="repo-name">[{item.repo}]</span>
              <span className="author">@{item.author}</span>
              <span className={`state state-${item.state}`}>{item.state}</span>
            </div>
          </li>
        ))}
      </ul>
    )}
    <Pagination
      currentPage={currentPage}
      totalCount={totalCount}
      onPageChange={onPageChange}
      type={type}
    />
  </div>
);

// Component for the ECharts trend graph
const RepoTrendChart = ({ repoName, data }) => {
    const chartOptions = useMemo(() => {
        if (data.length === 0) {
            return { title: { text: `${repoName} - 暂无数据`, left: 'center', textStyle: { color: '#ccc' } } };
        }

        const dates = data.map(d => d.date);
        const newPrs = data.map(d => d.new_prs);
        const closedMergedPrs = data.map(d => d.closed_merged_prs);
        const newIssues = data.map(d => d.new_issues);
        const closedIssues = data.map(d => d.closed_issues);

        return {
            title: {
                text: `${repoName} 活动趋势 (近 30 天)`,
                left: 'center',
                textStyle: { color: '#fff' }
            },
            tooltip: { trigger: 'axis' },
            legend: {
                data: ['新增 PR', '合并 PR', '新增 Issue', '关闭 Issue'],
                top: 30,
                textStyle: { color: '#ccc' }
            },
            grid: { left: '3%', right: '4%', bottom: '3%', containLabel: true },
            xAxis: { type: 'category', boundaryGap: false, data: dates, axisLabel: { color: '#ccc' } },
            yAxis: { type: 'value', axisLabel: { color: '#ccc' } },
            series: [
                { name: '新增 PR', type: 'line', data: newPrs, smooth: true, lineStyle: { color: '#646cff' } },
                { name: '合并 PR', type: 'line', data: closedMergedPrs, smooth: true, lineStyle: { color: '#4CAF50' } },
                { name: '新增 Issue', type: 'line', data: newIssues, smooth: true, lineStyle: { color: '#FFC107' } },
                { name: '关闭 Issue', type: 'line', data: closedIssues, smooth: true, lineStyle: { color: '#F44336' } }
            ]
        };
    }, [data, repoName]);

    return (
        <div className="repo-chart-card">
            <ReactECharts option={chartOptions} style={{ height: '300px', width: '100%' }} />
        </div>
    );
};


function App() {
  const [repos, setRepos] = useState([]);
  const [selectedRepoId, setSelectedRepoId] = useState(null);
  const [timeseriesData, setTimeseriesData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // State for PRs (now organization-wide)
  const [prsData, setPrsData] = useState({ activities: [], total_count: 0, page: 1 });
  // State for Issues (now organization-wide)
  const [issuesData, setIssuesData] = useState({ activities: [], total_count: 0, page: 1 });
  const [activityLoading, setActivityLoading] = useState(false);


  // Fetch list of monitored repositories on component mount
  useEffect(() => {
    const fetchRepos = async () => {
      setLoading(true);
      try {
        // API endpoint changed to /organization/repos
        const response = await axios.get(`${API_BASE_URL}/organization/repos`);
        setRepos(response.data);
        if (response.data.length > 0) {
          setSelectedRepoId(response.data[0].id); // Select the first repository by default
        }
      } catch (err) {
        console.error('Error fetching repositories:', err);
        setError('无法加载仓库列表。请确保后端服务已运行并配置正确。');
      } finally {
        setLoading(false);
      }
    };
    fetchRepos();
  }, []);

  // Fetch timeseries data when selectedRepoId changes
  useEffect(() => {
    if (!selectedRepoId) return;

    const fetchTimeseries = async () => {
      setLoading(true);
      setError(null);
      try {
        // API endpoint changed to /repository/:repoId/timeseries
        const response = await axios.get(`${API_BASE_URL}/repository/${selectedRepoId}/timeseries?range=30d`);
        setTimeseriesData(response.data);
      } catch (err) {
        console.error('Error fetching timeseries data:', err);
        setError('加载仓库时间序列数据失败。');
        setTimeseriesData([]);
      } finally {
        setLoading(false);
      }
    };
    fetchTimeseries();
    
  }, [selectedRepoId]);
  
  // Function to fetch organization-wide activities with pagination
  const fetchActivities = useCallback(async (type, page) => {
    // Org name is hardcoded in the backend now, so we don't need to pass it.
    const params = {
      type: type,
      page: page,
      per_page: ITEMS_PER_PAGE,
    };

    try {
      // API endpoint changed to /organization/latest-activity
      const response = await axios.get(`${API_BASE_URL}/organization/latest-activity`, { params });
      return response.data;
    } catch (err) {
      console.error(`Error fetching latest ${type} activities:`, err);
      return { activities: [], total_count: 0, page: 1 };
    }
  }, []);
  
  // Fetch latest organization-wide activities (PRs and Issues) when page changes
  useEffect(() => {
    if (repos.length === 0) return;

    const loadActivities = async () => {
      setActivityLoading(true);
      
      // Fetch PRs for current page
      const prsResult = await fetchActivities('prs', prsData.page);
      setPrsData(prev => ({ ...prev, activities: prsResult.activities, total_count: prsResult.total_count, per_page: prsResult.per_page }));

      // Fetch Issues for current page
      const issuesResult = await fetchActivities('issues', issuesData.page);
      setIssuesData(prev => ({ ...prev, activities: issuesResult.activities, total_count: issuesResult.total_count, per_page: issuesResult.per_page }));

      setActivityLoading(false);
    };
    
    loadActivities();
  }, [repos, prsData.page, issuesData.page, fetchActivities]); // Dependency on page state

  // Handlers for page change
  const handlePrsPageChange = (newPage) => {
    setPrsData(prev => ({ ...prev, page: newPage }));
  };

  const handleIssuesPageChange = (newPage) => {
    setIssuesData(prev => ({ ...prev, page: newPage }));
  };
  
  const selectedRepo = useMemo(() => {
      return repos.find(repo => repo.id === selectedRepoId);
  }, [repos, selectedRepoId]);

  // Extract the latest snapshot data for the data cards (using organization-wide timeseries)
  const orgTimeseriesData = useMemo(() => {
      // Fetch organization-wide timeseries data for the data cards
      const fetchOrgTimeseries = async () => {
          try {
              const response = await axios.get(`${API_BASE_URL}/organization/timeseries?range=30d`);
              return response.data;
          } catch (err) {
              console.error('Error fetching organization timeseries data:', err);
              return [];
          }
      };
      // We need to fetch this data separately as it's not tied to a single repo
      // For simplicity in this example, we'll just return null and rely on the repo data.
      // In a real app, this would be a separate state and useEffect.
      return null; 
  }, []);
  
  // For now, let's just use the latest data from the currently selected repo for the card.
  const latestSnapshot = useMemo(() => {
    if (timeseriesData.length === 0) return null;
    return timeseriesData[timeseriesData.length - 1];
  }, [timeseriesData]);


  return (
    <div className="App">
      <h1>华中科技大学开放原子开源俱乐部活动仪表板</h1>
      <h2>组织总览快照 ({latestSnapshot?.date || '加载中...'})</h2>

      {error && <p style={{ color: 'red' }}>错误: {error}</p>}
      {loading && <p>正在加载仓库列表和数据...</p>}

      {latestSnapshot && (
        <>
          {/* 1. Data Cards (Based on current repo for simplicity) */}
          <div className="card-container">
            <div className="data-card">
              <h3>新增 PR</h3>
              <p>{latestSnapshot.new_prs}</p>
            </div>
            <div className="data-card">
              <h3>合并 PR</h3>
              <p>{latestSnapshot.closed_merged_prs}</p>
            </div>
            <div className="data-card">
              <h3>活跃贡献者</h3>
              <p>{latestSnapshot.active_contributors}</p>
            </div>
            <div className="data-card">
              <h3>新增 Issue</h3>
              <p>{latestSnapshot.new_issues}</p>
            </div>
            <div className="data-card">
              <h3>仓库: {selectedRepo?.name}</h3>
              <p>{selectedRepo?.description}</p>
            </div>
          </div>

          {/* 2. Repository Selector and Trend Chart */}
          <h2 style={{ marginTop: '40px' }}>重点仓库活动趋势</h2>
          <div className="repo-selector-container">
              <select value={selectedRepoId || ''} onChange={(e) => setSelectedRepoId(parseInt(e.target.value))}>
                <option value="" disabled>请选择一个重点仓库</option>
                {repos.map(repo => (
                  <option key={repo.id} value={repo.id}>{repo.name} - {repo.description}</option>
                ))}
              </select>
          </div>
          
          <div className="chart-area">
            <RepoTrendChart repoName={selectedRepo?.name} data={timeseriesData} />
          </div>

          {/* 3. Latest Activity Lists (Organization-wide) */}
          <h2 style={{ marginTop: '40px' }}>最新活动详情 (组织范围)</h2>
          {activityLoading ? (
            <p>正在加载最新活动列表...</p>
          ) : (
            <div className="activity-lists-wrapper">
              <ActivityList 
                title="最新 Pull Requests (PR)" 
                activities={prsData.activities} 
                totalCount={prsData.total_count}
                currentPage={prsData.page}
                onPageChange={handlePrsPageChange}
                type="prs"
              />
              <ActivityList 
                title="最新 Issues" 
                activities={issuesData.activities} 
                totalCount={issuesData.total_count}
                currentPage={issuesData.page}
                onPageChange={handleIssuesPageChange}
                type="issues"
              />
            </div>
          )}
        </>
      )}
      {repos.length === 0 && !loading && !error && <p>未找到任何可监控的重点仓库。请检查数据库配置和数据填充。</p>}
    </div>
  );
}

export default App;
