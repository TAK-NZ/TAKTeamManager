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
    const user = await User.findById(decoded.userId);
    
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }

    req.user = user;
    next();
  } catch (error) {
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