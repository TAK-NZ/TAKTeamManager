const crypto = require('crypto');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const path = require('path');
const pool = require('../config/database');

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * SignupCodeService
 *
 * Manages sign-up code lifecycle: generation, validation, formatting,
 * revocation, and asset generation (QR, PDF).
 *
 * Static methods handle pure code generation and validation logic.
 * Instance methods handle database operations.
 */
class SignupCodeService {
  /**
   * Generate a random 8-character code from the valid character set.
   * Uses crypto.randomBytes for randomness. Each byte is mapped to a
   * character via modulo over the charset length (30 chars).
   *
   * @returns {string} An 8-character code string (no dash).
   */
  static generateRandomCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CHARSET[bytes[i] % CHARSET.length];
    }
    return code;
  }

  /**
   * Format a raw 8-character code with a dash in the middle.
   * e.g. "4KP7NXRM" -> "4KP7-NXRM"
   *
   * @param {string} raw - The raw 8-character code.
   * @returns {string} The formatted code with a dash between positions 4 and 5.
   */
  static formatCode(raw) {
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  /**
   * Validate that a string matches the sign-up code format.
   * Accepts an optional dash between positions 4 and 5 (e.g. "4KP7-NXRM" or "4KP7NXRM").
   * Returns true if (after stripping the optional dash) the input is exactly
   * 8 characters, all from the valid character set.
   *
   * @param {string} input - The code string to validate (may include optional dash).
   * @returns {boolean} True if the input is a valid code format.
   */
  static isValidCodeFormat(input) {
    if (typeof input !== 'string') return false;

    // Strip optional dash between positions 4 and 5
    const stripped = input.replace(/^(.{4})-(.{4})$/, '$1$2');

    if (stripped.length !== CODE_LENGTH) return false;

    for (let i = 0; i < stripped.length; i++) {
      if (!CHARSET.includes(stripped[i])) return false;
    }

    return true;
  }

  /**
   * Generate a new 8-char code for a team. Replaces any existing code.
   * Verifies the team has can_join = true before generating.
   * Retries on unique constraint violation on the code column (max 3 attempts).
   *
   * @param {number} teamId
   * @param {number} createdBy - user ID of the admin
   * @returns {Promise<{code: string, formatted: string, url: string}>}
   */
  async generateCode(teamId, createdBy) {
    // Verify the team has can_join = true
    const teamResult = await pool.query(
      'SELECT can_join FROM teams WHERE id = $1',
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      throw new Error('Team not found');
    }

    if (!teamResult.rows[0].can_join) {
      throw new Error('Team must have joining enabled');
    }

    // Retry loop for unique constraint violations on the code column
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      const code = SignupCodeService.generateRandomCode();
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Delete any existing code for this team
        await client.query(
          'DELETE FROM signup_codes WHERE team_id = $1',
          [teamId]
        );

        // Insert the new code
        await client.query(
          'INSERT INTO signup_codes (team_id, code, created_by) VALUES ($1, $2, $3)',
          [teamId, code, createdBy]
        );

        await client.query('COMMIT');

        return {
          code,
          formatted: SignupCodeService.formatCode(code),
          url: `${process.env.FRONTEND_URL}/request-access?code=${code}`
        };
      } catch (err) {
        await client.query('ROLLBACK');

        // Check for unique constraint violation on the code column (PostgreSQL error code 23505)
        if (err.code === '23505' && err.constraint && err.constraint.includes('code')) {
          // Retry with a new code on next iteration
          if (attempt === MAX_RETRY_ATTEMPTS - 1) {
            throw new Error('Failed to generate a unique code after maximum retries');
          }
          continue;
        }

        // Re-throw any other error
        throw err;
      } finally {
        client.release();
      }
    }
  }

  /**
   * Revoke (delete) the active code for a team.
   * No error if no code exists.
   *
   * @param {number} teamId
   * @returns {Promise<void>}
   */
  async revokeCode(teamId) {
    await pool.query(
      'DELETE FROM signup_codes WHERE team_id = $1',
      [teamId]
    );
  }

  /**
   * Get the active code for a team, or null.
   *
   * @param {number} teamId
   * @returns {Promise<{code: string, formatted: string, url: string} | null>}
   */
  async getCode(teamId) {
    const result = await pool.query(
      'SELECT code FROM signup_codes WHERE team_id = $1',
      [teamId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const code = result.rows[0].code;
    return {
      code,
      formatted: SignupCodeService.formatCode(code),
      url: `${process.env.FRONTEND_URL}/request-access?code=${code}`
    };
  }

  /**
   * Look up a code globally. Returns {teamId, code} or null.
   * Normalizes input by stripping dashes and uppercasing.
   *
   * @param {string} rawCode - code input (may include dash, mixed case)
   * @returns {Promise<{teamId: number, code: string} | null>}
   */
  async resolveCode(rawCode) {
    // Normalize: strip dash, uppercase
    const normalized = rawCode.replace(/-/g, '').toUpperCase();

    const result = await pool.query(
      'SELECT team_id, code FROM signup_codes WHERE code = $1',
      [normalized]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      teamId: result.rows[0].team_id,
      code: result.rows[0].code
    };
  }

  /**
   * Generate a QR code PNG buffer encoding the full sign-up URL.
   * @param {string} code - 8-char code (no dash)
   * @returns {Promise<Buffer>} PNG image buffer
   */
  async generateQrPng(code) {
    const url = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/request-access?code=${code}`;
    return QRCode.toBuffer(url, { type: 'png', width: 300, margin: 2 });
  }

  /**
   * Generate a branded PDF with QR code, URL, and instructions.
   * @param {string} code - 8-char code (no dash)
   * @param {string} teamName - Name of the team for display
   * @returns {Promise<Buffer>} PDF document buffer
   */
  async generatePdf(code, teamName) {
    const url = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/request-access?code=${code}`;
    const qrBuffer = await this.generateQrPng(code);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Logo
      const logoPath = path.join(__dirname, '../assets/tak-nz-brand-wide.png');
      doc.image(logoPath, (doc.page.width - 300) / 2, doc.y, { width: 300 });
      doc.y += 90;
      doc.moveDown(0.5);

      // Horizontal rule
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke('#cccccc');
      doc.moveDown(1);

      // Team name
      doc.fontSize(16).font('Helvetica-Bold').text(`Join: ${teamName}`, { align: 'center' });
      doc.moveDown(2);

      // QR Code
      doc.image(qrBuffer, (doc.page.width - 200) / 2, doc.y, { width: 200 });
      doc.moveDown(1);
      doc.y += 210;

      // Instructions
      doc.fontSize(11).font('Helvetica').text('Scan the QR code above with your phone camera', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(10).text('or visit this URL in your browser:', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(11).font('Helvetica-Bold').text(url, { align: 'center', link: url });
      doc.moveDown(2);

      // Sign-up code
      doc.fontSize(10).font('Helvetica').text('If prompted, enter this sign-up code:', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(14).font('Courier-Bold').text(SignupCodeService.formatCode(code), { align: 'center' });
      doc.moveDown(2);

      // Footer
      doc.fontSize(9).font('Helvetica').fillColor('#666666')
        .text('This code does not expire. Keep this poster in a visible location for team members to scan.', { align: 'center' });

      doc.end();
    });
  }
}

module.exports = SignupCodeService;
