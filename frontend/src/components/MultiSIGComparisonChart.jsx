import React, { useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

const MultiSIGComparisonChart = ({ sigs, selectedSigIds, onSigSelectionChange, metric = 'new_prs', range, granularity }) => {
    const [chartData, setChartData] = useState([]);

    useEffect(() => {
        // Prepare data for selected SIGs
        const selectedSigs = sigs.filter(sig => selectedSigIds.includes(sig.id));
        setChartData(selectedSigs);
    }, [sigs, selectedSigIds]);

    const metricLabels = {
        new_prs: 'PRs',
        new_issues: 'Issues',
        new_commits: 'Commits',
        lines_added: '新增代码行'
    };

    const getOption = () => {
        if (chartData.length === 0) {
            return {};
        }

        // Get all unique dates across all SIGs
        const allDates = new Set();
        chartData.forEach(sig => {
            sig.timeseries.forEach(item => allDates.add(item.date));
        });
        const dates = Array.from(allDates).sort();

        return {
            backgroundColor: 'transparent',
            title: {
                text: `SIG 对比 - ${metricLabels[metric] || metric}`,
                textStyle: {
                    color: '#e5e7eb',
                    fontSize: 16,
                    fontWeight: 'normal'
                },
                left: 'center',
                top: 10
            },
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(17, 24, 39, 0.9)',
                borderColor: '#374151',
                textStyle: {
                    color: '#f3f4f6'
                }
            },
            legend: {
                data: chartData.map(sig => sig.name),
                bottom: 0,
                textStyle: {
                    color: '#9ca3af'
                },
                type: 'scroll'
            },
            grid: {
                left: '3%',
                right: '4%',
                bottom: '15%',
                top: '15%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: dates,
                axisLine: {
                    lineStyle: {
                        color: '#4b5563'
                    }
                },
                axisLabel: {
                    color: '#9ca3af',
                    rotate: dates.length > 30 ? 45 : 0
                }
            },
            yAxis: {
                type: 'value',
                splitLine: {
                    lineStyle: {
                        color: '#374151',
                        type: 'dashed'
                    }
                },
                axisLabel: {
                    color: '#9ca3af'
                }
            },
            series: chartData.map((sig, index) => {
                // Create a map for quick lookup
                const dataMap = new Map();
                sig.timeseries.forEach(item => {
                    dataMap.set(item.date, item[metric] || 0);
                });

                // Fill data array with values for all dates
                const data = dates.map(date => dataMap.get(date) || 0);

                return {
                    name: sig.name,
                    type: 'line',
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    itemStyle: {
                        color: COLORS[index % COLORS.length]
                    },
                    lineStyle: {
                        width: 2
                    },
                    data: data
                };
            })
        };
    };

    return (
        <div className="h-full">
            {/* Chart */}
            <div style={{ height: '100%' }}>
                {chartData.length > 0 ? (
                    <ReactECharts option={getOption()} style={{ height: '100%', width: '100%' }} />
                ) : (
                    <div className="flex items-center justify-center h-full text-gray-400">
                        加载中...
                    </div>
                )}
            </div>
        </div>
    );
};

export default MultiSIGComparisonChart;

