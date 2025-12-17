import React, { useEffect, useState } from 'react';
import { getContributorDetails } from '../services/api';

const ContributorDetailModal = ({ username, range, onClose }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (username) {
            fetchDetails();
        }
    }, [username, range]);

    const fetchDetails = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await getContributorDetails(username, range);
            setData(result);
        } catch (err) {
            setError('无法加载贡献者详情');
            console.error('Failed to fetch contributor details:', err);
        } finally {
            setLoading(false);
        }
    };

    // Handle escape key
    useEffect(() => {
        const handleEscape = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    // Calculate summary stats
    const getSummary = () => {
        if (!data?.activities) return { prs: 0, issues: 0, commits: 0 };
        return data.activities.reduce((acc, day) => ({
            prs: acc.prs + (day.prs_opened || 0) + (day.prs_closed || 0),
            issues: acc.issues + (day.issues_opened || 0) + (day.issues_closed || 0),
            commits: acc.commits + (day.commits_count || 0)
        }), { prs: 0, issues: 0, commits: 0 });
    };

    const summary = getSummary();

    return (
        <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                className="bg-gray-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden border border-gray-700 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-gray-700">
                    <div className="flex items-center gap-4">
                        {data?.contributor?.avatar_url && (
                            <img
                                src={data.contributor.avatar_url}
                                alt={username}
                                className="w-16 h-16 rounded-full border-2 border-blue-500"
                            />
                        )}
                        <div>
                            <h2 className="text-2xl font-bold text-white">{username}</h2>
                            {data?.contributor && (
                                <p className="text-sm text-gray-400">
                                    首次活动: {data.contributor.first_seen} · 最近活动: {data.contributor.last_seen}
                                </p>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-gray-400 hover:text-white p-2 hover:bg-gray-700 rounded-lg transition-colors"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                        </div>
                    ) : error ? (
                        <div className="text-center py-12 text-red-400">{error}</div>
                    ) : (
                        <div className="space-y-6">
                            {/* Summary Stats */}
                            <div className="grid grid-cols-3 gap-4">
                                <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/10 p-4 rounded-xl border border-purple-500/30">
                                    <div className="text-3xl font-bold text-purple-400">{summary.prs}</div>
                                    <div className="text-sm text-gray-400">Pull Requests</div>
                                </div>
                                <div className="bg-gradient-to-br from-green-500/20 to-green-600/10 p-4 rounded-xl border border-green-500/30">
                                    <div className="text-3xl font-bold text-green-400">{summary.issues}</div>
                                    <div className="text-sm text-gray-400">Issues</div>
                                </div>
                                <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/10 p-4 rounded-xl border border-blue-500/30">
                                    <div className="text-3xl font-bold text-blue-400">{summary.commits}</div>
                                    <div className="text-sm text-gray-400">Commits</div>
                                </div>
                            </div>

                            {/* Active Repositories */}
                            {data?.active_repos?.length > 0 && (
                                <div>
                                    <h3 className="text-lg font-semibold text-white mb-3">活跃仓库</h3>
                                    <div className="space-y-2">
                                        {data.active_repos.slice(0, 10).map((repo, idx) => (
                                            <div
                                                key={repo.id}
                                                className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg hover:bg-gray-700 transition-colors"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <span className="text-gray-500 w-6">{idx + 1}.</span>
                                                    <span className="text-white font-medium">{repo.name}</span>
                                                </div>
                                                <span className="text-blue-400 font-semibold">
                                                    {repo.total_activities} 活动
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Activity Timeline */}
                            {data?.activities?.length > 0 && (
                                <div>
                                    <h3 className="text-lg font-semibold text-white mb-3">活动时间线</h3>
                                    <div className="space-y-2 max-h-64 overflow-y-auto">
                                        {data.activities
                                            .filter(a => a.prs_opened || a.prs_closed || a.issues_opened || a.issues_closed || a.commits_count)
                                            .reverse()
                                            .map((activity, idx) => (
                                                <div
                                                    key={idx}
                                                    className="flex items-center justify-between p-3 bg-gray-700/30 rounded-lg text-sm"
                                                >
                                                    <span className="text-gray-400 font-mono">{activity.date}</span>
                                                    <div className="flex gap-4">
                                                        {(activity.prs_opened > 0 || activity.prs_closed > 0) && (
                                                            <span className="text-purple-400">
                                                                🔀 {activity.prs_opened + activity.prs_closed} PR
                                                            </span>
                                                        )}
                                                        {(activity.issues_opened > 0 || activity.issues_closed > 0) && (
                                                            <span className="text-green-400">
                                                                📋 {activity.issues_opened + activity.issues_closed} Issue
                                                            </span>
                                                        )}
                                                        {activity.commits_count > 0 && (
                                                            <span className="text-blue-400">
                                                                💻 {activity.commits_count} Commit
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-700 flex justify-between items-center">
                    <a
                        href={`https://github.com/${username}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                        </svg>
                        查看 GitHub 主页
                    </a>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
                    >
                        关闭
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ContributorDetailModal;
