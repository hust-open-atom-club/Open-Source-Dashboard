import React from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';

const SIGComparisonChart = ({ title, data, metricKey, metricName, color = '#3b82f6', onSigClick }) => {
    // Sort data by metric value descending
    const sortedData = [...data].sort((a, b) => b[metricKey] - a[metricKey]);
    const categories = sortedData.map(item => item.name);
    const values = sortedData.map(item => item[metricKey]);
    const ids = sortedData.map(item => item.id);

    const onEvents = onSigClick ? {
        'click': (params) => {
            if (params.componentType === 'series' || params.componentType === 'yAxis') {
                const index = params.dataIndex;
                const sigId = ids[index];
                const sigName = categories[index];
                if (sigId) {
                    onSigClick(sigId, sigName);
                }
            }
        }
    } : {};

    const option = {
        backgroundColor: 'transparent',
        title: {
            text: title,
            subtext: onSigClick ? '点击查看贡献者' : undefined,
            subtextStyle: {
                color: '#6b7280',
                fontSize: 11
            },
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
            axisPointer: {
                type: 'shadow'
            },
            backgroundColor: 'rgba(17, 24, 39, 0.9)',
            borderColor: '#374151',
            textStyle: {
                color: '#f3f4f6'
            },
            formatter: onSigClick ? (params) => {
                const item = params[0];
                return `<div style="font-weight:bold;margin-bottom:4px;">${item.name}</div>
                    <div>${metricName}: ${item.value}</div>
                    <div style="margin-top:8px;font-size:11px;color:#9ca3af;">点击查看贡献者</div>`;
            } : undefined
        },
        grid: {
            left: '3%',
            right: '4%',
            bottom: '3%',
            containLabel: true
        },
        xAxis: {
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
        yAxis: {
            type: 'category',
            data: categories,
            axisLine: {
                lineStyle: {
                    color: '#4b5563'
                }
            },
            axisLabel: {
                color: '#9ca3af',
                interval: 0,
                width: 100,
                overflow: 'truncate'
            },
            triggerEvent: true
        },
        series: [
            {
                name: metricName,
                type: 'bar',
                data: values,
                itemStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                        { offset: 0, color: color },
                        { offset: 1, color: '#60a5fa' }
                    ]),
                    borderRadius: [0, 4, 4, 0]
                },
                emphasis: {
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                            { offset: 0, color: '#a855f7' },
                            { offset: 1, color: '#3b82f6' }
                        ])
                    }
                },
                label: {
                    show: true,
                    position: 'right',
                    color: '#e5e7eb'
                },
                cursor: onSigClick ? 'pointer' : 'default'
            }
        ]
    };

    return (
        <ReactECharts
            option={option}
            style={{ height: '100%', width: '100%', cursor: onSigClick ? 'pointer' : 'default' }}
            onEvents={onEvents}
        />
    );
};

export default SIGComparisonChart;
