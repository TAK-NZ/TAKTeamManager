jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const MouService = require('./MouService');
const {
  MouDocumentNotFoundError,
  MouSignatureValidationError,
  MouInvalidSignatureMethodError,
  MouSignatureAuthorizationError,
  MouSignatureAlreadyExistsError,
  MouSignatureNotFoundError,
  MouCountersignatureAuthorizationError,
  MouCountersignatureNotRequiredError,
  MouSignatureAlreadyCountersignedError
} = require('./MouService');

describe('MouService.createDocument', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MouService();
  });

  it('inserts a new mou_documents row with version 1, is_active true, and is_current_agreement false', async () => {
    const createdRow = {
      id: 1,
      title: 'Serverwide Agreement',
      body: 'Body text',
      team_id: null,
      requires_countersignature: false,
      version: 1,
      is_current_agreement: false,
      is_active: true,
      created_by: 7,
      updated_by: 7
    };
    pool.query.mockResolvedValueOnce({ rows: [createdRow] });

    const result = await service.createDocument(
      { title: 'Serverwide Agreement', body: 'Body text' },
      7
    );

    expect(result).toEqual(createdRow);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO mou_documents');
    expect(sql).toContain('version, is_current_agreement, is_active');
    expect(params).toEqual(['Serverwide Agreement', 'Body text', null, false, 7]);
  });

  it('creates a team-scoped document when teamId is supplied', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 2, team_id: 10 }] });

    await service.createDocument(
      { title: 'Team Doc', body: 'Body', teamId: 10, requiresCountersignature: true },
      7
    );

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(['Team Doc', 'Body', 10, true, 7]);
  });

  it('defaults requiresCountersignature to false when omitted', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3 }] });

    await service.createDocument({ title: 'Doc', body: 'Body' }, 7);

    const [, params] = pool.query.mock.calls[0];
    expect(params[3]).toBe(false);
  });
});

describe('MouService.updateDocument', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MouService();
  });

  it('updates title/body/requiresCountersignature and returns the updated row', async () => {
    const updatedRow = {
      id: 1,
      title: 'New Title',
      body: 'New Body',
      requires_countersignature: true,
      updated_by: 9
    };
    pool.query.mockResolvedValueOnce({ rows: [updatedRow] });

    const result = await service.updateDocument(
      1,
      { title: 'New Title', body: 'New Body', requiresCountersignature: true },
      9
    );

    expect(result).toEqual(updatedRow);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE mou_documents');
    expect(sql).toContain('COALESCE');
    expect(params).toEqual(['New Title', 'New Body', true, 9, 1]);
  });

  it('preserves existing values for omitted fields via COALESCE (passes null, not false, for an omitted boolean)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Only Title' }] });

    await service.updateDocument(1, { title: 'Only Title' }, 9);

    const [, params] = pool.query.mock.calls[0];
    // [title, body, requiresCountersignature, updatedBy, documentId]
    expect(params[0]).toBe('Only Title');
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
    expect(params[3]).toBe(9);
    expect(params[4]).toBe(1);
  });

  it('throws MouDocumentNotFoundError when the target row does not exist, without any further mutation', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.updateDocument(999, { title: 'X' }, 9)
    ).rejects.toThrow(MouDocumentNotFoundError);
  });
});

