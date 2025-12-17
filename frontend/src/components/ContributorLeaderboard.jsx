import React, { useEffect, useState } from 'react';
import { getContributorLeaderboard } from '../services/api';
import ContributorDetailModal from './ContributorDetailModal';

const ContributorLeaderboard = ({ range = '30d' }) => {
    const [contributors, setContributors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [metric, setMetric] = useState('total');
    const [selectedContributor, setSelectedContributor] = useState(null);

    useEffect(() => {
        fetchLeaderboard();
    }, [range, metric]);

    const fetchLeaderboard = async () => {
        setLoading(true);
        try {
            const data = await getContributorLeaderboard(range, metric, 20);
            setContributors(data);
        } catch (error) {
            console.error('Failed to fetch contributor leaderboard:', error);
        } finally {
            setLoading(false);
        }
    };

    const metrics = [
        { value: 'total', label: '总活动', icon: '🏆', key: 'total_activities', color: 'text-blue-400' },
        { value: 'prs', label: 'PR', icon: '🔀', key: 'prs_total', color: 'text-purple-400' },
        { value: 'issues', label: 'Issue', icon: '📋', key: 'issues_total', color: 'text-green-400' },
        { value: 'commits', label: 'Commit', icon: '💻', key: 'commits_count', color: 'text-orange-400' }
    ];

    const getCurrentMetric = () => metrics.find(m => m.value === metric) || metrics[0];

    const getMetricValue = (contributor) => {
        const currentMetric = getCurrentMetric();
        return contributor.stats[currentMetric.key] || 0;
    };

    const getRankColor = (index) => {
        if (index === 0) return 'text-yellow-400'; // Gold
        if (index === 1) return 'text-gray-300'; // Silver
        if (index === 2) return 'text-orange-400'; // Bronze
        return 'text-gray-500';
    };

    const getRankIcon = (index) => {
        if (index === 0) return '🥇';
        if (index === 1) return '🥈';
        if (index === 2) return '🥉';
        return `#${index + 1}`;
    };

    if (loading) {
        return (
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <div className="animate-pulse">
                    <div className="h-8 bg-gray-700 rounded w-1/3 mb-4"></div>
                    <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map(i => (
                            <div key={i} className="h-16 bg-gray-700 rounded"></div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    const currentMetric = getCurrentMetric();

    return (
        <>
            <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                <h3 className="text-xl font-bold mb-4 text-white">贡献者排行榜</h3>

                {/* Metric Switcher */}
                <div className="flex gap-2 mb-6 overflow-x-auto">
                    {metrics.map(m => (
                        <button
                            key={m.value}
                            onClick={() => setMetric(m.value)}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap flex items-center gap-2 ${metric === m.value
                                    ? 'bg-blue-600 text-white shadow-lg'
                                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                }`}
                        >
                            <span>{m.icon}</span>
                            <span>{m.label}</span>
                        </button>
                    ))}
                </div>

                {/* Leaderboard */}
                {contributors.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">
                        暂无贡献者数据
                    </div>
                ) : (
                    <div className="space-y-3">
                        {contributors.map((contributor, index) => (
                            <div
                                key={contributor.username}
                                onClick={() => setSelectedContributor(contributor.username)}
                                className={`flex items-center gap-3 p-4 rounded-lg transition-all hover:scale-[1.02] cursor-pointer ${index < 3
                                        ? 'bg-gradient-to-r from-gray-700 to-gray-800 border border-gray-600'
                                        : 'bg-gray-700 hover:bg-gray-600'
                                    }`}
                            >
                                {/* Rank */}
                                <div className={`text-2xl font-bold ${getRankColor(index)} w-12 text-center`}>
                                    {getRankIcon(index)}
                                </div>

                                {/* Avatar */}
                                <img
                                    src={contributor.avatar_url}
                                    alt={contributor.username}
                                    className="w-12 h-12 rounded-full border-2 border-gray-600"
                                    onError={(e) => {
                                        e.target.src = `https://ui-avatars.com/api/?name=${contributor.username}&background=random`;
                                    }}
                                />

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-white truncate flex items-center gap-2">
                                        {contributor.username}
                                        <span className="text-xs text-gray-500">点击查看详情</span>
                                    </div>
                                    <div className="text-sm text-gray-400 flex items-center gap-3">
                                        <span>活跃 {contributor.stats.active_days} 天</span>
                                        <span className="text-purple-400">P:{contributor.stats.prs_total}</span>
                                        <span className="text-green-400">I:{contributor.stats.issues_total}</span>
                                        <span className="text-orange-400">C:{contributor.stats.commits_count}</span>
                                        {contributor.first_seen === contributor.last_seen && (
                                            <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded">
                                                新成员
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Selected Metric Value */}
                                <div className="text-right">
                                    <div className={`text-2xl font-bold ${currentMetric.color}`}>
                                        {getMetricValue(contributor)}
                                    </div>
                                    <div className="text-xs text-gray-500">
                                        {currentMetric.label}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Summary */}
                {contributors.length > 0 && (
                    <div className="mt-6 pt-4 border-t border-gray-700 text-sm text-gray-400 text-center">
                        展示前 {contributors.length} 名贡献者 · 点击查看详细活动
                    </div>
                )}
            </div>

            {/* Detail Modal */}
            {selectedContributor && (
                <ContributorDetailModal
                    username={selectedContributor}
                    range={range}
                    onClose={() => setSelectedContributor(null)}
                />
            )}
        </>
    );
};

export default ContributorLeaderboard;
