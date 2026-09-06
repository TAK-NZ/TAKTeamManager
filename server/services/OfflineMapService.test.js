/**
 * Tests for OfflineMapService — catalog resolution against S3 (live sizes) and
 * presigned-URL minting. The S3 client is mocked (injected), so no network.
 */

// Mock the presigner so getPresignedUrl is deterministic and offline.
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));

// Mock the SDK commands so we can inspect the inputs the service builds.
jest.mock('@aws-sdk/client-s3', () => {
  class S3Client {}
  class ListObjectsV2Command {
    constructor(input) { this.input = input; }
  }
  class GetObjectCommand {
    constructor(input) { this.input = input; }
  }
  return { S3Client, ListObjectsV2Command, GetObjectCommand };
});

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const OfflineMapService = require('./OfflineMapService');
const { OFFLINE_MAP_CATALOG } = OfflineMapService;

const BUCKET = 'test-map-downloads';

/**
 * A mock S3 client whose `send` inspects the command type and returns canned
 * ListObjectsV2 pages keyed by prefix.
 */
function buildMockS3Client(objectsByPrefix) {
  return {
    send: jest.fn(async (command) => {
      const prefix = command.input.Prefix;
      const contents = (objectsByPrefix[prefix] || []).map((o) => ({ Key: o.key, Size: o.size }));
      return { Contents: contents, IsTruncated: false };
    })
  };
}

function buildService(objectsByPrefix, overrides = {}) {
  return new OfflineMapService({
    s3Client: buildMockS3Client(objectsByPrefix),
    bucket: BUCKET,
    env: { OFFLINE_MAPS_URL_TTL_SECONDS: '300' },
    ...overrides
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('catalog shape', () => {
  it('excludes the whole-island supersets and has 19 entries in geographic order', () => {
    expect(OFFLINE_MAP_CATALOG).toHaveLength(19);
    // No superset ids.
    const ids = OFFLINE_MAP_CATALOG.map((e) => e.id);
    expect(ids).not.toContain('regional-north-island');
    expect(ids).not.toContain('regional-south-island');
    // First entry is Northland, last two are the vector basemaps in order.
    expect(OFFLINE_MAP_CATALOG[0].id).toBe('regional-northland');
    expect(ids.slice(-2)).toEqual(['vector-omt-buildings', 'vector-omt']);
  });

  it('marks regional and marine as ATAK+TAK Aware, vector as ATAK-only', () => {
    const marine = OFFLINE_MAP_CATALOG.find((e) => e.id === 'marine-charts');
    const vector = OFFLINE_MAP_CATALOG.find((e) => e.id === 'vector-omt');
    const otago = OFFLINE_MAP_CATALOG.find((e) => e.id === 'regional-otago');
    expect(marine.apps).toEqual(['atak', 'takaware']);
    expect(otago.apps).toEqual(['atak', 'takaware']);
    expect(vector.apps).toEqual(['atak']);
  });
});

describe('isConfigured', () => {
  it('is true with a bucket and false without', () => {
    expect(buildService({}).isConfigured()).toBe(true);
    expect(new OfflineMapService({ s3Client: buildMockS3Client({}), bucket: null }).isConfigured()).toBe(false);
  });
});

describe('listAvailableMaps', () => {
  it('merges live sizes onto the catalog and preserves order; missing objects are unavailable', async () => {
    // Only two regionals present; marine + vector absent (not yet uploaded).
    const service = buildService({
      'regional/': [
        { key: 'regional/otago-topo.mbtiles', size: 694591488 },
        { key: 'regional/northland-topo.mbtiles', size: 119783424 }
      ],
      'marine/': [],
      'vector/': []
    });

    const maps = await service.listAvailableMaps();

    // Order preserved (catalog order), all 19 present.
    expect(maps).toHaveLength(19);
    expect(maps[0].id).toBe('regional-northland');

    const northland = maps.find((m) => m.id === 'regional-northland');
    const otago = maps.find((m) => m.id === 'regional-otago');
    const waikato = maps.find((m) => m.id === 'regional-waikato');
    const marine = maps.find((m) => m.id === 'marine-charts');

    expect(northland).toMatchObject({ sizeBytes: 119783424, available: true });
    expect(otago).toMatchObject({ sizeBytes: 694591488, available: true });
    // Present in the catalog but not in S3 yet -> unavailable, null size.
    expect(waikato).toMatchObject({ sizeBytes: null, available: false });
    expect(marine).toMatchObject({ sizeBytes: null, available: false });

    // Never returns a URL from the listing.
    expect(maps.every((m) => !('url' in m))).toBe(true);
  });

  it('throws when no bucket is configured', async () => {
    const service = new OfflineMapService({ s3Client: buildMockS3Client({}), bucket: null });
    await expect(service.listAvailableMaps()).rejects.toThrow(/no bucket configured/);
  });

  it('follows ListObjectsV2 pagination', async () => {
    // A client that returns a truncated first page, then the rest.
    let call = 0;
    const paginatedClient = {
      send: jest.fn(async (command) => {
        if (command.input.Prefix !== 'regional/') return { Contents: [], IsTruncated: false };
        call += 1;
        if (call === 1) {
          return {
            Contents: [{ Key: 'regional/otago-topo.mbtiles', Size: 1 }],
            IsTruncated: true,
            NextContinuationToken: 'token-2'
          };
        }
        return {
          Contents: [{ Key: 'regional/southland-topo.mbtiles', Size: 2 }],
          IsTruncated: false
        };
      })
    };
    const service = new OfflineMapService({ s3Client: paginatedClient, bucket: BUCKET, env: {} });
    const maps = await service.listAvailableMaps();
    expect(maps.find((m) => m.id === 'regional-otago').available).toBe(true);
    expect(maps.find((m) => m.id === 'regional-southland').available).toBe(true);
  });
});

describe('getPresignedUrl', () => {
  it('presigns a GetObject for a known id, with attachment disposition and the configured TTL', async () => {
    getSignedUrl.mockResolvedValue('https://signed.example/otago');
    const service = buildService({});

    const result = await service.getPresignedUrl('regional-otago');

    expect(result).toEqual({
      url: 'https://signed.example/otago',
      fileName: 'otago-topo.mbtiles',
      expiresIn: 300
    });

    // The command built carries the catalog key (never a caller-supplied one)
    // and forces a download.
    const [, command, opts] = getSignedUrl.mock.calls[0];
    expect(command.input.Bucket).toBe(BUCKET);
    expect(command.input.Key).toBe('regional/otago-topo.mbtiles');
    expect(command.input.ResponseContentDisposition).toContain('attachment');
    expect(command.input.ResponseContentDisposition).toContain('otago-topo.mbtiles');
    expect(opts).toEqual({ expiresIn: 300 });
  });

  it('rejects an unknown id with code UNKNOWN_MAP_ID and never calls S3', async () => {
    const service = buildService({});
    await expect(service.getPresignedUrl('regional/../secret')).rejects.toMatchObject({ code: 'UNKNOWN_MAP_ID' });
    await expect(service.getPresignedUrl('not-a-real-id')).rejects.toMatchObject({ code: 'UNKNOWN_MAP_ID' });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('throws when no bucket is configured', async () => {
    const service = new OfflineMapService({ s3Client: buildMockS3Client({}), bucket: null });
    await expect(service.getPresignedUrl('regional-otago')).rejects.toThrow(/no bucket configured/);
  });
});
