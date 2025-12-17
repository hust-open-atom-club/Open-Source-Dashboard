import React, { useState } from 'react';
import api from '../services/api';

const ExportMenu = ({ type = 'org', range = '30d', sigIds = [], granularity = 'day', summary = {}, growthData = {}, sigData = [], contributors = [], timeseries = [] }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportingFormat, setExportingFormat] = useState(null);

    const downloadFile = (blob, filename) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    };

    const handleExport = async (format) => {
        setExporting(true);
        setExportingFormat(format);

        try {
            if (format === 'csv') {
                const params = {
                    type,
                    range,
                    granularity
                };
                if (sigIds.length > 0) {
                    params.sigIds = sigIds.join(',');
                }

                const response = await api.get('/export/csv', {
                    params,
                    responseType: 'blob'
                });

                const filename = `report_${type}_${range}_${Date.now()}.csv`;
                downloadFile(response.data, filename);

            } else if (format === 'excel') {
                const params = {
                    type,
                    range,
                    granularity
                };
                if (sigIds.length > 0) {
                    params.sigIds = sigIds.join(',');
                }

                const response = await api.get('/export/excel', {
                    params,
                    responseType: 'blob'
                });

                const filename = `report_${type}_${range}_${Date.now()}.xlsx`;
                downloadFile(response.data, filename);

            } else if (format === 'pdf') {
                const response = await api.post('/export/pdf', {
                    type,
                    range,
                    sigIds,
                    summary,
                    growthData,
                    sigData,
                    contributors,
                    timeseries
                }, {
                    responseType: 'blob'
                });

                const filename = `report_${type}_${range}_${Date.now()}.pdf`;
                downloadFile(response.data, filename);
            }

            setIsOpen(false);
        } catch (error) {
            console.error('Export failed:', error);
            alert('导出失败：' + (error.response?.data?.error || error.message));
        } finally {
            setExporting(false);
            setExportingFormat(null);
        }
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                disabled={exporting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
            >
                {exporting ? (
                    <>
                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        导出中...
                    </>
                ) : (
                    <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        下载报表
                    </>
                )}
            </button>

            {isOpen && !exporting && (
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0 z-10"
                        onClick={() => setIsOpen(false)}
                    ></div>

                    {/* Menu */}
                    <div className="absolute right-0 mt-2 w-48 bg-gray-800 rounded-lg shadow-xl border border-gray-700 z-20">
                        <div className="py-1">
                            <button
                                onClick={() => handleExport('csv')}
                                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                导出 CSV
                            </button>

                            <button
                                onClick={() => handleExport('excel')}
                                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                                导出 Excel
                            </button>

                            <button
                                onClick={() => handleExport('pdf')}
                                className="w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                                导出 PDF
                            </button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default ExportMenu;

