/**
 * Device_Table migration (device-management, Requirements 4.1, 4.2).
 *
 * Creates `tak_devices`, the local persistence for TAK Server client
 * certificates ("devices") surfaced by the optional device-management
 * feature (`DEVICE_MGMT_ENABLED`). One row per certificate `clientUid`:
 *
 *   - `client_uid`     PRIMARY KEY -- the certificate clientUid, the stable
 *                      device identifier for a given enrollment.
 *   - `user_id`        the associated local user, matched from the
 *                      certificate's `creatorDn`; NULL when no local user
 *                      matches, and set to NULL if that user is deleted.
 *   - `cert_id`        the TAK certificate id.
 *   - `issued_at` /    certificate issuance / expiration timestamps as
 *     `expires_at`     reported by the Marti certadmin API.
 *   - `last_seen_at`   best-effort, monotonic-forward Last_Seen written by
 *                      the Subscription_Poller. NULL means "never seen" --
 *                      it is deliberately nullable and is never rewound or
 *                      nulled once set.
 *   - `last_polled_at` the Device_Sync run time, refreshed on each upsert.
 *   - `revoked`        flipped true once a Revoke_Operation confirms the
 *                      certificate was revoked.
 *
 * Follows the baseline migration conventions in this directory: raw SQL via
 * `pgm.sql(...)`, `timestamptz`/`now()` defaults, an `updated_at` trigger
 * using the shared `public.update_updated_at_column()` function created by
 * the baseline migration, and a `down()` that drops what `up()` created.
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
CREATE TABLE public.tak_devices (
    client_uid character varying(255) NOT NULL,
    user_id integer,
    cert_id integer NOT NULL,
    issued_at timestamp with time zone,
    expires_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    last_polled_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.tak_devices
    ADD CONSTRAINT tak_devices_pkey PRIMARY KEY (client_uid);

ALTER TABLE ONLY public.tak_devices
    ADD CONSTRAINT tak_devices_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX idx_tak_devices_user_id ON public.tak_devices USING btree (user_id);

CREATE INDEX idx_tak_devices_cert_id ON public.tak_devices USING btree (cert_id);

CREATE TRIGGER update_tak_devices_updated_at
    BEFORE UPDATE ON public.tak_devices
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.tak_devices IS 'Requirement 4.1/4.2: locally persisted TAK Server client certificates ("devices") for the optional device-management feature. One row per certificate clientUid.';

-- Corrected in place by device-management task 28.1 (Requirement 20.2): this
-- text used to say Last_Seen came "from the live subscriptions API", i.e.
-- /Marti/clients -- an endpoint that answers 404 live and is absent from
-- tak-server-openapispec.json. Since task 21.2 the source is the lastEventTime
-- reported by the Client_Endpoints_API. This migration will NOT re-run on any
-- database that already has it applied, so the same correction is re-issued by
-- 1787555044446_tak-devices-connected.cjs; it is fixed here so a reader of this
-- file, and a chain built from scratch, both get the accurate wording.
COMMENT ON COLUMN public.tak_devices.last_seen_at IS 'Requirement 3.2-3.5: best-effort, monotonic-forward Last_Seen from the lastEventTime reported by the Client_Endpoints_API (GET /Marti/api/clientEndPoints). NULL means TAK Server retains no entry for this device; never rewound or nulled once set.';
`);
};

/**
 * Drops the trigger and the table (CASCADE also removes its constraints and
 * indexes). The shared `public.update_updated_at_column()` function is left
 * in place -- it is owned by the baseline migration.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
DROP TRIGGER IF EXISTS update_tak_devices_updated_at ON public.tak_devices;
DROP TABLE IF EXISTS public.tak_devices CASCADE;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
