const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  getOfflineMapsBucket,
  getOfflineMapsRegion,
  getOfflineMapsUrlTtlSeconds
} = require('../config/offlineMaps');

/**
 * OfflineMapService — resolves the offline-map catalog to real S3 objects and
 * mints short-lived presigned GetObject URLs for authenticated downloads.
 *
 * The catalog is STATIC and code-defined (below). The bucket has a fixed,
 * known key layout that changes only via a manually-triggered, roughly-annual
 * batch job that overwrites the objects in place, so a DB-backed catalog would
 * be overkill and would drift from the generator. File SIZES are NOT hardcoded:
 * they are read live from S3 at list time, so a not-yet-uploaded object is
 * simply reported as unavailable rather than offered as a dead link — the
 * marine and vector files land later and will appear automatically once their
 * objects exist, with no code change.
 *
 * Security core: a client only ever names a catalog ID (e.g. `regional-otago`),
 * never a raw S3 key. The S3 key is assembled server-side purely from this
 * frozen allow-list — the same "dynamic identifiers come only from a frozen
 * allow-list" discipline applied to SQL identifiers elsewhere in the codebase.
 * An ID absent from the catalog can never reach S3.
 *
 * The S3 client is injectable (constructor `options.s3Client`) so tests never
 * touch the network, mirroring `AwsSecretsManagerProvider`'s injectable-client
 * shape in `server/config/secretsProvider.js`. AWS credentials come from the
 * SDK default chain (instance/task role); this service never reads keys from
 * the environment.
 */

/**
 * The S3 key prefixes the catalog draws from. `listAvailableMaps` issues one
 * `ListObjectsV2` per prefix (cheaper than one `HeadObject` per file) to learn
 * which objects exist and their sizes.
 */
const CATALOG_PREFIXES = ['regional/', 'marine/', 'vector/'];

/**
 * The offline-map catalog. Array order IS display order (geographic):
 * North Island (north→south), South Island (north→south), Chatham Islands,
 * Marine, then the two Vector basemaps. The two whole-island supersets
 * (`north-island`, `south-island`) from the generator's REGIONS dict are
 * deliberately excluded — they duplicate the 16 regions.
 *
 *   id        stable catalog identifier the client requests (never the S3 key)
 *   group     UI grouping key (island / marine / vector)
 *   category  regional | marine | vector
 *   key       the S3 object key (assembled here, never supplied by a client)
 *   label     display name
 *   apps      compatibility: raster (regional+marine) works in ATAK + TAK Aware;
 *             vector is ATAK-only
 */
const OFFLINE_MAP_CATALOG = [
  // North Island: north -> south
  { id: 'regional-northland', group: 'north-island', category: 'regional', key: 'regional/northland-topo.mbtiles', label: 'Northland', apps: ['atak', 'takaware'] },
  { id: 'regional-auckland', group: 'north-island', category: 'regional', key: 'regional/auckland-topo.mbtiles', label: 'Auckland', apps: ['atak', 'takaware'] },
  { id: 'regional-waikato', group: 'north-island', category: 'regional', key: 'regional/waikato-topo.mbtiles', label: 'Waikato', apps: ['atak', 'takaware'] },
  { id: 'regional-bay-of-plenty', group: 'north-island', category: 'regional', key: 'regional/bay-of-plenty-topo.mbtiles', label: 'Bay of Plenty', apps: ['atak', 'takaware'] },
  { id: 'regional-gisborne', group: 'north-island', category: 'regional', key: 'regional/gisborne-topo.mbtiles', label: 'Gisborne', apps: ['atak', 'takaware'] },
  { id: 'regional-hawkes-bay', group: 'north-island', category: 'regional', key: 'regional/hawkes-bay-topo.mbtiles', label: "Hawke's Bay", apps: ['atak', 'takaware'] },
  { id: 'regional-taranaki', group: 'north-island', category: 'regional', key: 'regional/taranaki-topo.mbtiles', label: 'Taranaki', apps: ['atak', 'takaware'] },
  { id: 'regional-manawatu-whanganui', group: 'north-island', category: 'regional', key: 'regional/manawatu-whanganui-topo.mbtiles', label: 'Manawatū-Whanganui', apps: ['atak', 'takaware'] },
  { id: 'regional-wellington', group: 'north-island', category: 'regional', key: 'regional/wellington-topo.mbtiles', label: 'Wellington', apps: ['atak', 'takaware'] },
  // South Island: north -> south
  { id: 'regional-nelson-tasman', group: 'south-island', category: 'regional', key: 'regional/nelson-tasman-topo.mbtiles', label: 'Nelson Tasman', apps: ['atak', 'takaware'] },
  { id: 'regional-marlborough', group: 'south-island', category: 'regional', key: 'regional/marlborough-topo.mbtiles', label: 'Marlborough', apps: ['atak', 'takaware'] },
  { id: 'regional-west-coast', group: 'south-island', category: 'regional', key: 'regional/west-coast-topo.mbtiles', label: 'West Coast', apps: ['atak', 'takaware'] },
  { id: 'regional-canterbury', group: 'south-island', category: 'regional', key: 'regional/canterbury-topo.mbtiles', label: 'Canterbury', apps: ['atak', 'takaware'] },
  { id: 'regional-otago', group: 'south-island', category: 'regional', key: 'regional/otago-topo.mbtiles', label: 'Otago', apps: ['atak', 'takaware'] },
  { id: 'regional-southland', group: 'south-island', category: 'regional', key: 'regional/southland-topo.mbtiles', label: 'Southland', apps: ['atak', 'takaware'] },
  // Chatham Islands
  { id: 'regional-chatham-islands', group: 'chatham-islands', category: 'regional', key: 'regional/chatham-islands-topo.mbtiles', label: 'Chatham Islands', apps: ['atak', 'takaware'] },
  // Marine
  { id: 'marine-charts', group: 'marine', category: 'marine', key: 'marine/nz-marine-charts.mbtiles', label: 'NZ Marine Charts', apps: ['atak', 'takaware'] },
  // Vector (ATAK-only)
  { id: 'vector-omt-buildings', group: 'vector', category: 'vector', key: 'vector/nz-omt-buildings.mbtiles', label: 'NZ Basemap + 3D Buildings', apps: ['atak'] },
  { id: 'vector-omt', group: 'vector', category: 'vector', key: 'vector/nz-omt.mbtiles', label: 'NZ Basemap', apps: ['atak'] }
];

