const crypto = require('crypto');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const path = require('path');
const pool = require('../config/database');
const { AMBIGUITY_FREE_ALPHABET } = require('../utils/identifierAlphabet');

// Local alias: this is the same 31-character Identifier_Alphabet the
// Managed_Identifier generator (server/utils/managedIdentifier.js) draws
// from -- see server/utils/identifierAlphabet.js for the single definition.
const CHARSET = AMBIGUITY_FREE_ALPHABET;
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
   * character via modulo over the charset length (31 chars).
   *
   * @returns {string} An 8-character code string (no dash).
   */
  static generateRandomCode() {
    // NOTE: `bytes[i] % CHARSET.length` over a uniform byte is biased: 256 =
    // 8*31+8, so the first eight alphabet characters (A-H) are drawn 9/256 of
    // the time and the remaining 23 are drawn 8/256 -- about 12.5%
    // over-representation on eight of thirty-one characters. This is
    // deliberately LEFT UNFIXED here: fixing it would change the
    // distribution of every future sign-up code, a behaviour change in a
    // different feature with its own requirements and tests, and a 31^8
    // space biased by an eighth is still not guessable. Rejection sampling
    // (e.g. via crypto.randomInt) is a named follow-up, not part of this
    // change. The Managed_Identifier generator (server/utils/managedIdentifier.js)
    // deliberately does NOT use this construction -- it draws via
    // crypto.randomInt(31), which is bias-free.
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
            throw new Error('Failed to generate a unique code after maximum retries', { cause: err });
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
   * Generate a branded one-page A4 PDF that introduces TAK.NZ to the members of
   * a team and invites them to join: hero photo, the "When Where Matters"
   * pitch, the three headline benefits, and a call-to-action card with the QR
   * code, sign-up URL and code. Copy and imagery come from https://tak.nz/ and
   * https://tak.nz/about/; the image files live in `server/assets/signup-pdf/`.
   *
   * @param {string} code - 8-char code (no dash)
   * @param {string} teamName - Name of the team for display
   * @returns {Promise<Buffer>} PDF document buffer
   */
  async generatePdf(code, teamName) {
    const url = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/request-access?code=${code}`;
    const qrBuffer = await this.generateQrPng(code);
    const assets = path.join(__dirname, '../assets/signup-pdf');

    // Brand colours, taken from the tak.nz stylesheet.
    const NAVY = '#003366';
    const BLUE = '#0066cc';
    const INK = '#2f2f41';
    const MUTED = '#5c5a5a';
    const TINT = '#e8f0f8';
    const PANEL = '#f8f9fa';
    const RULE = '#dee2e6';

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: { Title: `Join ${teamName} on TAK.NZ`, Author: 'TAK.NZ' }
      });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;
      const M = 48; // side margin for body content

      // --- Header band -----------------------------------------------------
      const HEADER_H = 76;
      doc.rect(0, 0, W, HEADER_H).fill(NAVY);
      doc.image(path.join(assets, 'logo-white.png'), M, 19, { height: 38 });

      // --- Hero photo (cropped to a banner), fading into the navy block ------
      const HERO_H = 240;
      const heroW = W;
      doc.save();
      doc.rect(0, HEADER_H, W, HERO_H).clip();
      doc.image(path.join(assets, 'about.jpg'), 0, HEADER_H - 45, { width: heroW });
      doc.restore();
      const fadeTop = HEADER_H + HERO_H - 70;
      const fade = doc.linearGradient(0, fadeTop, 0, HEADER_H + HERO_H);
      fade.stop(0, NAVY, 0).stop(1, NAVY, 1);
      doc.rect(0, fadeTop, W, 70).fill(fade);

      // --- Headline block ----------------------------------------------------
      const HEAD_TOP = HEADER_H + HERO_H;
      const HEAD_H = 92;
      doc.rect(0, HEAD_TOP, W, HEAD_H).fill(NAVY);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(34)
        .text('When Where Matters.', M, HEAD_TOP - 6, { width: W - 2 * M, lineBreak: false });
      doc.fillColor('#cfe0f2').font('Helvetica').fontSize(14)
        .text('See your team, share information, save lives.', M, HEAD_TOP + 40, { width: W - 2 * M, lineBreak: false });
      doc.rect(M, HEAD_TOP + 68, 56, 3).fill(BLUE);

      // --- Intro -------------------------------------------------------------
      let y = HEAD_TOP + HEAD_H + 22;
      doc.fillColor(INK).font('Helvetica').fontSize(11).text(
        'TAK.NZ (Team Awareness Kit) transforms emergency response in New Zealand by delivering ' +
        'real-time location data and a unified operational view when seconds count.',
        M, y, { width: W - 2 * M, lineGap: 3 }
      );
      y = doc.y + 20;

      // --- Three benefits ----------------------------------------------------
      const features = [
        {
          icon: 'icon-situational-awareness.png',
          title: 'Situational Awareness',
          text: 'Improves the operational efficiency of emergency responders by sharing incident information.'
        },
        {
          icon: 'icon-safety.png',
          title: 'Safety',
          text: 'Empowers emergency responders to make well-informed decisions based on real-time data.'
        },
        {
          icon: 'icon-team-coordination.png',
          title: 'Team Coordination',
          text: 'Emergency responders can locate themselves, their team members and other enrolled personnel in real-time.'
        }
      ];
      const GAP = 18;
      const colW = (W - 2 * M - 2 * GAP) / 3;
      const featTop = y;
      features.forEach((f, i) => {
        const x = M + i * (colW + GAP);
        doc.circle(x + 20, featTop + 20, 20).fill(TINT);
        doc.image(path.join(assets, f.icon), x + 8, featTop + 8, { width: 24, height: 24 });
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11.5)
          .text(f.title, x, featTop + 50, { width: colW, lineBreak: false });
        doc.fillColor(MUTED).font('Helvetica').fontSize(9.5)
          .text(f.text, x, featTop + 68, { width: colW, lineGap: 2 });
      });

      // --- Call-to-action card ---------------------------------------------
      const CARD_H = 168;
      const cardTop = H - 54 - CARD_H;
      doc.roundedRect(M, cardTop, W - 2 * M, CARD_H, 10).fill(PANEL);
      doc.roundedRect(M, cardTop, W - 2 * M, CARD_H, 10).lineWidth(1).stroke(RULE);
      doc.rect(M, cardTop + 14, 4, CARD_H - 28).fill(BLUE);

      const QR = 124;
      const qrX = W - M - 22 - QR;
      const qrY = cardTop + (CARD_H - QR) / 2;
      const textX = M + 26;
      const textW = qrX - textX - 22;

      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9)
        .text('YOUR TEAM IS ON TAK.NZ', textX, cardTop + 20, { width: textW, characterSpacing: 1, lineBreak: false });
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(20)
        .text(`Join ${teamName}`, textX, cardTop + 36, { width: textW, height: 50, ellipsis: true });
      const afterTitle = Math.max(doc.y, cardTop + 62) + 4;
      doc.fillColor(INK).font('Helvetica').fontSize(10)
        .text('Scan the QR code with your phone camera, or visit:', textX, afterTitle, { width: textW });
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9.5)
        .text(url, textX, doc.y + 2, { width: textW, link: url, underline: true });
      const codeY = doc.y + 10;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9)
        .text('If prompted, enter this sign-up code:', textX, codeY, { width: textW, lineBreak: false });
      doc.fillColor(NAVY).font('Courier-Bold').fontSize(18)
        .text(SignupCodeService.formatCode(code), textX, codeY + 13, { width: textW, characterSpacing: 2, lineBreak: false });

      doc.roundedRect(qrX - 8, qrY - 8, QR + 16, QR + 16, 8).fill('#ffffff');
      doc.image(qrBuffer, qrX, qrY, { width: QR });

      // --- Footer --------------------------------------------------------------
      doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(
        'TAK.NZ is available to all New Zealand public safety organisations.  This sign-up code does not expire.',
        M, H - 36, { width: W - 2 * M, align: 'center', lineBreak: false }
      );
      doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(8.5)
        .text('tak.nz', M, H - 22, { width: W - 2 * M, align: 'center', link: 'https://tak.nz/', lineBreak: false });

      doc.end();
    });
  }
}

module.exports = SignupCodeService;
