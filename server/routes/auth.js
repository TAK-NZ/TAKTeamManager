const express = require('express');
const router = express.Router();

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
  // TODO: Exchange code for token, create JWT session
  res.redirect(process.env.FRONTEND_URL + '/dashboard');
});

// Logout
router.post('/logout', (req, res) => {
  // TODO: Invalidate JWT token
  res.json({ message: 'Logged out successfully' });
});

// Get current user
router.get('/me', (req, res) => {
  // TODO: Return current user from JWT
  res.json({ user: null });
});

module.exports = router;