/**
 * Cert_Expiry_Notification_Record migration (cert-expiry-notifications,
 * Requirement 1, task 1.1).
 *
 * Creates `cert_expiry_notifications`, the bookkeeping table this feature
 * uses to remember which Cert_Expiry_Tier has already been resolved
 * (either emailed or deliberately skipped as stale-backlog, per
 * Requirement 2.3) for a given certificate, so a daily scheduled job never
 * re-sends the same warning.
 *
 *   - `id`             serial primary key.
 *   - `client_uid`     the device's `tak_devices.client_uid` -- NOT a
 *                      foreign key (see below).
 *   - `cert_id`        the specific certificate this row concerns
 *                      (`tak_devices.cert_id` at the time the row was
 *                      written).
 *   - `threshold_days` which Cert_Expiry_Tier this row concerns (one of the
 *                      four configured `CERT_EXPIRY_TIER*_DAYS` values at
 *                      write time).
 *   - `notified_at`    when this row was written.
 *
 * UNIQUE (client_uid, cert_id, threshold_days): a certificate is identified
 * by `(client_uid, cert_id)`, never `client_uid` alone (Requirement 1.2) --
 * a renewed certificate is a new `cert_id` on the same `client_uid`, so it
 * starts every tier fresh with no manual reset. The `INSERT ... ON
 * CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING` write pattern
 * `CertExpiryNotificationService` uses relies on this exact constraint
 * shape.
 *
 * Deliberately NO foreign key to `tak_devices.client_uid`: `DeviceSync`
 * deletes a `tak_devices` row when its `client_uid` drops out of the
 * Live_Device_Set (its own documented reconciliation step), and a
 * `cert_expiry_notifications` row must survive that deletion untouched --
 * it is bookkeeping about a past send, not a live reference (Requirement
 * 1.3). A row referencing a now-deleted `client_uid` becomes orphaned
 * bookkeeping with no further effect; this feature never deletes a row of
 * its own as part of normal operation.
 *
 * Follows the conventions of the migrations in this directory: raw SQL via
 * `pgm.sql(...)`, plain quotes with no backticks inside the SQL string, and
 * a `down()` that reverses exactly what `up()` did.
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
CREATE TABLE public.cert_expiry_notifications (
    id integer NOT NULL,
    client_uid character varying(255) NOT NULL,
    cert_id integer NOT NULL,
    threshold_days integer NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.cert_expiry_notifications_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

ALTER SEQUENCE public.cert_expiry_notifications_id_seq OWNED BY public.cert_expiry_notifications.id;

ALTER TABLE ONLY public.cert_expiry_notifications
    ALTER COLUMN id SET DEFAULT nextval('public.cert_expiry_notifications_id_seq'::regclass);

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_client_uid_cert_id_threshold_key
    UNIQUE (client_uid, cert_id, threshold_days);

CREATE INDEX idx_cert_expiry_notifications_client_uid
    ON public.cert_expiry_notifications USING btree (client_uid);

COMMENT ON TABLE public.cert_expiry_notifications IS 'cert-expiry-notifications Requirement 1: tracks which Cert_Expiry_Tier has already been resolved (emailed or deliberately skipped as stale-backlog) for a given certificate, keyed on (client_uid, cert_id, threshold_days) so a renewed certificate (new cert_id) starts every tier fresh. No foreign key to tak_devices -- this row must survive DeviceSync deleting a stale tak_devices row untouched, since it records a past send rather than a live reference.';
`);
};

/**
 * Reverses exactly what `up()` did.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
DROP TABLE IF EXISTS public.cert_expiry_notifications CASCADE;
DROP SEQUENCE IF EXISTS public.cert_expiry_notifications_id_seq;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
