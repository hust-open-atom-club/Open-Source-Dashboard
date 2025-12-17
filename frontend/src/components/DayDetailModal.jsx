import React, { useEffect, useState } from 'react';
import { getDayDetails } from '../services/api';

const DayDetailModal = ({ date, chartType = 'prs', onClose }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState(chartType === 'commits' ? 'commits' : 'prs');

    useEffect(() => {
        if (date) {
            fetchDetails();
        }
    }, [date]);

    const fetchDetails = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await getDayDetails(date);
            setData(result);
        } catch (err) {
            setError('无法加载详情');
            console.error('Failed to fetch day details:', err);
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

    const tabs = [
        { id: 'prs', label: 'Pull Requests', icon: '🔀', color: 'text-purple-400' },
        { id: 'issues', label: 'Issues', icon: '📋', color: 'text-green-400' },
        { id: 'commits', label: 'Commits', icon: '💻', color: 'text-blue-400' },
        { id: 'contributors', label: '贡献者', icon: '👥', color: 'text-orange-400' }
    ];

    return (
        <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                className="bg-gray-800 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden border border-gray-700 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-gray-700">
                    <div>
                        <h2 className="text-2xl font-bold text-white">{date}</h2>
                        <p className="text-sm text-gray-400">日活动详情</p>
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

                {/* Summary Stats */}
                {data?.summary && (
                    <div className="grid grid-cols-4 gap-4 p-6 bg-gray-800/50">
                        <div className="text-center">
                            <div className="text-2xl font-bold text-purple-400">{data.summary.new_prs}</div>
                            <div className="text-xs text-gray-400">New PRs</div>
                        </div>
                        <div className="text-center">
                            <div className="text-2xl font-bold text-green-400">{data.summary.new_issues}</div>
                            <div className="text-xs text-gray-400">New Issues</div>
                        </div>
                        <div className="text-center">
                            <div className="text-2xl font-bold text-blue-400">{data.summary.new_commits}</div>
                            <div className="text-xs text-gray-400">Commits</div>
                        </div>
                        <div className="text-center">
                            <div className="text-2xl font-bold text-orange-400">{data.summary.active_contributors}</div>
                            <div className="text-xs text-gray-400">贡献者</div>
                        </div>
                    </div>
                )}

                {/* Tabs */}
                <div className="flex border-b border-gray-700">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex-1 py-3 px-4 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${activeTab === tab.id
                                    ? 'bg-gray-700 text-white border-b-2 border-blue-500'
                                    : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                                }`}
                        >
                            <span>{tab.icon}</span>
                            <span className="hidden sm:inline">{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto max-h-[calc(90vh-320px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                        </div>
                    ) : error ? (
                        <div className="text-center py-12 text-red-400">{error}</div>
                    ) : (
                        <>
                            {/* PRs Tab */}
                            {activeTab === 'prs' && (
                                <div className="space-y-3">
                                    <h3 className="text-lg font-semibold text-white mb-4">仓库 PR 活动</h3>
                                    {data?.repos?.filter(r => r.prs.opened > 0 || r.prs.closed > 0).length > 0 ? (
                                        data.repos.filter(r => r.prs.opened > 0 || r.prs.closed > 0).map((repo, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg">
                                                <span className="text-white font-medium">{repo.name}</span>
                                                <div className="flex gap-4 text-sm">
                                                    <span className="text-green-400">+{repo.prs.opened} opened</span>
                                                    <span className="text-purple-400">✓{repo.prs.closed} merged</span>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-8 text-gray-500">当天无 PR 活动</div>
                                    )}
                                </div>
                            )}

                            {/* Issues Tab */}
                            {activeTab === 'issues' && (
                                <div className="space-y-3">
                                    <h3 className="text-lg font-semibold text-white mb-4">仓库 Issue 活动</h3>
                                    {data?.repos?.filter(r => r.issues.opened > 0 || r.issues.closed > 0).length > 0 ? (
                                        data.repos.filter(r => r.issues.opened > 0 || r.issues.closed > 0).map((repo, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg">
                                                <span className="text-white font-medium">{repo.name}</span>
                                                <div className="flex gap-4 text-sm">
                                                    <span className="text-yellow-400">+{repo.issues.opened} opened</span>
                                                    <span className="text-green-400">✓{repo.issues.closed} closed</span>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-8 text-gray-500">当天无 Issue 活动</div>
                                    )}
                                </div>
                            )}

                            {/* Commits Tab */}
                            {activeTab === 'commits' && (
                                <div className="space-y-3">
                                    <h3 className="text-lg font-semibold text-white mb-4">仓库 Commit 活动</h3>
                                    {data?.repos?.filter(r => r.commits > 0).length > 0 ? (
                                        data.repos.filter(r => r.commits > 0).map((repo, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-3 bg-gray-700/50 rounded-lg">
                                                <span className="text-white font-medium">{repo.name}</span>
                                                <span className="text-blue-400 font-semibold">{repo.commits} commits</span>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-8 text-gray-500">当天无 Commit</div>
                                    )}
                                </div>
                            )}

                            {/* Contributors Tab */}
                            {activeTab === 'contributors' && (
                                <div className="space-y-3">
                                    <h3 className="text-lg font-semibold text-white mb-4">活跃贡献者</h3>
                                    {data?.contributors?.length > 0 ? (
                                        data.contributors.map((contributor, idx) => (
                                            <div key={idx} className="flex items-center gap-3 p-3 bg-gray-700/50 rounded-lg">
                                                <img
                                                    src={contributor.avatar_url}
                                                    alt={contributor.username}
                                                    className="w-10 h-10 rounded-full border border-gray-600"
                                                    onError={(e) => {
                                                        e.target.src = `https://ui-avatars.com/api/?name=${contributor.username}&background=random`;
                                                    }}
                                                />
                                                <div className="flex-1">
                                                    <div className="font-medium text-white">{contributor.username}</div>
                                                </div>
                                                <div className="flex gap-3 text-sm">
                                                    {(contributor.prs.opened > 0 || contributor.prs.closed > 0) && (
                                                        <span className="text-purple-400">🔀 {contributor.prs.opened + contributor.prs.closed}</span>
                                                    )}
                                                    {(contributor.issues.opened > 0 || contributor.issues.closed > 0) && (
                                                        <span className="text-green-400">📋 {contributor.issues.opened + contributor.issues.closed}</span>
                                                    )}
                                                    {contributor.commits > 0 && (
                                                        <span className="text-blue-400">💻 {contributor.commits}</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center py-8 text-gray-500">当天无贡献者活动</div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-700 flex justify-end">
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

export default DayDetailModal;
