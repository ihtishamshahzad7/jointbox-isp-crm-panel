import axios from 'axios';

const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Browser: auto-detect protocol + hostname
    // Works on localhost, 192.168.1.96, or any production domain
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:3001/api`;
  }
  // Server-side rendering fallback
  return process.env.NEXT_PUBLIC_API_URL
    ? `${process.env.NEXT_PUBLIC_API_URL}/api`
    : 'http://localhost:3001/api';
};

const api = axios.create({
  baseURL: getBaseUrl(),
});

// Add token to every request automatically
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Handle token expiration
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;