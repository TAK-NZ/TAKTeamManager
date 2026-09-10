/**
 * Unit tests for EmailService (Requirement 6.5: generic SMTP configuration
 * via nodemailer, not tied to any single provider).
 *
 * Covers:
 *  - the constructor builds a nodemailer transport from the generic
 *    EMAIL_* environment variables (host/port/auth/TLS/timeout), not
 *    AWS-specific credentials.
 *  - `sendEmail` looks up the template, substitutes variables, and
 *    dispatches via `transporter.sendMail`.
 *  - `sendVerificationEmail`, `sendApprovalEmail`, `sendDenialEmail` still
 *    delegate to `sendEmail` with the expected template key/variables.
 *  - `replaceVariables` substitutes template placeholders.
 *  - `getConfigValue` falls back to the default on a DB error.
 *
 * `nodemailer.createTransport` is mocked so no real SMTP connection is
 * ever made.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn().mockImplementation(() => ({
  sendMail: mockSendMail
}));
jest.mock('nodemailer', () => ({
  createTransport: mockCreateTransport
}));

const pool = require('../config/database');
const EmailService = require('./EmailService');

const ORIGINAL_ENV = { ...process.env };

describe('EmailService', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    process.env.EMAIL_HOST = 'smtp.example.com';
    process.env.EMAIL_PORT = '587';
    process.env.EMAIL_USERNAME = 'smtp-user';
    process.env.EMAIL_PASSWORD = 'smtp-pass';
    process.env.EMAIL_USE_TLS = 'true';
    process.env.EMAIL_USE_SSL = 'false';
    process.env.EMAIL_TIMEOUT = '10';
    process.env.EMAIL_FROM = 'noreply@example.com';
    mockSendMail.mockResolvedValue({ messageId: 'msg-123' });
    service = new EmailService();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('constructor', () => {
    it('builds a nodemailer transport from the generic EMAIL_* variables', () => {
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          requireTLS: true,
          auth: {
            user: 'smtp-user',
            pass: 'smtp-pass'
          },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 10000
        })
      );
    });

    it('uses implicit TLS (secure: true) and does not set requireTLS/ignoreTLS when EMAIL_USE_SSL=true', () => {
      process.env.EMAIL_USE_SSL = 'true';
      process.env.EMAIL_PORT = '465';
      mockCreateTransport.mockClear();

      new EmailService();

      const options = mockCreateTransport.mock.calls[0][0];
      expect(options.secure).toBe(true);
      expect(options.port).toBe(465);
      expect(options).not.toHaveProperty('requireTLS');
      expect(options).not.toHaveProperty('ignoreTLS');
    });

    it('sets ignoreTLS when EMAIL_USE_TLS=false and EMAIL_USE_SSL is not true', () => {
      process.env.EMAIL_USE_TLS = 'false';
      process.env.EMAIL_USE_SSL = 'false';
      mockCreateTransport.mockClear();

      new EmailService();

      const options = mockCreateTransport.mock.calls[0][0];
      expect(options.secure).toBe(false);
      expect(options.ignoreTLS).toBe(true);
      expect(options).not.toHaveProperty('requireTLS');
    });

    it('defaults port to 587 and timeout to 10s when EMAIL_PORT/EMAIL_TIMEOUT are unset', () => {
      delete process.env.EMAIL_PORT;
      delete process.env.EMAIL_TIMEOUT;
      mockCreateTransport.mockClear();

      new EmailService();

      const options = mockCreateTransport.mock.calls[0][0];
      expect(options.port).toBe(587);
      expect(options.connectionTimeout).toBe(10000);
    });

    // Regression: an ECS EnvironmentFile does not strip surrounding quotes, so
    // EMAIL_FROM="Name <addr>" arrived with literal quotes and nodemailer
    // mangled the From header into `<"Name addr"@host>`. The constructor now
    // strips one matched surrounding quote pair.
    it('strips a matched pair of surrounding quotes from EMAIL_FROM', () => {
      process.env.EMAIL_FROM = '"TAK.NZ Account <account@tak.nz>"';

      const svc = new EmailService();

      expect(svc.fromAddress).toBe('TAK.NZ Account <account@tak.nz>');
    });

    it('leaves an already-unquoted EMAIL_FROM untouched', () => {
      process.env.EMAIL_FROM = 'TAK.NZ Account <account@tak.nz>';

      const svc = new EmailService();

      expect(svc.fromAddress).toBe('TAK.NZ Account <account@tak.nz>');
    });

    it('uses the de-quoted EMAIL_FROM as the sent message From header', async () => {
      process.env.EMAIL_FROM = '"TAK.NZ Account <account@tak.nz>"';
      const svc = new EmailService();
      pool.query.mockResolvedValue({
        rows: [{ subject_template: 'Subj', body_template: 'Body' }]
      });

      await svc.sendEmail('user@example.com', 'any_template', {});

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'TAK.NZ Account <account@tak.nz>' })
      );
    });
  });

  describe('sendEmail', () => {
    it('sends via transporter.sendMail with the expected shape', async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            subject_template: 'Hello {{name}}',
            body_template: 'Welcome, {{name}}!'
          }
        ]
      });

      const result = await service.sendEmail('user@example.com', 'some_template', {
        name: 'Alice'
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@example.com',
          to: 'user@example.com',
          subject: 'Hello Alice',
          text: 'Welcome, Alice!',
          html: expect.stringContaining('Welcome, Alice!')
        })
      );
      expect(result).toEqual({ messageId: 'msg-123' });
    });

    it('throws when the template is not found and does not call sendMail', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await expect(
        service.sendEmail('user@example.com', 'missing_template')
      ).rejects.toThrow('Email template not found: missing_template');

      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('propagates an error thrown by the SMTP transport', async () => {
      pool.query.mockResolvedValue({
        rows: [{ subject_template: 'Subj', body_template: 'Body' }]
      });
      mockSendMail.mockRejectedValue(new Error('SMTP server unreachable'));

      await expect(
        service.sendEmail('user@example.com', 'some_template')
      ).rejects.toThrow('SMTP server unreachable');
    });
  });

  describe('replaceVariables', () => {
    it('substitutes all occurrences of each placeholder', () => {
      const result = service.replaceVariables('{{a}} and {{a}} and {{b}}', {
        a: 'X',
        b: 'Y'
      });
      expect(result).toBe('X and X and Y');
    });

    it('replaces a null/undefined variable value with an empty string', () => {
      const result = service.replaceVariables('Hello {{name}}', { name: undefined });
      expect(result).toBe('Hello ');
    });

    it('leaves a placeholder untouched when no matching key is supplied at all', () => {
      const result = service.replaceVariables('Hello {{name}}', {});
      expect(result).toBe('Hello {{name}}');
    });
  });

  describe('sendVerificationEmail', () => {
    it('sends the access_request_verification template with a verification link', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ config_value: '48' }] }) // getConfigValue
        .mockResolvedValueOnce({
          rows: [{ subject_template: 'Verify', body_template: '{{verification_link}} in {{expiry_hours}}h' }]
        });
      process.env.FRONTEND_URL = 'https://app.example.com';

      await service.sendVerificationEmail('user@example.com', 'tok-123');

      const sentArgs = mockSendMail.mock.calls[0][0];
      expect(sentArgs.text).toBe('https://app.example.com/request-access?token=tok-123 in 48h');
    });
  });

  describe('sendApprovalEmail', () => {
    it('sends the access_request_approved template with the supplied details', async () => {
      process.env.PASSWORD_RESET_URL = 'https://reset.example.com';
      process.env.ACCOUNT_LOGIN_URL = 'https://login.example.com';

      pool.query.mockResolvedValue({
        rows: [
          {
            subject_template: 'Approved',
            body_template: 'Team: {{team_path}} User: {{username}} Callsign: {{callsign}} Reset: {{password_reset_url}} Login: {{login_url}}'
          }
        ]
      });

      await service.sendApprovalEmail('user@example.com', {
        teamPath: 'FENZ - Southland',
        username: 'user@example.com',
        callsign: 'FENZ-STL-User'
      });

      const sentArgs = mockSendMail.mock.calls[0][0];
      expect(sentArgs.text).toBe('Team: FENZ - Southland User: user@example.com Callsign: FENZ-STL-User Reset: https://reset.example.com Login: https://login.example.com');

      delete process.env.PASSWORD_RESET_URL;
      delete process.env.ACCOUNT_LOGIN_URL;
    });
  });

  describe('sendDenialEmail', () => {
    it('sends the access_request_denied template with the denial reason', async () => {
      pool.query.mockResolvedValue({
        rows: [
          {
            subject_template: 'Denied',
            body_template: 'Hi {{first_name}}, denied for {{team_path}}: {{denial_reason}}'
          }
        ]
      });

      await service.sendDenialEmail('user@example.com', { teamPath: 'FENZ', firstName: 'Alice', denialReason: 'not eligible' });

      const sentArgs = mockSendMail.mock.calls[0][0];
      expect(sentArgs.text).toBe('Hi Alice, denied for FENZ: not eligible');
    });
  });

  describe('getConfigValue', () => {
    it('returns the DB value when present', async () => {
      pool.query.mockResolvedValue({ rows: [{ config_value: '72' }] });
      const value = await service.getConfigValue('email_verification_hours', '24');
      expect(value).toBe('72');
    });

    it('returns the default value when no row is found', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      const value = await service.getConfigValue('missing_key', '24');
      expect(value).toBe('24');
    });

    it('returns the default value when the query throws', async () => {
      pool.query.mockRejectedValue(new Error('DB unreachable'));
      const value = await service.getConfigValue('email_verification_hours', '24');
      expect(value).toBe('24');
    });
  });
});
