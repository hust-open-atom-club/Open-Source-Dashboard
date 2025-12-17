import React from 'react';

const LoadingSkeleton = () => {
    return (
        <div className="min-h-screen bg-gray-900 text-white p-8 font-sans">
            <div className="animate-pulse">
                {/* Header Skeleton */}
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <div className="h-10 bg-gray-700 rounded w-64 mb-2"></div>
                        <div className="h-5 bg-gray-700 rounded w-48"></div>
                    </div>
                    <div className="h-10 bg-gray-700 rounded w-96"></div>
                </div>

                {/* Summary Cards Skeleton */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                            <div className="h-4 bg-gray-700 rounded w-3/4 mb-4"></div>
                            <div className="h-8 bg-gray-700 rounded w-1/2"></div>
                        </div>
                    ))}
                </div>

                {/* Charts Skeleton */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                    {[1, 2].map(i => (
                        <div key={i} className="bg-gray-800 rounded-xl p-6 border border-gray-700 h-96">
                            <div className="h-6 bg-gray-700 rounded w-1/3 mb-4"></div>
                            <div className="h-64 bg-gray-700 rounded"></div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default LoadingSkeleton;

