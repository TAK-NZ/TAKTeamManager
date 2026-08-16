/**
 * Requirements 8.5, 8.6: the App's database pool registers a
 * `pool.on('error', ...)` handler (so an idle client error doesn't crash
 * the process) and is configured with an explicit `max` pool size sourced
 * from `DB_POOL_MAX` (defaulting to 20).
 */

describe('server/config/database', () => {
  const ORIGINAL_ENV = process.env;
  let mockPoolInstance;
  let PoolMock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };

    mockPoolInstance = {
      on: jest.fn()
    };
    PoolMock = jest.fn(() => mockPoolInstance);

    jest.doMock('pg', () => ({ Pool: PoolMock }));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock('pg');
  });

  it('constructs the Pool with the DB_POOL_MAX env value', () => {
    process.env.DB_POOL_MAX = '75';

    require('./database');

    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 75 });
  });

  it('defaults max to 20 when DB_POOL_MAX is unset', () => {
    delete process.env.DB_POOL_MAX;

    require('./database');

    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 20 });
  });

  it('defaults max to 20 when DB_POOL_MAX is not a valid number', () => {
    process.env.DB_POOL_MAX = 'not-a-number';

    require('./database');

    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 20 });
  });

  it('registers an error handler on the pool that does not throw', () => {
    require('./database');

    expect(mockPoolInstance.on).toHaveBeenCalledWith('error', expect.any(Function));

    const errorHandler = mockPoolInstance.on.mock.calls.find(
      ([eventName]) => eventName === 'error'
    )[1];

    expect(() => errorHandler(new Error('idle client error'))).not.toThrow();
  });
});
