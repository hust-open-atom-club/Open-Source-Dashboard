import React, { useRef } from 'react';
import ReactECharts from 'echarts-for-react';

const TrendChart = ({ title, xAxisData, seriesData, colors = ['#3b82f6', '#10b981', '#f59e0b'], onDayClick }) => {
    const chartRef = useRef(null);

    const onEvents = onDayClick ? {
        'click': (params) => {
            if (params.componentType === 'series' || params.componentType === 'xAxis') {
                const dateIndex = params.dataIndex;
                const date = xAxisData[dateIndex];
                if (date) {
                    onDayClick(date);
                }
            }
        }
    } : {};

    const option = {
        backgroundColor: 'transparent',
        title: {
            text: title,
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
            },
            formatter: onDayClick ? (params) => {
                let result = `<div style="font-weight:bold;margin-bottom:4px;">${params[0].axisValue}</div>`;
                params.forEach(item => {
                    result += `<div style="display:flex;align-items:center;gap:8px;">
                        <span style="display:inline-block;width:10px;height:10px;background:${item.color};border-radius:50%;"></span>
                        <span>${item.seriesName}: ${item.value}</span>
                    </div>`;
                });
                result += `<div style="margin-top:8px;font-size:11px;color:#9ca3af;">点击查看详情</div>`;
                return result;
            } : undefined
        },
        legend: {
            data: seriesData.map(s => s.name),
            bottom: 0,
            textStyle: {
                color: '#9ca3af'
            }
        },
        grid: {
            left: '3%',
            right: '4%',
            bottom: '15%',
            containLabel: true
        },
        xAxis: {
            type: 'category',
            boundaryGap: false,
            data: xAxisData,
            axisLine: {
                lineStyle: {
                    color: '#4b5563'
                }
            },
            axisLabel: {
                color: '#9ca3af'
            },
            triggerEvent: true
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
        series: seriesData.map((s, index) => ({
            name: s.name,
            type: 'line',
            smooth: true,
            symbol: onDayClick ? 'circle' : 'none',
            symbolSize: 8,
            emphasis: {
                scale: true,
                focus: 'series'
            },
            areaStyle: {
                opacity: 0.1
            },
            itemStyle: {
                color: colors[index % colors.length]
            },
            data: s.data,
            cursor: onDayClick ? 'pointer' : 'default'
        }))
    };

    return (
        <ReactECharts
            ref={chartRef}
            option={option}
            style={{ height: '100%', width: '100%', cursor: onDayClick ? 'pointer' : 'default' }}
            onEvents={onEvents}
        />
    );
};

export default TrendChart;
