import React, { useEffect, useState } from 'react';
import { getContributorStats } from '../services/api';

const ContributorStats = ({ range = '30d' }) => {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchStats();
    }, [range]);

    const fetchStats = async () => {
        setLoading(true);
        try {
            const data = await getContributorStats(range);
            setStats(data);
        } catch (error) {
            console.error('Failed to fetch contributor stats:', error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {[1, 2, 3].map(i => (
                    <div key={i} className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                        <div className="animate-pulse">
                            <div className="h-4 bg-gray-700 rounded w-2/3 mb-4"></div>
                            <div className="h-8 bg-gray-700 rounded w-1/2"></div>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!stats) {
        return null;
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Unique Contributors */}
            <StatCard
                title="独立贡献者"
                value={stats.unique_contributors}
                icon="👥"
                color="blue"
                subtitle="去重统计"
            />

            {/* New Contributors */}
            <StatCard
                title="新贡献者"
                value={stats.new_contributors}
                icon="🎉"
                color="green"
                subtitle="首次参与"
            />

            {/* Retention Rate - show active days per contributor */}
            <StatCard
                title="贡献者活跃度"
                value={stats.unique_contributors > 0
                    ? Math.round((stats.most_active_day?.contributor_count || 0) / stats.unique_contributors * 100)
                    : 0}
                icon="📊"
                color="orange"
                subtitle="日均活跃率 %"
            />
        </div>
    );
};

const StatCard = ({ title, value, icon, color, subtitle }) => {
    const colorClasses = {
        blue: 'text-blue-400 bg-blue-400/10',
        green: 'text-green-400 bg-green-400/10',
        orange: 'text-orange-400 bg-orange-400/10',
        purple: 'text-purple-400 bg-purple-400/10',
    };

    return (
        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 shadow-lg hover:border-gray-600 transition-all">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-gray-400 text-sm font-medium">{title}</h3>
                <span className={`p-3 rounded-lg text-2xl ${colorClasses[color]}`}>{icon}</span>
            </div>
            <div className="text-3xl font-bold text-white mb-1">
                {value?.toLocaleString() || 0}
            </div>
            {subtitle && (
                <div className="text-xs text-gray-500">{subtitle}</div>
            )}
        </div>
    );
};

export default ContributorStats;