describe('MouService.setAsCurrentAgreement', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    service = new MouService();
  });

  it('flips is_current_agreement directly on the target row when no current agreement exists yet', async () => {
    const targetRow = { id: 5, title: 'Doc', version: 1, is_current_agreement: false };
    const flippedRow = { ...targetRow, is_current_agreement: true };

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.resolve({ rows: [targetRow] });
      }
      if (typeof sql === 'string' && sql.includes('WHERE is_current_agreement = true')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE mou_documents')) {
        return Promise.resolve({ rows: [flippedRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setAsCurrentAgreement(5, 9);

    expect(result).toEqual(flippedRow);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');
    // No new row inserted in this branch.
    expect(calledSql.some((sql) => sql.includes('INSERT INTO mou_documents'))).toBe(false);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('is an idempotent no-op when the target row is already the current agreement', async () => {
    const currentRow = { id: 5, title: 'Doc', version: 1, is_current_agreement: true };

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.resolve({ rows: [currentRow] });
      }
      if (typeof sql === 'string' && sql.includes('WHERE is_current_agreement = true')) {
        return Promise.resolve({ rows: [currentRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setAsCurrentAgreement(5, 9);

    expect(result).toEqual(currentRow);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO mou_documents'))).toBe(false);
    expect(calledSql.some((sql) => sql.includes('UPDATE mou_documents'))).toBe(false);
    expect(calledSql).toContain('COMMIT');
  });

  it('supersedes an existing different current agreement: inserts a fresh row with version+1 and flips off the old row (only one current agreement at a time)', async () => {
    const targetRow = {
      id: 5,
      title: 'New Content',
      body: 'New Body',
      team_id: null,
      requires_countersignature: false,
      version: 3,
      is_current_agreement: false
    };
    const oldCurrentRow = { id: 2, title: 'Old Content', version: 1, is_current_agreement: true };
    const newCurrentRow = { id: 6, title: 'New Content', version: 4, is_current_agreement: true };

    mockClient.query.mockImplementation((sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.resolve({ rows: [targetRow] });
      }
      if (typeof sql === 'string' && sql.includes('WHERE is_current_agreement = true')) {
        return Promise.resolve({ rows: [oldCurrentRow] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO mou_documents')) {
        expect(params).toEqual([
          targetRow.title,
          targetRow.body,
          targetRow.team_id,
          targetRow.requires_countersignature,
          targetRow.version + 1,
          9
        ]);
        return Promise.resolve({ rows: [newCurrentRow] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE mou_documents') && sql.includes('is_current_agreement = false')) {
        expect(params).toEqual([oldCurrentRow.id, 9]);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setAsCurrentAgreement(5, 9);

    expect(result).toEqual(newCurrentRow);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO mou_documents'))).toBe(true);
    expect(
      calledSql.some((sql) => sql.includes('UPDATE mou_documents') && sql.includes('is_current_agreement = false'))
    ).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');
  });

  it('locks both the target row and any existing current row with SELECT ... FOR UPDATE', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: 5, version: 1 }] });
      }
      if (typeof sql === 'string' && sql.includes('WHERE is_current_agreement = true')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ id: 5, is_current_agreement: true }] });
    });

    await service.setAsCurrentAgreement(5, 9);

    const targetSelect = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('SELECT * FROM mou_documents WHERE id = $1')
    );
    expect(targetSelect[0]).toContain('FOR UPDATE');

    const currentSelect = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('WHERE is_current_agreement = true')
    );
    expect(currentSelect[0]).toContain('FOR UPDATE');
  });

  it('throws MouDocumentNotFoundError and rolls back when the target document does not exist', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.setAsCurrentAgreement(999, 9)).rejects.toThrow(MouDocumentNotFoundError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and propagates an unexpected database error', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM mou_documents WHERE id = $1')) {
        return Promise.reject(new Error('db connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.setAsCurrentAgreement(5, 9)).rejects.toThrow('db connection lost');

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('MouService.recordSignature', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MouService();
  });

  it('rejects when neither signerUserId nor signerTeamId is provided, without querying the database', async () => {
    await expect(
      service.recordSignature(1, {}, 'e_signature', { userId: 1, is_global_manager: true })
    ).rejects.toThrow(MouSignatureValidationError);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects when both signerUserId and signerTeamId are provided, without querying the database', async () => {
    await expect(
      service.recordSignature(
        1,
        { signerUserId: 5, signerTeamId: 10 },
        'e_signature',
        { userId: 1, is_global_manager: true }
      )
    ).rejects.toThrow(MouSignatureValidationError);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature method, without querying the database', async () => {
    await expect(
      service.recordSignature(
        1,
        { signerUserId: 5 },
        'carrier_pigeon',
        { userId: 1, is_global_manager: true }
      )
    ).rejects.toThrow(MouInvalidSignatureMethodError);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('throws MouDocumentNotFoundError when the target document does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.recordSignature(
        999,
        { signerUserId: 5 },
        'e_signature',
        { userId: 5, is_global_manager: false }
      )
    ).rejects.toThrow(MouDocumentNotFoundError);
  });

  it('allows a team admin to sign on behalf of their team for a team-scoped document', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, team_id: 10 }] }); // document lookup
    Team.isAdmin.mockResolvedValueOnce(true);
    const createdRow = { id: 100, mou_document_id: 1, signer_team_id: 10, signature_method: 'e_signature' };
    pool.query.mockResolvedValueOnce({ rows: [createdRow] }); // insert

    const result = await service.recordSignature(
      1,
      { signerTeamId: 10 },
      'e_signature',
      { userId: 7, is_global_manager: false }
    );

    expect(Team.isAdmin).toHaveBeenCalledWith(10, 7);
    expect(result).toEqual(createdRow);

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO mou_signatures');
    expect(params).toEqual([1, null, 10, 'e_signature', null]);
  });

  it('allows a Global_Manager to sign any document, including on behalf of a team', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 2, team_id: 20 }] }); // document lookup
    const createdRow = { id: 101, mou_document_id: 2, signer_team_id: 20 };
    pool.query.mockResolvedValueOnce({ rows: [createdRow] }); // insert

    const result = await service.recordSignature(
      2,
      { signerTeamId: 20 },
      'e_signature',
      { userId: 1, is_global_manager: true }
    );

    // Global_Manager short-circuits before any Team.isAdmin lookup.
    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result).toEqual(createdRow);
  });

  it('allows any authenticated user to self-sign a serverwide document as themselves', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3, team_id: null }] }); // serverwide document
    const createdRow = { id: 102, mou_document_id: 3, signer_user_id: 42 };
    pool.query.mockResolvedValueOnce({ rows: [createdRow] }); // insert

    const result = await service.recordSignature(
      3,
      { signerUserId: 42 },
      'e_signature',
      { userId: 42, is_global_manager: false }
    );

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result).toEqual(createdRow);
  });

  it('rejects a non-admin, non-Global_Manager user attempting to sign a team-scoped document', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 4, team_id: 30 }] }); // document lookup
    Team.isAdmin.mockResolvedValueOnce(false);

    await expect(
      service.recordSignature(
        4,
        { signerUserId: 8 },
        'e_signature',
        { userId: 8, is_global_manager: false }
      )
    ).rejects.toThrow(MouSignatureAuthorizationError);

    // Only the document lookup ran -- no INSERT was attempted.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Global_Manager user attempting to sign on behalf of a team for a serverwide document', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, team_id: null }] }); // serverwide document

    await expect(
      service.recordSignature(
        5,
        { signerTeamId: 15 },
        'e_signature',
        { userId: 9, is_global_manager: false }
      )
    ).rejects.toThrow(MouSignatureAuthorizationError);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a user attempting to self-sign as a different user id on a serverwide document', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 6, team_id: null }] });

    await expect(
      service.recordSignature(
        6,
        { signerUserId: 999 },
        'e_signature',
        { userId: 9, is_global_manager: false }
      )
    ).rejects.toThrow(MouSignatureAuthorizationError);
  });

  it('translates a unique-violation (23505) into MouSignatureAlreadyExistsError', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7, team_id: null }] }); // document lookup
    const duplicateError = new Error('duplicate key value violates unique constraint');
    duplicateError.code = '23505';
    pool.query.mockRejectedValueOnce(duplicateError);

    await expect(
      service.recordSignature(
        7,
        { signerUserId: 9 },
        'e_signature',
        { userId: 9, is_global_manager: false }
      )
    ).rejects.toThrow(MouSignatureAlreadyExistsError);
  });
});

