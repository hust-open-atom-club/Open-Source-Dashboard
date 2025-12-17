import React, { useEffect, useState } from 'react';
import { getSigContributors } from '../services/api';

const SIGContributorModal = ({ sigId, sigName, range = '30d', onClose }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (sigId) {
            fetchContributors();
        }
    }, [sigId, range]);

    const fetchContributors = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await getSigContributors(sigId, range);
            setData(result);
        } catch (err) {
            setError('无法加载贡献者数据');
            console.error('Failed to fetch SIG contributors:', err);
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
                <div className="flex items-center justify-between p-6 border-b border-gray-700 bg-gradient-to-r from-purple-900/30 to-blue-900/30">
                    <div>
                        <h2 className="text-2xl font-bold text-white">{data?.sig?.name || sigName}</h2>
                        <p className="text-sm text-gray-400">SIG 贡献者排行</p>
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
                <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                        </div>
                    ) : error ? (
                        <div className="text-center py-12 text-red-400">{error}</div>
                    ) : data?.contributors?.length > 0 ? (
                        <div className="space-y-3">
                            {data.contributors.map((contributor, idx) => (
                                <div
                                    key={idx}
                                    className={`flex items-center gap-4 p-4 rounded-lg transition-all ${idx < 3
                                        ? 'bg-gradient-to-r from-gray-700 to-gray-800 border border-gray-600'
                                        : 'bg-gray-700/50 hover:bg-gray-700'
                                        }`}
                                >
                                    {/* Rank */}
                                    <div className={`text-xl font-bold w-8 text-center ${idx === 0 ? 'text-yellow-400' :
                                        idx === 1 ? 'text-gray-300' :
                                            idx === 2 ? 'text-orange-400' : 'text-gray-500'
                                        }`}>
                                        {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
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
                                    <div className="flex-1">
                                        <div className="font-semibold text-white">{contributor.username}</div>
                                        <div className="text-sm text-gray-400 flex gap-3">
                                            {contributor.prs.opened > 0 && (
                                                <span className="text-purple-400">🔀 {contributor.prs.opened} PR</span>
                                            )}
                                            {contributor.issues.opened > 0 && (
                                                <span className="text-green-400">📋 {contributor.issues.opened} Issue</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Total */}
                                    <div className="text-right">
                                        <div className="text-xl font-bold text-blue-400">{contributor.total}</div>
                                        <div className="text-xs text-gray-500">新开数</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-12 text-gray-500">
                            该 SIG 暂无贡献者数据
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-700 flex justify-between items-center">
                    <span className="text-sm text-gray-400">
                        共 {data?.contributors?.length || 0} 名贡献者
                    </span>
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

export default SIGContributorModal;
