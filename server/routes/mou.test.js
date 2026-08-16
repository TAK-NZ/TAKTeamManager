/**
 * Integration tests for `server/routes/mou.js` (Requirement 28, task
 * 50.5).
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked) -- mirroring `server/routes/auditLogs.test.js`'s
 * established pattern -- so each test below exercises the actual
 * Permission_Registry entries added for this route file: a
 * Global_Manager-only route rejecting a non-Global_Manager caller with
 * 403 (and never invoking the service) is a real regression test for
 * those registry entries, not an assumption.
 *
 * `MouService` is mocked so these tests are scoped to the route
 * handlers' own behavior (request/response shape, status-code mapping
 * for each named error class) rather than `MouService`'s own logic,
 * which is already covered by `server/services/MouService.test.js`.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/MouService', () => {
  class MouDocumentNotFoundError extends Error {
    constructor(documentId) {
      super(`MOU document ${documentId} was not found`);
      this.name = 'MouDocumentNotFoundError';
    }
  }
  class MouSignatureValidationError extends Error {
    constructor(message = 'Exactly one of signerUserId or signerTeamId must be provided') {
      super(message);
      this.name = 'MouSignatureValidationError';
    }
  }
  class MouInvalidSignatureMethodError extends Error {
    constructor(method) {
      super(`Invalid signature method '${method}'`);
      this.name = 'MouInvalidSignatureMethodError';
    }
  }
  class MouSignatureAuthorizationError extends Error {
    constructor(message = 'Insufficient authorization to record this MOU signature') {
      super(message);
      this.name = 'MouSignatureAuthorizationError';
    }
  }
  class MouSignatureAlreadyExistsError extends Error {
    constructor(message = 'A signature already exists for this document and signer') {
      super(message);
      this.name = 'MouSignatureAlreadyExistsError';
    }
  }
  class MouSignatureNotFoundError extends Error {
    constructor(signatureId) {
      super(`MOU signature ${signatureId} was not found`);
      this.name = 'MouSignatureNotFoundError';
    }
  }
  class MouCountersignatureAuthorizationError extends Error {
    constructor(message = 'Only a Global_Manager may record an MOU countersignature') {
      super(message);
      this.name = 'MouCountersignatureAuthorizationError';
    }
  }
  class MouCountersignatureNotRequiredError extends Error {
    constructor(message = 'This MOU document does not require a countersignature') {
      super(message);
      this.name = 'MouCountersignatureNotRequiredError';
    }
  }
  class MouSignatureAlreadyCountersignedError extends Error {
    constructor(message = 'This MOU signature has already been countersigned') {
      super(message);
      this.name = 'MouSignatureAlreadyCountersignedError';
    }
  }

  const mockInstance = {
    createDocument: jest.fn(),
    updateDocument: jest.fn(),
    setAsCurrentAgreement: jest.fn(),
    recordSignature: jest.fn(),
    recordCountersignature: jest.fn()
  };

  const MockMouService = jest.fn(() => mockInstance);
  MockMouService.MouDocumentNotFoundError = MouDocumentNotFoundError;
  MockMouService.MouSignatureValidationError = MouSignatureValidationError;
  MockMouService.MouInvalidSignatureMethodError = MouInvalidSignatureMethodError;
  MockMouService.MouSignatureAuthorizationError = MouSignatureAuthorizationError;
  MockMouService.MouSignatureAlreadyExistsError = MouSignatureAlreadyExistsError;
  MockMouService.MouSignatureNotFoundError = MouSignatureNotFoundError;
  MockMouService.MouCountersignatureAuthorizationError = MouCountersignatureAuthorizationError;
  MockMouService.MouCountersignatureNotRequiredError = MouCountersignatureNotRequiredError;
  MockMouService.MouSignatureAlreadyCountersignedError = MouSignatureAlreadyCountersignedError;
  MockMouService.VALID_SIGNATURE_METHODS = ['e_signature', 'uploaded_scan'];
  MockMouService.__mockInstance = mockInstance;

  return MockMouService;
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const MouService = require('../services/MouService');
const mouRouter = require('./mou');

const mouServiceInstance = MouService.__mockInstance;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mou', mouRouter);
  return app;
}

function asGlobalManager() {
  mockUser = { id: 1, userId: 1, is_global_manager: true };
}

function asStandardUser(userId = 2) {
  mockUser = { id: userId, userId, is_global_manager: false };
}

describe('POST /api/mou/documents', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager with 403 and never calls the service', async () => {
    asStandardUser();

    const res = await request(app).post('/api/mou/documents').send({
      title: 'Agreement',
      body: 'Body text'
    });

    expect(res.status).toBe(403);
    expect(mouServiceInstance.createDocument).not.toHaveBeenCalled();
  });

  it('creates a document for a Global_Manager', async () => {
    asGlobalManager();
    mouServiceInstance.createDocument.mockResolvedValue({ id: 1, title: 'Agreement' });

    const res = await request(app).post('/api/mou/documents').send({
      title: 'Agreement',
      body: 'Body text'
    });

    expect(res.status).toBe(201);
    expect(res.body.document).toEqual({ id: 1, title: 'Agreement' });
    expect(mouServiceInstance.createDocument).toHaveBeenCalledWith(
      { title: 'Agreement', body: 'Body text', teamId: null, requiresCountersignature: undefined },
      1
    );
  });

  it('returns 400 on invalid body without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).post('/api/mou/documents').send({ title: '' });

    expect(res.status).toBe(400);
    expect(mouServiceInstance.createDocument).not.toHaveBeenCalled();
  });
});

describe('PUT /api/mou/documents/:documentId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager with 403 and never calls the service', async () => {
    asStandardUser();

    const res = await request(app).put('/api/mou/documents/1').send({ title: 'New title' });

    expect(res.status).toBe(403);
    expect(mouServiceInstance.updateDocument).not.toHaveBeenCalled();
  });

  it('updates a document for a Global_Manager', async () => {
    asGlobalManager();
    mouServiceInstance.updateDocument.mockResolvedValue({ id: 1, title: 'New title' });

    const res = await request(app).put('/api/mou/documents/1').send({ title: 'New title' });

    expect(res.status).toBe(200);
    expect(res.body.document).toEqual({ id: 1, title: 'New title' });
  });

  it('maps MouDocumentNotFoundError to 404', async () => {
    asGlobalManager();
    mouServiceInstance.updateDocument.mockRejectedValue(new MouService.MouDocumentNotFoundError(99));

    const res = await request(app).put('/api/mou/documents/99').send({ title: 'x' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/mou/documents/:documentId/set-current', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager with 403 and never calls the service', async () => {
    asStandardUser();

    const res = await request(app).post('/api/mou/documents/1/set-current');

    expect(res.status).toBe(403);
    expect(mouServiceInstance.setAsCurrentAgreement).not.toHaveBeenCalled();
  });

  it('sets the current agreement for a Global_Manager', async () => {
    asGlobalManager();
    mouServiceInstance.setAsCurrentAgreement.mockResolvedValue({ id: 1, is_current_agreement: true });

    const res = await request(app).post('/api/mou/documents/1/set-current');

    expect(res.status).toBe(200);
    expect(res.body.document).toEqual({ id: 1, is_current_agreement: true });
    expect(mouServiceInstance.setAsCurrentAgreement).toHaveBeenCalledWith('1', 1);
  });
});

describe('POST /api/mou/:documentId/sign', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('allows a standard authenticated user to reach the handler (team-admin success case)', async () => {
    asStandardUser(5);
    mouServiceInstance.recordSignature.mockResolvedValue({
      id: 10,
      mou_document_id: 1,
      signer_team_id: 3
    });

    const res = await request(app).post('/api/mou/1/sign').send({
      signerTeamId: 3,
      method: 'e_signature'
    });

    expect(res.status).toBe(201);
    expect(res.body.signature).toEqual({ id: 10, mou_document_id: 1, signer_team_id: 3 });
    expect(mouServiceInstance.recordSignature).toHaveBeenCalledWith(
      '1',
      { signerUserId: null, signerTeamId: 3 },
      'e_signature',
      mockUser,
      null
    );
  });

  it('allows a standard authenticated user to self-sign a serverwide document', async () => {
    asStandardUser(5);
    mouServiceInstance.recordSignature.mockResolvedValue({
      id: 11,
      mou_document_id: 1,
      signer_user_id: 5
    });

    const res = await request(app).post('/api/mou/1/sign').send({
      signerUserId: 5,
      method: 'e_signature'
    });

    expect(res.status).toBe(201);
    expect(res.body.signature.signer_user_id).toBe(5);
  });

  it('maps MouSignatureAuthorizationError from the service to 403', async () => {
    asStandardUser(5);
    mouServiceInstance.recordSignature.mockRejectedValue(
      new MouService.MouSignatureAuthorizationError()
    );

    const res = await request(app).post('/api/mou/1/sign').send({
      signerUserId: 999,
      method: 'e_signature'
    });

    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid signature method without calling the service', async () => {
    asStandardUser(5);

    const res = await request(app).post('/api/mou/1/sign').send({
      signerUserId: 5,
      method: 'not-a-real-method'
    });

    expect(res.status).toBe(400);
    expect(mouServiceInstance.recordSignature).not.toHaveBeenCalled();
  });
});

describe('POST /api/mou/signatures/:signatureId/countersign', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager with 403 at the route layer and never calls the service', async () => {
    asStandardUser();

    const res = await request(app).post('/api/mou/signatures/10/countersign');

    expect(res.status).toBe(403);
    expect(mouServiceInstance.recordCountersignature).not.toHaveBeenCalled();
  });

  it('records a countersignature for a Global_Manager', async () => {
    asGlobalManager();
    mouServiceInstance.recordCountersignature.mockResolvedValue({
      id: 10,
      countersigned_by: 1
    });

    const res = await request(app).post('/api/mou/signatures/10/countersign');

    expect(res.status).toBe(200);
    expect(res.body.signature).toEqual({ id: 10, countersigned_by: 1 });
  });
});

describe('GET /api/mou/documents/:documentId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the document for any authenticated user', async () => {
    asStandardUser();
    pool.query.mockResolvedValue({ rows: [{ id: 1, title: 'Agreement' }] });

    const res = await request(app).get('/api/mou/documents/1');

    expect(res.status).toBe(200);
    expect(res.body.document).toEqual({ id: 1, title: 'Agreement' });
  });

  it('returns 404 when the document does not exist', async () => {
    asStandardUser();
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/mou/documents/99');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/mou/current-agreement', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the current agreement for any authenticated user', async () => {
    asStandardUser();
    pool.query.mockResolvedValue({ rows: [{ id: 1, is_current_agreement: true }] });

    const res = await request(app).get('/api/mou/current-agreement');

    expect(res.status).toBe(200);
    expect(res.body.currentAgreement).toEqual({ id: 1, is_current_agreement: true });
  });

  it('returns null when no current agreement exists', async () => {
    asStandardUser();
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/mou/current-agreement');

    expect(res.status).toBe(200);
    expect(res.body.currentAgreement).toBeNull();
  });
});