describe('MouService.recordCountersignature', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    service = new MouService();
  });

  it('rejects a non-Global_Manager without acquiring a client or touching the database', async () => {
    await expect(
      service.recordCountersignature(1, { userId: 5, is_global_manager: false })
    ).rejects.toThrow(MouCountersignatureAuthorizationError);

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('succeeds when the document requires a countersignature and the signature is not yet countersigned', async () => {
    const signatureRow = {
      id: 1,
      mou_document_id: 1,
      requires_countersignature: true,
      countersigned_at: null
    };
    const updatedRow = { ...signatureRow, countersigned_by: 3, countersigned_at: new Date() };

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT s.*')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE mou_signatures')) {
        return Promise.resolve({ rows: [updatedRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.recordCountersignature(1, { userId: 3, is_global_manager: true });

    expect(result).toEqual(updatedRow);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with MouCountersignatureNotRequiredError when requires_countersignature is false', async () => {
    const signatureRow = {
      id: 2,
      mou_document_id: 2,
      requires_countersignature: false,
      countersigned_at: null
    };

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT s.*')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.recordCountersignature(2, { userId: 3, is_global_manager: true })
    ).rejects.toThrow(MouCountersignatureNotRequiredError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql.some((sql) => sql.includes('UPDATE mou_signatures'))).toBe(false);
  });

  it('rejects with MouSignatureNotFoundError when the signature does not exist', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT s.*')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.recordCountersignature(999, { userId: 3, is_global_manager: true })
    ).rejects.toThrow(MouSignatureNotFoundError);
  });

  it('rejects with MouSignatureAlreadyCountersignedError when already countersigned', async () => {
    const signatureRow = {
      id: 3,
      mou_document_id: 3,
      requires_countersignature: true,
      countersigned_at: new Date()
    };

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT s.*')) {
        return Promise.resolve({ rows: [signatureRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.recordCountersignature(3, { userId: 3, is_global_manager: true })
    ).rejects.toThrow(MouSignatureAlreadyCountersignedError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('ROLLBACK');
  });
});

describe('MouService countersignature-required document lifecycle (recordSignature -> recordCountersignature)', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    service = new MouService();
  });

  it('remains incomplete (countersigned_at null) after recordSignature alone, and only becomes complete after a separate recordCountersignature call', async () => {
    // Step 1: sign a document that requires a countersignature. The
    // `mou_signatures` INSERT has no countersigned_by/countersigned_at
    // in its column list, so the RETURNING row reflects the table's own
    // null default -- signing alone must NOT satisfy the requirement.
    const document = { id: 1, team_id: null, requires_countersignature: true };
    pool.query.mockResolvedValueOnce({ rows: [document] }); // document lookup

    const freshSignatureRow = {
      id: 50,
      mou_document_id: 1,
      signer_user_id: 42,
      signer_team_id: null,
      signature_method: 'e_signature',
      countersigned_by: null,
      countersigned_at: null
    };
    pool.query.mockResolvedValueOnce({ rows: [freshSignatureRow] }); // insert

    const signResult = await service.recordSignature(
      1,
      { signerUserId: 42 },
      'e_signature',
      { userId: 42, is_global_manager: false }
    );

    expect(signResult).toEqual(freshSignatureRow);
    expect(signResult.countersigned_at).toBeNull();

    // Step 2: a distinct recordCountersignature call, by a
    // Global_Manager, against that same signature id, is what actually
    // completes it.
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT s.*')) {
        return Promise.resolve({
          rows: [{ ...freshSignatureRow, requires_countersignature: true }]
        });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE mou_signatures')) {
        return Promise.resolve({
          rows: [
            {
              ...freshSignatureRow,
              countersigned_by: 3,
              countersigned_at: new Date('2024-01-01T00:00:00Z')
            }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const countersignResult = await service.recordCountersignature(50, {
      userId: 3,
      is_global_manager: true
    });

    expect(countersignResult.countersigned_at).not.toBeNull();
    expect(countersignResult.countersigned_by).toBe(3);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');
  });
});
