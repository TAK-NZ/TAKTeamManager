const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch full user data from cache
    const authentikSync = require('../services/authentikSync');
    const cachedUser = await authentikSync.getUserFromCache(decoded.username);
    
    if (!cachedUser) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Set user data on request
    req.user = {
      id: cachedUser.authentik_id,
      userId: cachedUser.id,
      username: cachedUser.username,
      email: cachedUser.email,
      first_name: cachedUser.first_name,
      last_name: cachedUser.last_name,
      name: cachedUser.first_name + (cachedUser.last_name ? ' ' + cachedUser.last_name : ''),
      isAdmin: cachedUser.is_admin,
      takRole: cachedUser.tak_role,
      takColor: cachedUser.tak_color,
      takCallsign: cachedUser.tak_callsign,
      groups: cachedUser.groups || []
    };
    
    next();
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

const requireTeamAdmin = async (req, res, next) => {
  const { teamId } = req.params;
  const Team = require('../models/Team');
  
  try {
    const isAdmin = await Team.isAdmin(teamId, req.user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Team admin access required' });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authorization check failed' });
  }
};

module.exports = { authenticateToken, requireTeamAdmin };