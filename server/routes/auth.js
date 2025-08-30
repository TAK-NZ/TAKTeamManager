const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const router = express.Router();

// SSO endpoint - immediately starts OAuth2 flow
router.get('/sso', (req, res) => {
  const authURL = `${process.env.AUTHENTIK_URL}/application/o/authorize/` +
    `?response_type=code` +
    `&client_id=${process.env.AUTHENTIK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.APP_URL + '/api/auth/callback')}` +
    `&scope=openid profile email`;
  
  res.redirect(authURL);
});

// OAuth2 login redirect
router.get('/login', (req, res) => {
  const authURL = `${process.env.AUTHENTIK_URL}/application/o/authorize/` +
    `?response_type=code` +
    `&client_id=${process.env.AUTHENTIK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.APP_URL + '/api/auth/callback')}` +
    `&scope=openid profile email`;
  
  res.redirect(authURL);
});

// OAuth2 callback
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.redirect(process.env.FRONTEND_URL + '?error=no_code');
    }

    // Exchange code for token
    const tokenResponse = await axios.post(process.env.AUTHENTIK_TOKEN_URL, 
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.AUTHENTIK_CLIENT_ID,
        client_secret: process.env.AUTHENTIK_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.APP_URL + '/api/auth/callback'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token } = tokenResponse.data;

    // Get user info
    const userResponse = await axios.get(process.env.AUTHENTIK_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    // Get user attributes from Authentik API
    const userDetailsResponse = await axios.get(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?username=${userResponse.data.preferred_username}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
    });
    
    const userDetails = userDetailsResponse.data.results[0];
    console.log('User details from API:', userDetails);
    
    const user = {
      ...userResponse.data,
      takRole: userDetails?.attributes?.takRole,
      takColor: userDetails?.attributes?.takColor,
      takCallsign: userDetails?.attributes?.takCallsign
    };
    
    console.log('User with TAK attributes:', user);

    // Create JWT token
    const jwtToken = jwt.sign(
      { 
        id: user.sub,
        email: user.email,
        name: user.name || user.preferred_username,
        first_name: user.given_name || user.name || user.preferred_username,
        last_name: user.family_name || '',
        username: user.preferred_username,
        groups: user.groups || [],
        groups_obj: user.groups_obj || [],
        takRole: user.takRole,
        takColor: user.takColor,
        takCallsign: user.takCallsign
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Redirect with token as URL parameter (frontend will store it)
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?token=${jwtToken}`);
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.redirect(process.env.FRONTEND_URL + '?error=auth_failed');
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// Get current user
router.get('/me', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ user: decoded });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;