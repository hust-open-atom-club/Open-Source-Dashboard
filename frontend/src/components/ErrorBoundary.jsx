import React from 'react';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        console.error('Error caught by boundary:', error, errorInfo);
        this.state = { hasError: true, error, errorInfo };
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen bg-gray-900 text-white p-8 flex items-center justify-center">
                    <div className="max-w-2xl w-full bg-gray-800 rounded-xl p-8 border border-red-500/30">
                        <div className="flex items-center gap-3 mb-4">
                            <svg className="w-12 h-12 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <h1 className="text-2xl font-bold text-red-500">出错了</h1>
                        </div>
                        
                        <p className="text-gray-300 mb-4">
                            应用遇到了一个错误。请尝试刷新页面。
                        </p>
                        
                        {this.state.error && (
                            <div className="bg-gray-900 rounded-lg p-4 mb-4">
                                <p className="text-sm text-red-400 font-mono">
                                    {this.state.error.toString()}
                                </p>
                            </div>
                        )}
                        
                        <button
                            onClick={() => window.location.reload()}
                            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                        >
                            刷新页面
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;

