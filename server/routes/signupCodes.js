const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const SignupCodeService = require('../services/SignupCodeService');
const Team = require('../models/Team');

const router = express.Router();
const signupCodeService = new SignupCodeService();

// POST /generate — generate a new sign-up code for a team
router.post('/generate', authenticateToken, authorize, [
  body('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId } = req.body;
    const code = await signupCodeService.generateCode(teamId, req.user.userId);
    res.json(code);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to generate signup code');
    if (error.message === 'Team not found' || error.message === 'Team must have joining enabled') {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to generate signup code' });
  }
});

// GET /:teamId — get the active sign-up code for a team
router.get('/:teamId', authenticateToken, authorize, [
  param('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const code = await signupCodeService.getCode(req.params.teamId);
    if (!code) {
      return res.json(null);
    }
    res.json(code);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get signup code');
    res.status(500).json({ error: 'Failed to get signup code' });
  }
});

// DELETE /:teamId — revoke the sign-up code for a team
router.delete('/:teamId', authenticateToken, authorize, [
  param('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    await signupCodeService.revokeCode(req.params.teamId);
    res.json({ success: true });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to revoke signup code');
    res.status(500).json({ error: 'Failed to revoke signup code' });
  }
});

// GET /:teamId/qr — get QR code PNG for the team's sign-up code
router.get('/:teamId/qr', authenticateToken, authorize, [
  param('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const code = await signupCodeService.getCode(req.params.teamId);
    if (!code) {
      return res.status(404).json({ error: 'No active sign-up code for this team' });
    }

    const pngBuffer = await signupCodeService.generateQrPng(code.code);
    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to generate QR code');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// GET /:teamId/pdf — get PDF with QR code and instructions for the team
router.get('/:teamId/pdf', authenticateToken, authorize, [
  param('teamId').isInt({ min: 1 }).withMessage('teamId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const code = await signupCodeService.getCode(req.params.teamId);
    if (!code) {
      return res.status(404).json({ error: 'No active sign-up code for this team' });
    }

    const team = await Team.findById(req.params.teamId);
    let teamDisplayName = team ? team.name : 'Unknown Team';
    if (team && team.parent_team_id) {
      try {
        const ancestorChain = await Team.getAncestorChain(req.params.teamId);
        const org = ancestorChain[0];
        teamDisplayName = `${org.callsign_prefix || org.name} - ${team.name}`;
      } catch (e) {
        // Fall back to plain name
      }
    }

    const pdfBuffer = await signupCodeService.generatePdf(code.code, teamDisplayName);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="signup-${req.params.teamId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to generate PDF');
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
