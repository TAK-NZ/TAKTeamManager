import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: () => window.location.href = '/api/auth/login',
  logout: () => api.post('/auth/logout'),
  getProfile: () => api.get('/users/me'),
};

export const teamsAPI = {
  getMyTeams: () => api.get('/teams/my-teams'),
  create: (data) => api.post('/teams', data),
  getById: (id) => api.get(`/teams/${id}`),
  addMember: (teamId, data) => api.post(`/teams/${teamId}/members`, data),
  getHierarchy: (id) => api.get(`/teams/${id}/hierarchy`),
};

export const usersAPI = {
  create: (data) => api.post('/users', data),
  search: (query) => api.get(`/users/search?q=${query}`),
  moveToHoldingPen: (userId) => api.post(`/users/${userId}/holding-pen`),
};

export const channelsAPI = {
  getByTeam: (teamId) => api.get(`/channels/team/${teamId}`),
  create: (data) => api.post('/channels', data),
  addMember: (channelId, data) => api.post(`/channels/${channelId}/members`, data),
  removeMember: (channelId, userId) => api.delete(`/channels/${channelId}/members/${userId}`),
  getMembers: (channelId) => api.get(`/channels/${channelId}/members`),
};

export const requestsAPI = {
  submitTeamAccess: (data) => api.post('/requests/team-access', data),
  getPending: () => api.get('/requests/pending'),
  makeDecision: (requestId, data) => api.post(`/requests/${requestId}/decision`, data),
};

export default api;