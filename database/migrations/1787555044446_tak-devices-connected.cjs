/**
 * Connection_Status migration (device-management, Requirement 20.2).
 *
 * Adds `tak_devices.connected`, the persisted Connection_Status of a device:
 * `ClientEndpoint.lastStatus` from the Client_Endpoints_API
 * (`GET /Marti/api/clientEndPoints`), collapsed per `client_uid` by the
 * Status_Collapse_Rule -- connected WHEN at least one reported entry for that
 * uid says `Connected`, compared case-insensitively.
 *
 * Stored rather than derived (Requirement 20.2): it is current state read from
 * TAK Server, not a function of any certificate attribute `tak_devices`
 * already holds, so there is nothing to derive it from on read the way
 * Client_Type is derived from Client_Uid.
 *
 * `boolean NOT NULL DEFAULT false`, deliberately NOT a nullable tri-state:
 * nothing consumes a "never polled" state distinct from "reported, not
 * connected". Both render identically, and both mean the same thing -- "no
 * evidence this Device is connected". Under that reading the `false` this
 * `ALTER` fills the existing rows with is already the correct value, so this
 * migration needs no backfill: the Subscription_Poller will overwrite it with
 * observed state on its next successful poll, and until then `false` is the
 * honest answer.
 *
 * One writer only, the Subscription_Poller, on every successful poll
 * (Requirement 20.3/20.10). The Device_Sync never writes this column, exactly
 * as it never writes `last_seen_at` or `revoked`: an inserted row takes the
 * default and an upsert leaves any stored value untouched. Crucially the
 * poller's status write is NOT behind the Monotonic_Guard that clamps
 * `last_seen_at` -- Connection_Status is current state, not a running maximum,
 * so a Device connected right now whose reported `lastEventTime` has not
 * advanced past the stored value must still have its status updated.
 *
 * Also re-issues `COMMENT ON COLUMN public.tak_devices.last_seen_at`. The text
 * the Device_Table migration set says the value comes "from the live
 * subscriptions API" -- that endpoint (`/Marti/clients`) answers 404 live and
 * is absent from `tak-server-openapispec.json`, and task 21.2 repointed
 * Last_Seen at the Client_Endpoints_API's reported `lastEventTime` instead.
 * A comment is the schema's own documentation, so leaving a wrong one in place
 * in a live database is not an option; the corrected text is applied here and
 * corrected in place in `1787518155760_tak-devices.cjs` as well, for readers of
 * that file (that migration will not re-run on any database that already has
 * it applied).
 *
 * Follows the conventions of the migrations in this directory: raw SQL via
 * `pgm.sql(...)` and a `down()` that reverses exactly what `up()` did.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(`
ALTER TABLE public.tak_devices
    ADD COLUMN connected boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.tak_devices.connected IS 'Requirement 20.2-20.7: Connection_Status from ClientEndpoint.lastStatus (Client_Endpoints_API), collapsed per client_uid by the Status_Collapse_Rule -- connected when at least one reported entry says Connected, case-insensitively. Written by the Subscription_Poller only, on every successful poll, for every reported uid and NOT behind the Monotonic_Guard that clamps last_seen_at; set false for rows absent from a successful poll. A failed poll writes nothing.';

COMMENT ON COLUMN public.tak_devices.last_seen_at IS 'Requirement 3.2-3.5: best-effort, monotonic-forward Last_Seen from the lastEventTime reported by the Client_Endpoints_API (GET /Marti/api/clientEndPoints). NULL means TAK Server retains no entry for this device; never rewound or nulled once set.';
`);
};

/**
 * Drops the column `up()` added. Reversing the column is the whole of the
 * reversal: the `last_seen_at` comment is deliberately NOT rewound to its
 * stale wording. That comment does not describe this column and is not part of
 * this migration's schema change -- it is the same corrected text
 * `1787518155760_tak-devices.cjs` now carries, so a chain built from scratch
 * and a chain rolled back to before this migration agree on it, whereas
 * restoring the old text here would reintroduce wording that no longer exists
 * anywhere in the source.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
ALTER TABLE public.tak_devices
    DROP COLUMN IF EXISTS connected;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
