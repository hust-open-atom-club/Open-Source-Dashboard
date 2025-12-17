import axios from 'axios';

// Use relative URL - Vite proxy handles forwarding to backend
const API_BASE_URL = '/api/v1';

const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 10000,
});

export const getOrgSummary = async (range = '30d') => {
    try {
        const response = await api.get('/organization/summary', { params: { range } });
        return response.data;
    } catch (error) {
        console.error('Error fetching org summary:', error);
        throw error;
    }
};

export const getOrgTimeseries = async (range = '30d') => {
    try {
        const response = await api.get('/organization/timeseries', { params: { range } });
        return response.data;
    } catch (error) {
        console.error('Error fetching org timeseries:', error);
        throw error;
    }
};

export const getOrgSigs = async () => {
    try {
        const response = await api.get('/organization/sigs');
        return response.data;
    } catch (error) {
        console.error('Error fetching SIGs:', error);
        throw error;
    }
};

export const getSigTimeseries = async (sigId, range = '30d') => {
    try {
        const response = await api.get(`/sig/${sigId}/timeseries`, { params: { range } });
        return response.data;
    } catch (error) {
        console.error(`Error fetching timeseries for SIG ${sigId}:`, error);
        throw error;
    }
};

// New API methods for enhanced features

export const getAggregatedTimeseries = async (range = '30d', granularity = 'day') => {
    try {
        const response = await api.get('/organization/timeseries/aggregated', {
            params: { range, granularity }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching aggregated timeseries:', error);
        throw error;
    }
};

export const getSigAggregatedTimeseries = async (sigId, range = '30d', granularity = 'day') => {
    try {
        const response = await api.get(`/sig/${sigId}/timeseries/aggregated`, {
            params: { range, granularity }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching aggregated timeseries for SIG ${sigId}:`, error);
        throw error;
    }
};

export const compareSigs = async (sigIds, range = '30d', granularity = 'day') => {
    try {
        const response = await api.get('/sigs/compare', {
            params: { sigIds: sigIds.join(','), range, granularity }
        });
        return response.data;
    } catch (error) {
        console.error('Error comparing SIGs:', error);
        throw error;
    }
};

export const getGrowthAnalysis = async (type = 'org', id = null, range = '30d') => {
    try {
        const endpoint = type === 'org'
            ? '/organization/growth-analysis'
            : `/sig/${id}/growth-analysis`;
        const response = await api.get(endpoint, { params: { range } });
        return response.data;
    } catch (error) {
        console.error('Error fetching growth analysis:', error);
        throw error;
    }
};

export const exportData = async (format, params) => {
    try {
        const response = await api.get(`/export/${format}`, {
            params,
            responseType: 'blob'
        });
        return response.data;
    } catch (error) {
        console.error(`Error exporting ${format}:`, error);
        throw error;
    }
};

// Contributor API methods

export const getContributorLeaderboard = async (range = '30d', metric = 'total', limit = 50) => {
    try {
        const response = await api.get('/contributors/leaderboard', {
            params: { range, metric, limit }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching contributor leaderboard:', error);
        throw error;
    }
};

export const getContributorStats = async (range = '30d') => {
    try {
        const response = await api.get('/contributors/stats', {
            params: { range }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching contributor stats:', error);
        throw error;
    }
};

export const getContributorDetails = async (username, range = '30d') => {
    try {
        const response = await api.get(`/contributors/${username}`, {
            params: { range }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching contributor ${username}:`, error);
        throw error;
    }
};

// Day detail API
export const getDayDetails = async (date) => {
    try {
        const response = await api.get(`/organization/day/${date}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching day ${date} details:`, error);
        throw error;
    }
};

// SIG contributors API
export const getSigContributors = async (sigId, range = '30d') => {
    try {
        const response = await api.get(`/sig/${sigId}/contributors`, {
            params: { range }
        });
        return response.data;
    } catch (error) {
        console.error(`Error fetching SIG ${sigId} contributors:`, error);
        throw error;
    }
};

export default api;

