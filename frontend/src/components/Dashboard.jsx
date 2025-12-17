import React, { useEffect, useState } from 'react';
import {
    getOrgSummary,
    getAggregatedTimeseries,
    getSigAggregatedTimeseries,
    getOrgSigs,
    compareSigs,
    getGrowthAnalysis
} from '../services/api';
import TrendChart from './charts/TrendChart';
import SIGComparisonChart from './charts/SIGComparisonChart';
import ViewSwitcher from './ViewSwitcher';
import MultiSIGComparisonChart from './MultiSIGComparisonChart';
import GrowthReport from './GrowthReport';
import ExportMenu from './ExportMenu';
import LoadingSkeleton from './LoadingSkeleton';
import ContributorLeaderboard from './ContributorLeaderboard';
import ContributorStats from './ContributorStats';
import DayDetailModal from './DayDetailModal';
import SIGContributorModal from './SIGContributorModal';
import { useToast, ToastContainer } from './Toast';

const Dashboard = () => {
    const [loading, setLoading] = useState(true);
    const [summary, setSummary] = useState(null);
    const [timeseries, setTimeseries] = useState([]);
    const [sigData, setSigData] = useState([]);
    const [allSigs, setAllSigs] = useState([]);
    const [range, setRange] = useState('30d');
    const [granularity, setGranularity] = useState('day');
    const [growthData, setGrowthData] = useState(null);
    const [growthLoading, setGrowthLoading] = useState(false);
    const [selectedSigIds, setSelectedSigIds] = useState([]);
    const [comparisonData, setComparisonData] = useState([]);
    const { toasts, addToast, removeToast } = useToast();

    // Modal states
    const [selectedDate, setSelectedDate] = useState(null);
    const [selectedDateChartType, setSelectedDateChartType] = useState('prs');
    const [selectedSig, setSelectedSig] = useState(null);

    // SIG chart metric
    const [sigMetric, setSigMetric] = useState('prs');
    const sigMetrics = [
        { key: 'prs', label: 'PRs', name: 'Pull Requests', color: '#8b5cf6' },
        { key: 'issues', label: 'Issues', name: '议题', color: '#f59e0b' },
        { key: 'commits', label: 'Commits', name: '提交', color: '#10b981' }
    ];

    useEffect(() => {
        fetchAllData();
    }, [range, granularity]);

    useEffect(() => {
        if (selectedSigIds.length > 0) {
            fetchComparisonData();
        }
    }, [selectedSigIds, range, granularity]);

    const fetchAllData = async () => {
        setLoading(true);
        try {
            // 1. Fetch Org Summary, Aggregated Timeseries, and SIGs
            const [summaryRes, timeseriesRes, sigsRes] = await Promise.all([
                getOrgSummary(range),
                getAggregatedTimeseries(range, granularity),
                getOrgSigs()
            ]);

            setSummary(summaryRes);
            setTimeseries(timeseriesRes);
            setAllSigs(sigsRes);

            // 自动选择所有 SIG 进行对比
            const allSigIds = sigsRes.map(sig => sig.id);
            setSelectedSigIds(allSigIds);

            // 2. Fetch basic SIG data for comparison chart
            const sigPromises = sigsRes.map(async (sig) => {
                try {
                    // 修复：使用 SIG 级别的 API，而不是组织级别
                    const ts = await getSigAggregatedTimeseries(sig.id, range, granularity);
                    const totalPrs = ts.reduce((acc, curr) => acc + (curr.new_prs || 0), 0);
                    const totalCommits = ts.reduce((acc, curr) => acc + (curr.new_commits || 0), 0);
                    const totalIssues = ts.reduce((acc, curr) => acc + (curr.new_issues || 0), 0);
                    const totalActivity = ts.reduce((acc, curr) => acc + (curr.active_contributors || 0), 0);

                    return {
                        name: sig.name,
                        id: sig.id,
                        prs: totalPrs,
                        commits: totalCommits,
                        issues: totalIssues,
                        activity: totalActivity
                    };
                } catch (error) {
                    console.error(`Error fetching SIG ${sig.name}:`, error);
                    return {
                        name: sig.name,
                        id: sig.id,
                        prs: 0,
                        commits: 0,
                        issues: 0,
                        activity: 0
                    };
                }
            });

            const sigsData = await Promise.all(sigPromises);
            setSigData(sigsData);

            // 3. Fetch growth analysis
            fetchGrowthData();

            addToast('数据加载成功', 'success');
        } catch (error) {
            console.error("Failed to load dashboard data", error);
            addToast('数据加载失败：' + error.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    const fetchGrowthData = async () => {
        setGrowthLoading(true);
        try {
            const growth = await getGrowthAnalysis('org', null, range);
            setGrowthData(growth);
        } catch (error) {
            console.error("Failed to load growth data", error);
        } finally {
            setGrowthLoading(false);
        }
    };

    const fetchComparisonData = async () => {
        try {
            const data = await compareSigs(selectedSigIds, range, granularity);
            setComparisonData(data);
        } catch (error) {
            console.error("Failed to load comparison data", error);
            addToast('对比数据加载失败', 'error');
        }
    };

    const handleRefresh = () => {
        addToast('正在刷新数据...', 'info', 1000);
        fetchAllData();
    };

    // Chart click handlers
    const handlePRIssueChartClick = (date) => {
        setSelectedDateChartType('prs');
        setSelectedDate(date);
    };

    const handleCommitChartClick = (date) => {
        setSelectedDateChartType('commits');
        setSelectedDate(date);
    };

    const handleContributorChartClick = (date) => {
        setSelectedDateChartType('contributors');
        setSelectedDate(date);
    };

    const handleSigClick = (sigId, sigName) => {
        setSelectedSig({ id: sigId, name: sigName });
    };

    if (loading) {
        return <LoadingSkeleton />;
    }

    return (
        <div className="min-h-screen bg-gray-900 text-white p-8 font-sans">
            {/* Toast Container */}
            <ToastContainer toasts={toasts} removeToast={removeToast} />

            {/* Day Detail Modal */}
            {selectedDate && (
                <DayDetailModal
                    date={selectedDate}
                    chartType={selectedDateChartType}
                    onClose={() => setSelectedDate(null)}
                />
            )}

            {/* SIG Contributor Modal */}
            {selectedSig && (
                <SIGContributorModal
                    sigId={selectedSig.id}
                    sigName={selectedSig.name}
                    range={range}
                    onClose={() => setSelectedSig(null)}
                />
            )}

            {/* Header */}
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-600">
                        Community Insights
                    </h1>
                    <p className="text-gray-400 mt-1">Real-time analytics for Open Atom Club</p>
                </div>
                <div className="flex items-center gap-4">
                    <ViewSwitcher
                        view={granularity}
                        onViewChange={setGranularity}
                        range={range}
                        onRangeChange={setRange}
                    />
                    <button
                        onClick={handleRefresh}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        刷新
                    </button>
                    <ExportMenu
                        type="org"
                        range={range}
                        granularity={granularity}
                        summary={summary}
                        growthData={growthData}
                        sigData={sigData}
                        timeseries={timeseries}
                    />
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <SummaryCard title="新 Pull Requests" value={summary?.new_prs} icon="🔀" color="blue" />
                <SummaryCard title="已合并 PRs" value={summary?.closed_merged_prs} icon="✅" color="green" />
                <SummaryCard title="新 Commits" value={summary?.new_commits} icon="💻" color="orange" />
                <SummaryCard title="活跃贡献者" value={summary?.active_contributors || "N/A"} subtext="(唯一)" icon="👥" color="purple" />
            </div>

            {/* Growth Report */}
            <div className="mb-8">
                <GrowthReport growthData={growthData} loading={growthLoading} />
            </div>

            {/* Main Charts Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                {/* Monthly Trends: PRs & Issues */}
                <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl h-96">
                    <TrendChart
                        title={`Contribution Trends (PRs & Issues) - ${granularity === 'day' ? '日' : granularity === 'week' ? '周' : '月'}视图`}
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: 'New PRs', data: timeseries.map(t => t.new_prs) },
                            { name: 'New Issues', data: timeseries.map(t => t.new_issues) }
                        ]}
                        colors={['#3b82f6', '#f59e0b']}
                        onDayClick={granularity === 'day' ? handlePRIssueChartClick : undefined}
                    />
                </div>

                {/* Monthly Trends: Commits */}
                <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl h-96">
                    <TrendChart
                        title={`Code Activity (Commits) - ${granularity === 'day' ? '日' : granularity === 'week' ? '周' : '月'}视图`}
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: 'Commits', data: timeseries.map(t => t.new_commits) }
                        ]}
                        colors={['#10b981']}
                        onDayClick={granularity === 'day' ? handleCommitChartClick : undefined}
                    />
                </div>
            </div>

            {/* Multi-SIG Comparison Chart */}
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl mb-8" style={{ height: '500px' }}>
                <h3 className="text-lg font-semibold mb-4">多 SIG 趋势对比</h3>
                <MultiSIGComparisonChart
                    sigs={comparisonData}
                    selectedSigIds={selectedSigIds}
                    onSigSelectionChange={setSelectedSigIds}
                    range={range}
                    granularity={granularity}
                />
            </div>

            {/* Secondary Charts Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                {/* SIG Comparison: Activity */}
                <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl h-96 flex flex-col">
                    {/* SIG Metric Switcher */}
                    <div className="flex gap-2 mb-4">
                        {sigMetrics.map(m => (
                            <button
                                key={m.key}
                                onClick={() => setSigMetric(m.key)}
                                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${sigMetric === m.key
                                    ? 'bg-blue-600 text-white shadow-lg'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                    }`}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex-1">
                        <SIGComparisonChart
                            title={`SIG Leaderboard (${sigMetrics.find(m => m.key === sigMetric)?.name})`}
                            data={sigData}
                            metricKey={sigMetric}
                            metricName={sigMetrics.find(m => m.key === sigMetric)?.name}
                            color={sigMetrics.find(m => m.key === sigMetric)?.color}
                            onSigClick={handleSigClick}
                        />
                    </div>
                </div>

                {/* Active Contributors Trend */}
                <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl h-96">
                    <TrendChart
                        title="Active Contributors Trend"
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: 'Active Contributors', data: timeseries.map(t => t.active_contributors) }
                        ]}
                        colors={['#ec4899']}
                        onDayClick={granularity === 'day' ? handleContributorChartClick : undefined}
                    />
                </div>
            </div>

            {/* Contributor Section */}
            <div className="mb-8">
                <h2 className="text-2xl font-bold mb-6 text-white">贡献者分析</h2>

                {/* Contributor Stats Cards */}
                <div className="mb-8">
                    <ContributorStats range={range} />
                </div>

                {/* Contributor Leaderboard */}
                <ContributorLeaderboard range={range} />
            </div>
        </div>
    );
};

const SummaryCard = ({ title, value, icon, color, subtext }) => {
    const colorClasses = {
        blue: 'text-blue-400 bg-blue-400/10',
        green: 'text-green-400 bg-green-400/10',
        purple: 'text-purple-400 bg-purple-400/10',
        orange: 'text-orange-400 bg-orange-400/10',
    };

    return (
        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-lg hover:border-gray-600 transition-all">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-gray-400 text-sm font-medium">{title}</h3>
                <span className={`p-2 rounded-lg ${colorClasses[color]}`}>{icon}</span>
            </div>
            <div className="flex items-end items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{value?.toLocaleString()}</span>
                {subtext && <span className="text-xs text-gray-500">{subtext}</span>}
            </div>
        </div>
    );
};

export default Dashboard;
