import React from 'react';

const ViewSwitcher = ({ view, onViewChange, range, onRangeChange }) => {
    const viewOptions = [
        { value: 'day', label: '日视图' },
        { value: 'week', label: '周视图' },
        { value: 'month', label: '月视图' }
    ];

    const rangeOptions = [
        { value: '7d', label: '7天' },
        { value: '30d', label: '30天' },
        { value: '90d', label: '90天' },
        { value: '180d', label: '180天' },
        { value: '365d', label: '1年' },
        { value: 'all', label: '全部' }
    ];

    return (
        <div className="flex gap-4 items-center">
            {/* Granularity Switcher */}
            <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">粒度:</span>
                <div className="bg-gray-800 rounded-lg p-1 border border-gray-700 flex">
                    {viewOptions.map(option => (
                        <button
                            key={option.value}
                            onClick={() => onViewChange(option.value)}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${view === option.value
                                    ? 'bg-blue-600 text-white shadow-lg'
                                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                                }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Time Range Switcher */}
            <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400">时间范围:</span>
                <div className="bg-gray-800 rounded-lg p-1 border border-gray-700 flex">
                    {rangeOptions.map(option => (
                        <button
                            key={option.value}
                            onClick={() => onRangeChange(option.value)}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${range === option.value
                                    ? 'bg-blue-600 text-white shadow-lg'
                                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                                }`}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default ViewSwitcher;

