const axios = require('axios');

class AuthentikService {
  constructor() {
    this.baseURL = process.env.AUTHENTIK_URL;
    this.adminToken = process.env.AUTHENTIK_ADMIN_TOKEN;
    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v3`,
      headers: {
        'Authorization': `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // Create regular user (not service account)
  async createUser(userData) {
    const response = await this.client.post('/core/users/', {
      username: userData.username,
      name: userData.name,
      email: userData.email,
      is_active: true,
      type: 'internal'
    });
    return response.data;
  }

  // Set user password
  async setUserPassword(userId, password) {
    await this.client.post(`/core/users/${userId}/set_password/`, {
      password: password
    });
  }

  // Get all users (excluding service accounts)
  async getUsers() {
    const response = await this.client.get('/core/users/?type=internal');
    return response.data.results;
  }

  // Get user by username
  async getUserByUsername(username) {
    const response = await this.client.get(`/core/users/?username=${username}`);
    return response.data.results[0] || null;
  }

  // Create LDAP group for channel
  async createGroup(groupData) {
    const response = await this.client.post('/core/groups/', {
      name: groupData.name,
      attributes: {
        CN: groupData.displayName,
        description: groupData.description
      }
    });
    return response.data;
  }

  // Add user to group
  async addUserToGroup(groupId, userId) {
    await this.client.post(`/core/groups/${groupId}/add_user/`, {
      pk: userId
    });
  }

  // Remove user from group
  async removeUserFromGroup(groupId, userId) {
    await this.client.post(`/core/groups/${groupId}/remove_user/`, {
      pk: userId
    });
  }

  // Get group by name
  async getGroupByName(name) {
    const encodedName = encodeURIComponent(name);
    const response = await this.client.get(`/core/groups/?name=${encodedName}`);
    return response.data.results[0] || null;
  }
}

module.exports = new AuthentikService();