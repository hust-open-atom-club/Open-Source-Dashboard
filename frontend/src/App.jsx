import React, { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import ReactECharts from 'echarts-for-react';
import './index.css'; // Import the basic styles

const API_BASE_URL = 'http://localhost:3000/api/v1'; // Should be configured via Vite env
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

function App() {
  const [organizations, setOrganizations] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [timeseriesData, setTimeseriesData] = useState([]);
  
  // State for PRs
  const [prsData, setPrsData] = useState({ activities: [], total_count: 0, page: 1 });
  // State for Issues
  const [issuesData, setIssuesData] = useState({ activities: [], total_count: 0, page: 1 });

  const [loading, setLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [error, setError] = useState(null);

  // Function to fetch activities with pagination
  const fetchActivities = useCallback(async (orgName, type, page) => {
    if (!orgName) return;
    
    const params = {
      type: type,
      page: page,
      per_page: ITEMS_PER_PAGE,
    };

    try {
      const response = await axios.get(`${API_BASE_URL}/organizations/${orgName}/latest-activity`, { params });
      return response.data;
    } catch (err) {
      console.error(`Error fetching latest ${type} activities:`, err);
      return { activities: [], total_count: 0, page: 1 };
    }
  }, []);

  // Fetch list of monitored organizations on component mount
  useEffect(() => {
    const fetchOrganizations = async () => {
      try {
        const response = await axios.get(`${API_BASE_URL}/organizations`);
        setOrganizations(response.data);
        if (response.data.length > 0) {
          setSelectedOrg(response.data[0]); // Select the first organization by default
        }
      } catch (err) {
        console.error('Error fetching organizations:', err);
        setError('无法加载组织列表。请确保后端服务已运行。');
      }
    };
    fetchOrganizations();
  }, []);

  // Fetch timeseries data when selectedOrg changes
  useEffect(() => {
    if (!selectedOrg) return;

    const fetchTimeseries = async () => {
      setLoading(true);
      setError(null);
      try {
        // Default range is 30 days as per requirement
        const response = await axios.get(`${API_BASE_URL}/organizations/${selectedOrg}/timeseries?range=30d`);
        setTimeseriesData(response.data);
      } catch (err) {
        console.error('Error fetching timeseries data:', err);
        if (err.response && err.response.status === 403) {
            setError(`组织 "${selectedOrg}" 未被监控或访问被拒绝 (403)。`);
        } else {
            setError('加载时间序列数据失败。');
        }
        setTimeseriesData([]);
      } finally {
        setLoading(false);
      }
    };
    fetchTimeseries();
    
    // Reset activity pages and fetch first page when organization changes
    setPrsData(prev => ({ ...prev, page: 1 }));
    setIssuesData(prev => ({ ...prev, page: 1 }));
    
  }, [selectedOrg]);

  // Fetch latest activities (PRs and Issues) when selectedOrg or page changes
  useEffect(() => {
    if (!selectedOrg) return;

    const loadActivities = async () => {
      setActivityLoading(true);
      
      // Fetch PRs for current page
      const prsResult = await fetchActivities(selectedOrg, 'prs', prsData.page);
      setPrsData(prev => ({ ...prev, activities: prsResult.activities, total_count: prsResult.total_count, per_page: prsResult.per_page }));

      // Fetch Issues for current page
      const issuesResult = await fetchActivities(selectedOrg, 'issues', issuesData.page);
      setIssuesData(prev => ({ ...prev, activities: issuesResult.activities, total_count: issuesResult.total_count, per_page: issuesResult.per_page }));

      setActivityLoading(false);
    };
    
    loadActivities();
  }, [selectedOrg, prsData.page, issuesData.page, fetchActivities]); // Dependency on page state

  // Handlers for page change
  const handlePrsPageChange = (newPage) => {
    setPrsData(prev => ({ ...prev, page: newPage }));
  };

  const handleIssuesPageChange = (newPage) => {
    setIssuesData(prev => ({ ...prev, page: newPage }));
  };

  // Extract the latest snapshot data for the data cards
  const latestSnapshot = useMemo(() => {
    if (timeseriesData.length === 0) return null;
    // Data is sorted by date ASC from the backend, so the last element is the latest
    return timeseriesData[timeseriesData.length - 1];
  }, [timeseriesData]);

  // ECharts configuration (unchanged)
  const chartOptions = useMemo(() => {
    if (timeseriesData.length === 0) {
      return {};
    }

    const dates = timeseriesData.map(d => d.date);
    const newPrs = timeseriesData.map(d => d.new_prs);
    const closedMergedPrs = timeseriesData.map(d => d.closed_merged_prs);
    const newIssues = timeseriesData.map(d => d.new_issues);
    const closedIssues = timeseriesData.map(d => d.closed_issues);

    return {
      title: {
        text: `${selectedOrg} 社区活动趋势 (近 30 天)`,
        left: 'center',
        textStyle: {
            color: '#fff'
        }
      },
      tooltip: {
        trigger: 'axis'
      },
      legend: {
        data: ['新增 PR', '合并 PR', '新增 Issue', '关闭 Issue'],
        top: 30,
        textStyle: {
            color: '#ccc'
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: dates,
        axisLabel: {
            color: '#ccc'
        }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
            color: '#ccc'
        }
      },
      series: [
        {
          name: '新增 PR',
          type: 'line',
          data: newPrs,
          smooth: true,
          lineStyle: { color: '#646cff' }
        },
        {
          name: '合并 PR',
          type: 'line',
          data: closedMergedPrs,
          smooth: true,
          lineStyle: { color: '#4CAF50' }
        },
        {
          name: '新增 Issue',
          type: 'line',
          data: newIssues,
          smooth: true,
          lineStyle: { color: '#FFC107' }
        },
        {
          name: '关闭 Issue',
          type: 'line',
          data: closedIssues,
          smooth: true,
          lineStyle: { color: '#F44336' }
        }
      ]
    };
  }, [timeseriesData, selectedOrg]);

  const handleOrgChange = (event) => {
    setSelectedOrg(event.target.value);
  };

  return (
    <div className="App">
      <h1>OSS 社区活动仪表板</h1>

      {/* 1. Organization Selector */}
      <select value={selectedOrg} onChange={handleOrgChange} disabled={organizations.length === 0 || loading}>
        <option value="" disabled>请选择一个组织</option>
        {organizations.map(org => (
          <option key={org} value={org}>{org}</option>
        ))}
      </select>

      {error && <p style={{ color: 'red' }}>错误: {error}</p>}
      {loading && <p>正在加载时间序列数据...</p>}

      {latestSnapshot && (
        <>
          <h2>{selectedOrg} 最新活动快照 ({latestSnapshot.date})</h2>
          {/* 2. Data Cards */}
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
              <h3>新增仓库</h3>
              <p>{latestSnapshot.new_repos}</p>
            </div>
          </div>

          {/* 3. Chart Area */}
          <div className="chart-area">
            <ReactECharts option={chartOptions} style={{ height: '100%', width: '100%' }} />
          </div>

          {/* 4. Latest Activity Lists */}
          <h2 style={{ marginTop: '40px' }}>最新活动详情 (实时)</h2>
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
      {!selectedOrg && organizations.length > 0 && <p>请从下拉菜单中选择一个组织以查看数据。</p>}
      {organizations.length === 0 && !loading && !error && <p>未找到任何可监控的组织。请检查数据库配置和数据填充。</p>}
    </div>
  );
}

export default App;
