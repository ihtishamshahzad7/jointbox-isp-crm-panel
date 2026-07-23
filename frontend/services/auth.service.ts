import axios from 'axios';

const API_URL = (typeof window!=="undefined"?`http://${window.location.hostname}:3001`:'http://localhost:3001');

class AuthService {
  private refreshTimeout: NodeJS.Timeout | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.setupAutoRefresh();
    }
  }

  async login(email: string, password: string) {
    try {
      const response = await axios.post(`${API_URL}/auth/login`, {
        email,
        password
      });

      if (response.data.token) {
        localStorage.setItem('token', response.data.token);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        
        // Add to login history
        this.addToLoginHistory(email, 'SUCCESS');
        
        this.setupAutoRefresh();
        return { success: true, user: response.data.user };
      }
      return { success: false, message: 'No token received' };
    } catch (error: any) {
      console.error('Login error:', error);
      
      // Add failed login attempt to history
      this.addToLoginHistory(email, 'FAILED', error.response?.data?.message);
      
      return {
        success: false,
        message: error.response?.data?.message || 'Login failed'
      };
    }
  }

  private addToLoginHistory(email: string, status: string, reason?: string) {
    const history = JSON.parse(localStorage.getItem('login_history') || '[]');
    history.unshift({
      id: Date.now(),
      email: email,
      user: { name: email.split('@')[0] },
      ipAddress: '127.0.0.1',
      status: status,
      failReason: reason,
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('login_history', JSON.stringify(history.slice(0, 100)));
  }

  async logout() {
    try {
      const token = this.getToken();
      if (token) {
        await axios.post(`${API_URL}/auth/logout`, {}, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (this.refreshTimeout) {
        clearTimeout(this.refreshTimeout);
      }
    }
  }

  getToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  }

  getUser() {
    if (typeof window !== 'undefined') {
      const user = localStorage.getItem('user');
      return user ? JSON.parse(user) : null;
    }
    return null;
  }

  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;
    
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const isValid = payload.exp * 1000 > Date.now();
      if (!isValid) {
        this.logout();
      }
      return isValid;
    } catch {
      return false;
    }
  }

  async refreshToken(): Promise<boolean> {
    const currentToken = this.getToken();
    if (!currentToken) return false;

    try {
      const response = await axios.post(`${API_URL}/auth/refresh`, {
        token: currentToken
      });

      if (response.data.token) {
        localStorage.setItem('token', response.data.token);
        this.setupAutoRefresh();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Token refresh failed:', error);
      this.logout();
      return false;
    }
  }

  private setupAutoRefresh() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }

    const token = this.getToken();
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const expiresIn = payload.exp * 1000 - Date.now();
        const refreshTime = expiresIn - 5 * 60 * 1000; // Refresh 5 minutes before expiry
        
        if (refreshTime > 0) {
          this.refreshTimeout = setTimeout(() => {
            this.refreshToken();
          }, refreshTime);
        }
      } catch (error) {
        console.error('Error setting up auto-refresh:', error);
      }
    }
  }

  async verifyToken(): Promise<boolean> {
    const token = this.getToken();
    if (!token) return false;

    try {
      const response = await axios.post(`${API_URL}/auth/verify`, { token });
      return response.data.valid === true;
    } catch {
      return false;
    }
  }

  async getProfile() {
    const token = this.getToken();
    if (!token) return null;

    try {
      const response = await axios.get(`${API_URL}/auth/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data.user;
    } catch (error) {
      console.error('Get profile error:', error);
      return null;
    }
  }
}

export default new AuthService();