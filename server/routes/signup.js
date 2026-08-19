const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { getLogger } = require('../middleware/requestContext');
const { requestAccessLimiter } = require('../middleware/rateLimiters');
const { verifyCaptcha } = require('../middleware/captcha');
const SignupFlowService = require('../services/SignupFlowService');
const OrgInterestService = require('../services/OrgInterestService');

const router = express.Router();
const signupFlowService = new SignupFlowService();
const orgInterestService = new OrgInterestService();

// POST /requests/initiate — initiate sign-up (email verification step)
// Public route: rate-limited + CAPTCHA protected
router.post('/requests/initiate', requestAccessLimiter, verifyCaptcha, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('code').optional().isString().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, code } = req.body;
    await signupFlowService.initiateSignup(email, code || null);
    // Always return 200 to prevent email enumeration
    res.json({ message: 'Check your email to continue' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to initiate signup');
    // Still return 200 to prevent enumeration
    res.json({ message: 'Check your email to continue' });
  }
});

// GET /requests/available-teams — get teams available for a verified email
// Public route: no auth, token in query params provides verification
router.get('/requests/available-teams', [
  query('token').notEmpty().withMessage('token is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { token } = req.query;
    const result = await signupFlowService.getAvailableTeams(token, null);
    res.json(result);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get available teams');
    if (error.message === 'Invalid or expired verification token') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to get available teams' });
  }
});

// POST /requests/team-access — submit team access request after verification
// Public route: token in body provides verification
router.post('/requests/team-access', [
  body('token').notEmpty().withMessage('token is required'),
  body('firstName').trim().isLength({ min: 1, max: 255 }).withMessage('firstName is required'),
  body('lastName').trim().isLength({ min: 1, max: 255 }).withMessage('lastName is required'),
  body('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer'),
  body('reason').trim().isLength({ min: 10, max: 500 }).withMessage('Reason must be between 10 and 500 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { token, firstName, lastName, teamId, reason } = req.body;
    const result = await signupFlowService.submitTeamAccess({ token, firstName, lastName, teamId, reason });
    res.json(result);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to submit team access request');
    if (error.message === 'Invalid or expired verification token') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to submit team access request' });
  }
});

// POST /org-interest — submit org interest request
// Public route: token in body provides verification
router.post('/org-interest', [
  body('token').notEmpty().withMessage('token is required'),
  body('firstName').trim().isLength({ min: 1, max: 255 }).withMessage('firstName is required'),
  body('lastName').trim().isLength({ min: 1, max: 255 }).withMessage('lastName is required'),
  body('orgName').trim().isLength({ min: 1, max: 255 }).withMessage('orgName is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { token, firstName, lastName, orgName } = req.body;
    const result = await orgInterestService.submitRequest({ token, firstName, lastName, orgName });
    res.json(result);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to submit org interest request');
    if (error.message === 'Invalid or expired verification token' ||
        error.message === 'Please use an organisational email address to request a new organisation' ||
        error.message === 'A request is already pending for this email') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to submit org interest request' });
  }
});

module.exports = router;
