import React from 'react';

const GrowthReport = ({ growthData, loading }) => {
    if (loading) {
        return (
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <div className="animate-pulse">
                    <div className="h-8 bg-gray-700 rounded w-1/3 mb-4"></div>
                    <div className="h-32 bg-gray-700 rounded"></div>
                </div>
            </div>
        );
    }

    if (!growthData || !growthData.period) {
        return (
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <p className="text-gray-400">暂无增长数据</p>
            </div>
        );
    }

    const { period, growth } = growthData;

    const getGrowthColor = (value) => {
        if (value > 10) return 'text-green-400';
        if (value > 0) return 'text-green-300';
        if (value < -10) return 'text-red-400';
        if (value < 0) return 'text-red-300';
        return 'text-gray-400';
    };

    const getGrowthBgColor = (value) => {
        if (value > 10) return 'bg-green-400/10 border-green-400/20';
        if (value > 0) return 'bg-green-400/5 border-green-400/10';
        if (value < -10) return 'bg-red-400/10 border-red-400/20';
        if (value < 0) return 'bg-red-400/5 border-red-400/10';
        return 'bg-gray-400/5 border-gray-400/10';
    };

    return (
        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <h2 className="text-xl font-bold mb-6 text-white">增长趋势分析</h2>
            
            {/* Period Comparison Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <PeriodCard 
                    title="当前周期" 
                    period={period.current}
                    highlight={true}
                />
                <PeriodCard 
                    title="上一周期" 
                    period={period.previous}
                    highlight={false}
                />
            </div>
            
            {/* Growth Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <GrowthMetric 
                    label="PR增长" 
                    value={growth.prs}
                    colorClass={getGrowthColor(growth.prs)}
                    bgClass={getGrowthBgColor(growth.prs)}
                />
                <GrowthMetric 
                    label="Issue增长" 
                    value={growth.issues}
                    colorClass={getGrowthColor(growth.issues)}
                    bgClass={getGrowthBgColor(growth.issues)}
                />
                <GrowthMetric 
                    label="Commit增长" 
                    value={growth.commits}
                    colorClass={getGrowthColor(growth.commits)}
                    bgClass={getGrowthBgColor(growth.commits)}
                />
                <GrowthMetric 
                    label="新增代码" 
                    value={growth.lines_added}
                    colorClass={getGrowthColor(growth.lines_added)}
                    bgClass={getGrowthBgColor(growth.lines_added)}
                />
                <GrowthMetric 
                    label="删除代码" 
                    value={growth.lines_deleted}
                    colorClass={getGrowthColor(growth.lines_deleted)}
                    bgClass={getGrowthBgColor(growth.lines_deleted)}
                />
            </div>
        </div>
    );
};

const PeriodCard = ({ title, period, highlight }) => {
    const { start, end, metrics } = period;

    return (
        <div className={`rounded-lg p-4 border ${
            highlight 
                ? 'bg-blue-500/10 border-blue-500/30' 
                : 'bg-gray-700/50 border-gray-600/50'
        }`}>
            <h3 className="text-sm font-semibold mb-2 text-gray-300">{title}</h3>
            <p className="text-xs text-gray-400 mb-3">
                {start} 至 {end}
            </p>
            <div className="space-y-1.5">
                <MetricRow label="PRs" value={metrics.new_prs} />
                <MetricRow label="Issues" value={metrics.new_issues} />
                <MetricRow label="Commits" value={metrics.new_commits} />
                <MetricRow label="新增代码" value={metrics.lines_added} />
                <MetricRow label="删除代码" value={metrics.lines_deleted} />
            </div>
        </div>
    );
};

const MetricRow = ({ label, value }) => (
    <div className="flex justify-between items-center text-sm">
        <span className="text-gray-400">{label}:</span>
        <span className="text-white font-medium">{value?.toLocaleString() || 0}</span>
    </div>
);

const GrowthMetric = ({ label, value, colorClass, bgClass }) => (
    <div className={`rounded-lg p-4 border ${bgClass}`}>
        <div className="text-xs text-gray-400 mb-1">{label}</div>
        <div className={`text-2xl font-bold ${colorClass} flex items-center`}>
            {value > 0 && <span className="mr-1">↑</span>}
            {value < 0 && <span className="mr-1">↓</span>}
            {value === 0 && <span className="mr-1">→</span>}
            {Math.abs(value).toFixed(1)}%
        </div>
    </div>
);

export default GrowthReport;

