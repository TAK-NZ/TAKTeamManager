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
        },
        timeout: 10000
      }
    );

    const { access_token } = tokenResponse.data;

    // Get basic user info for authentication
    const userResponse = await axios.get(process.env.AUTHENTIK_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000
    });

    const basicUser = userResponse.data;


    // Get cached user data from local database
    const authentikSync = require('../services/authentikSync');
    const cachedUser = await authentikSync.getUserFromCache(basicUser.preferred_username);
    
    if (!cachedUser) {
      console.warn('User not found in cache, may need sync:', basicUser.preferred_username);
      return res.redirect(process.env.FRONTEND_URL + '?error=user_not_synced');
    }



    // Create minimal JWT token with just user ID
    const jwtToken = jwt.sign(
      { 
        userId: cachedUser.id,
        username: cachedUser.username
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
    


    // Redirect with token as URL parameter (now much shorter)
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
const { authenticateToken } = require('../middleware/auth');
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;