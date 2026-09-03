jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const pool = require('../config/database');
const User = require('./User');

/**
 * Requirement 13.2/13.9 + security-hardening allowlist: `User.update`
 * builds a dynamic SET clause from `Object.keys(fields)`, now checked
 * against a frozen `UPDATABLE_COLUMNS` allowlist before being
 * interpolated into the query. Every current call site
 * (`server/routes/teams.js`, `server/services/DeviceEnrollmentService.js`)
 * already restricts `fields` to a hardcoded column set, so this
 * allowlist is a structural guard against a future caller passing an
 * unvalidated object straight through -- not a behavior change for any
 * existing call site.
 */
describe('User.update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates a single allowed column and returns the updated row', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, first_name: 'Jane' }] });

    const result = await User.update(1, { first_name: 'Jane' });

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE users SET first_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      ['Jane', 1]
    );
    expect(result).toEqual({ id: 1, first_name: 'Jane' });
  });

  it('updates multiple allowed columns in one call', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await User.update(1, { first_name: 'Jane', last_name: 'Doe', tak_role: 'Team Lead' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('first_name = $1');
    expect(sql).toContain('last_name = $2');
    expect(sql).toContain('tak_role = $3');
    expect(params).toEqual(['Jane', 'Doe', 'Team Lead', 1]);
  });

  it('is a no-op that returns the current row via findById when fields is empty', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, first_name: 'Existing' }] });

    const result = await User.update(1, {});

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1]);
    expect(result).toEqual({ id: 1, first_name: 'Existing' });
  });

  it.each(['device_label', 'callsign_suffix'])('accepts %s as an allowed column', async (column) => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await User.update(1, { [column]: 'value' });

    expect(pool.query).toHaveBeenCalledWith(
      `UPDATE users SET ${column} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      ['value', 1]
    );
  });

  /**
   * Security-hardening: the allowlist rejects BEFORE issuing any query --
   * `email` in particular must never be settable through this generic
   * path (Requirement 13.3), regardless of what a future caller passes.
   */
  it('throws and issues NO query when fields contains a disallowed column (email)', async () => {
    await expect(User.update(1, { email: 'attacker@example.com' })).rejects.toThrow(
      /column\(s\) not in the allowed set: email/
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('throws and issues NO query when fields contains an arbitrary/unexpected column', async () => {
    await expect(User.update(1, { is_admin: true })).rejects.toThrow(
      /column\(s\) not in the allowed set: is_admin/
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('throws and issues NO query when ANY column in a mixed set is disallowed, even if others are allowed', async () => {
    await expect(
      User.update(1, { first_name: 'Jane', account_status: 'active' })
    ).rejects.toThrow(/column\(s\) not in the allowed set: account_status/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('lists every disallowed column when multiple are present', async () => {
    await expect(
      User.update(1, { email: 'x@example.com', is_admin: true })
    ).rejects.toThrow(/email, is_admin/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a SQL-injection-shaped column name outright, never reaching query construction', async () => {
    await expect(
      User.update(1, { 'id; DROP TABLE users;--': 'x' })
    ).rejects.toThrow(/column\(s\) not in the allowed set/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('User.create/findByUsername/findById (existing coverage)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create inserts a new user row and returns it', async () => {
    const row = { id: 1, username: 'jdoe', email: 'jdoe@example.com' };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await User.create({
      authentik_user_id: 'authentik-1',
      username: 'jdoe',
      email: 'jdoe@example.com',
      first_name: 'John',
      last_name: 'Doe'
    });

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      ['authentik-1', 'jdoe', 'jdoe@example.com', 'John', 'Doe', null]
    );
  });

  it('findByUsername returns the matching row', async () => {
    const row = { id: 1, username: 'jdoe' };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await User.findByUsername('jdoe');

    expect(result).toEqual(row);
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM users WHERE username = $1', ['jdoe']);
  });

  it('findById returns undefined when no row matches', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await User.findById(999);

    expect(result).toBeUndefined();
  });
});
