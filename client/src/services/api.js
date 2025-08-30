import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token
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
  login: () => {
    console.log('Login button clicked, redirecting to:', 'http://44.229.3.37:3000/api/auth/login');
    window.open('http://44.229.3.37:3000/api/auth/login', '_self');
  },
  silentLogin: () => {
    return new Promise((resolve, reject) => {
      // Open small popup window for silent auth check
      const popup = window.open(
        'http://44.229.3.37:3000/api/auth/silent',
        'silent-auth',
        'width=1,height=1,left=-1000,top=-1000'
      )
      
      const timeout = setTimeout(() => {
        popup?.close()
        reject(new Error('Silent login timeout'))
      }, 5000)
      
      window.addEventListener('message', function handler(event) {
        if (event.origin !== 'http://44.229.3.37:3000') return
        
        clearTimeout(timeout)
        popup?.close()
        window.removeEventListener('message', handler)
        
        if (event.data.success) {
          window.location.href = event.data.redirectUrl
          resolve()
        } else {
          reject(new Error('No valid session'))
        }
      })
    })
  },
  logout: () => api.post('/auth/logout'),
  getProfile: () => api.get('/auth/me'),
};

export const teamsAPI = {
  getMyTeams: () => api.get('/teams/my-teams'),
  getJoinable: () => axios.get('/api/teams/joinable'),
  create: (data) => api.post('/teams', data),
  update: (id, data) => api.put(`/teams/${id}`, data),
  getById: (id) => api.get(`/teams/${id}`),
  addMember: (teamId, data) => api.post(`/teams/${teamId}/members`, data),
  getHierarchy: (id) => api.get(`/teams/${id}/hierarchy`),
  getSubTeams: (id) => api.get(`/teams/${id}/sub-teams`),
  delete: (id) => api.delete(`/teams/${id}`),
};

export const usersAPI = {
  getAll: () => api.get('/users'),
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

export const configAPI = {
  getPublic: () => axios.get('/api/config/public'),
  getAll: () => api.get('/config/all'),
  update: (key, data) => api.put(`/config/${key}`, data),
};

export default api;