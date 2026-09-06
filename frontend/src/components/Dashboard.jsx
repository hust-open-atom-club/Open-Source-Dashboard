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
        { key: 'prs', label: 'PR', name: 'PR', color: '#8b5cf6' },
        { key: 'issues', label: 'Issue', name: 'Issue', color: '#f59e0b' },
        { key: 'commits', label: 'Commit', name: 'Commit', color: '#10b981' }
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
        <div className="min-h-screen bg-gray-900 text-white p-4 font-sans md:p-8">
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
            <div className="flex flex-col xl:flex-row xl:justify-between xl:items-center gap-6 mb-8">
                <div className="flex items-center gap-4">
                    <img
                        src="/hust-open-atom-club-logo.svg"
                        alt=""
                        className="w-16 h-16 shrink-0 rounded-full shadow-lg shadow-blue-950/40"
                    />
                    <div>
                        <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-600">
                            华科开放原子开源俱乐部
                        </h1>
                        <p className="text-lg text-gray-400 mt-1">开源贡献数据看板</p>
                    </div>
                </div>
                <div className="flex w-full flex-wrap items-center gap-4 xl:w-auto xl:justify-end">
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

            {/* Club introduction */}
            <section className="relative overflow-hidden rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-950/80 via-gray-800 to-purple-950/60 p-6 md:p-8 mb-8 shadow-2xl shadow-blue-950/20">
                <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-blue-500/10 blur-3xl" aria-hidden="true"></div>
                <div className="absolute -bottom-28 right-1/3 h-56 w-56 rounded-full bg-purple-500/10 blur-3xl" aria-hidden="true"></div>
                <div className="relative grid gap-8 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:items-center">
                    <div>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-blue-300">HUST Open Atom Club</p>
                        <h2 className="max-w-3xl text-2xl font-bold leading-tight text-white md:text-4xl">让每一次开源贡献，都被看见</h2>
                        <p className="mt-4 max-w-2xl leading-7 text-gray-300">
                            我们是由华中科技大学师生与开源爱好者共同建设的开源社区。
                            看板聚合俱乐部各 SIG 的公开协作数据，记录我们一起写下的 Commit、PR 和 Issue。
                        </p>
                        <div className="mt-5 flex flex-wrap gap-2" aria-label="俱乐部价值观">
                            {['开放', '共享', '协同', '贡献'].map(value => (
                                <span key={value} className="rounded-full border border-blue-400/25 bg-blue-400/10 px-3 py-1 text-sm text-blue-100">{value}</span>
                            ))}
                        </div>
                        <div className="mt-6 flex flex-wrap gap-3">
                            <a
                                href="https://github.com/hust-open-atom-club"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
                            >
                                访问 GitHub 组织 <span className="ml-2" aria-hidden="true">↗</span>
                            </a>
                            <a
                                href="#contribution-overview"
                                className="inline-flex items-center rounded-lg border border-gray-600 bg-gray-800/70 px-4 py-2.5 text-sm font-semibold text-gray-100 transition-colors hover:border-gray-500 hover:bg-gray-700"
                            >
                                浏览贡献数据 <span className="ml-2" aria-hidden="true">↓</span>
                            </a>
                        </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-gray-950/35 p-5 backdrop-blur-sm md:p-7">
                        <p className="text-base font-semibold text-gray-100">看板范围</p>
                        <div className="mt-5 grid grid-cols-3 gap-3 md:gap-4">
                            <ScopeStat label="纳入统计" value={summary?.tracked_repositories} unit="个仓库" />
                            <ScopeStat label="组织仓库" value={summary?.organization_repositories} unit="个仓库" />
                            <ScopeStat label="技术小组" value={allSigs.length} unit="个 SIG" />
                        </div>
                        <p className="mt-5 border-t border-white/10 pt-5 text-sm leading-6 text-gray-400">
                            统计范围以 GitHub 仓库的 <code className="text-blue-300">osd_sig</code> 属性为准。
                            标记为 <code className="text-gray-300">untracked</code> 的仓库以及纯 Fork 仓库不进入数据汇总。
                            看板默认每 6 小时更新一次。
                        </p>
                    </div>
                </div>
            </section>

            {/* Summary Cards */}
            <div id="contribution-overview" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 scroll-mt-6">
                <SummaryCard title="新建 PR" value={summary?.new_prs} icon="🔀" color="blue" />
                <SummaryCard title="已合并 PR" value={summary?.closed_merged_prs} icon="✅" color="green" />
                <SummaryCard title="新增 Commit" value={summary?.new_commits} icon="💻" color="orange" />
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
                        title={`贡献趋势（PR 与 Issue）· ${granularity === 'day' ? '日' : granularity === 'week' ? '周' : '月'}视图`}
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: '新建 PR', data: timeseries.map(t => t.new_prs) },
                            { name: '新建 Issue', data: timeseries.map(t => t.new_issues) }
                        ]}
                        colors={['#3b82f6', '#f59e0b']}
                        onDayClick={granularity === 'day' ? handlePRIssueChartClick : undefined}
                    />
                </div>

                {/* Monthly Trends: Commits */}
                <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-xl h-96">
                    <TrendChart
                        title={`Commit 趋势 · ${granularity === 'day' ? '日' : granularity === 'week' ? '周' : '月'}视图`}
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: 'Commit', data: timeseries.map(t => t.new_commits) }
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
                            title={`SIG 排行（${sigMetrics.find(m => m.key === sigMetric)?.name}）`}
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
                        title="活跃贡献者趋势"
                        xAxisData={timeseries.map(t => t.date)}
                        seriesData={[
                            { name: '活跃贡献者', data: timeseries.map(t => t.active_contributors) }
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

            <footer className="mt-12 border-t border-gray-800 py-8 text-sm text-gray-400">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                        <p className="font-medium text-gray-200">华科开放原子开源俱乐部</p>
                        <p className="mt-1">开放 · 共享 · 协同 · 贡献</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <span>数据来源：GitHub GraphQL API</span>
                        <a className="text-blue-300 hover:text-blue-200" href="https://github.com/hust-open-atom-club" target="_blank" rel="noreferrer">
                            GitHub 组织 ↗
                        </a>
                        <span>© {new Date().getFullYear()} HUST Open Atom Club</span>
                    </div>
                </div>
            </footer>
        </div>
    );
};

const ScopeStat = ({ label, value, unit }) => (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3 md:p-4">
        <div className="text-xs font-medium text-gray-300 md:text-sm">{label}</div>
        <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-white md:text-3xl">{value?.toLocaleString() ?? '—'}</span>
            <span className="text-xs text-gray-500">{unit}</span>
        </div>
    </div>
);

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