/**
 * Filename a download is offered under, derived from the S3 key's basename.
 * @param {string} key
 * @returns {string}
 */
function fileNameFromKey(key) {
  const parts = key.split('/');
  return parts[parts.length - 1];
}

class OfflineMapService {
  /**
   * @param {Object} [options]
   * @param {import('@aws-sdk/client-s3').S3Client} [options.s3Client] injectable
   *   client, primarily for testing; if omitted, one is created for the
   *   configured region.
   * @param {string|null} [options.bucket] bucket override; defaults to the
   *   configured `OFFLINE_MAPS_S3_BUCKET`.
   * @param {NodeJS.ProcessEnv} [options.env=process.env] environment source.
   */
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.bucket = options.bucket !== undefined ? options.bucket : getOfflineMapsBucket(this.env);
    this.region = getOfflineMapsRegion(this.env);
    this.ttlSeconds = getOfflineMapsUrlTtlSeconds(this.env);
    // Credentials resolve via the SDK default chain (instance/task role).
    this.s3Client = options.s3Client || new S3Client({ region: this.region });
  }

  /**
   * Whether the service has a bucket configured. A caller (route) uses this to
   * answer 503 "enabled but not wired up" distinctly from a runtime S3 error.
   * @returns {boolean}
   */
  isConfigured() {
    return typeof this.bucket === 'string' && this.bucket.length > 0;
  }

  /**
   * The static catalog metadata, without any S3 lookup. Exposed for tests and
   * for callers that only need the shape/order.
   * @returns {Array<object>} a copy of the catalog entries.
   */
  getCatalog() {
    return OFFLINE_MAP_CATALOG.map((entry) => ({ ...entry }));
  }

  /**
   * Resolve which catalog objects currently exist in S3 and their sizes.
   *
   * Issues one `ListObjectsV2` per prefix and joins the results onto the
   * catalog by key. Returns catalog metadata plus `sizeBytes` (number|null) and
   * `available` (boolean). Never returns a URL — minting one is a separate,
   * per-object call (`getPresignedUrl`). Preserves catalog (display) order.
   *
   * @returns {Promise<Array<{id:string,group:string,category:string,label:string,apps:string[],sizeBytes:(number|null),available:boolean}>>}
   * @throws if the bucket is not configured, or if the S3 listing fails.
   */
  async listAvailableMaps() {
    if (!this.isConfigured()) {
      throw new Error('OfflineMapService: no bucket configured (OFFLINE_MAPS_S3_BUCKET unset)');
    }

    // key -> size in bytes, for every object found under the catalog prefixes.
    const sizeByKey = new Map();
    for (const prefix of CATALOG_PREFIXES) {
      let continuationToken;
      do {
        const response = await this.s3Client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        }));
        for (const object of response.Contents || []) {
          sizeByKey.set(object.Key, object.Size);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    return OFFLINE_MAP_CATALOG.map((entry) => {
      const sizeBytes = sizeByKey.has(entry.key) ? sizeByKey.get(entry.key) : null;
      return {
        id: entry.id,
        group: entry.group,
        category: entry.category,
        label: entry.label,
        apps: [...entry.apps],
        sizeBytes,
        available: sizeBytes !== null
      };
    });
  }

  /**
   * Mint a short-lived presigned GetObject URL for a single catalog entry.
   *
   * The `id` MUST match a catalog entry; an unknown id throws (a 404 at the
   * route). The S3 key is taken from the catalog, never from the caller. The
   * URL forces a download (Content-Disposition: attachment) under the file's
   * own name rather than opening in the browser.
   *
   * @param {string} id catalog id (e.g. `regional-otago`).
   * @returns {Promise<{url:string,fileName:string,expiresIn:number}>}
   * @throws {Error} with `.code = 'UNKNOWN_MAP_ID'` when `id` is not in the catalog.
   * @throws if the bucket is not configured, or if presigning fails.
   */
  async getPresignedUrl(id) {
    if (!this.isConfigured()) {
      throw new Error('OfflineMapService: no bucket configured (OFFLINE_MAPS_S3_BUCKET unset)');
    }

    const entry = OFFLINE_MAP_CATALOG.find((e) => e.id === id);
    if (!entry) {
      const err = new Error(`Unknown offline map id: ${id}`);
      err.code = 'UNKNOWN_MAP_ID';
      throw err;
    }

    const fileName = fileNameFromKey(entry.key);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: entry.key,
      ResponseContentDisposition: `attachment; filename="${fileName}"`,
      ResponseContentType: 'application/octet-stream'
    });

    const url = await getSignedUrl(this.s3Client, command, { expiresIn: this.ttlSeconds });
    return { url, fileName, expiresIn: this.ttlSeconds };
  }
}

module.exports = OfflineMapService;
module.exports.OFFLINE_MAP_CATALOG = OFFLINE_MAP_CATALOG;
module.exports.CATALOG_PREFIXES = CATALOG_PREFIXES;
