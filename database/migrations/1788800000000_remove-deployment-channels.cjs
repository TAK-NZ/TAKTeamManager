/**
 * Removes the Deployment-Scoped Overseas/Domestic Channel Self-Service
 * feature at the schema level. The feature never had a
 * client UI and is not needed -- the server-side routes
 * (`server/routes/deploymentChannels.js`), service
 * (`server/services/DeploymentChannelService.js`), the `ExpiryScheduler`
 * that swept it (`server/services/ExpiryScheduler.js`), the
 * `DEPLOYMENT_CHANNELS_ENABLED`/`EXPIRY_SCHEDULER_INTERVAL_SECONDS` env
 * vars, permission-registry entries, and audit-log resource-name
 * resolution have already been removed in the same change that adds this
 * migration.
 *
 * Drops `deployment_channels` (its only index,
 * `idx_deployment_channels_pending_deactivation`, and its FK to `users`
 * go with it via CASCADE).
 *
 * This is a genuinely destructive migration: every row in this table is
 * deleted on `up()`. Per this repository's convention (see
 * `1788400000000_remove-vendor-channels-and-channel-requests.cjs`,
 * `1788500000000_remove-mou-documents-and-signatures.cjs`), do not
 * hand-edit the baseline file to retroactively strip this schema -- this
 * incremental migration is the correct place for it.
 *
 * `down()` reconstructs the original column/table definition verbatim
 * from the baseline schema (column types, defaults, constraints, index,
 * FK) so a rollback restores an empty-but-structurally-identical schema
 * -- though naturally with no data, since `up()`'s DROP is unrecoverable.
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
DROP TABLE IF EXISTS public.deployment_channels CASCADE;
`);
};

/**
 * Reverses exactly what `up()` did, restoring the original baseline
 * definition.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
CREATE TABLE public.deployment_channels (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    deployment_end_date timestamp without time zone,
    authentik_group_id character varying(255),
    is_active boolean DEFAULT true,
    requested_by integer,
    created_at timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.deployment_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deployment_channels_id_seq OWNED BY public.deployment_channels.id;

ALTER TABLE ONLY public.deployment_channels ALTER COLUMN id SET DEFAULT nextval('public.deployment_channels_id_seq'::regclass);

ALTER TABLE ONLY public.deployment_channels
    ADD CONSTRAINT deployment_channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployment_channels
    ADD CONSTRAINT deployment_channels_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX idx_deployment_channels_pending_deactivation ON public.deployment_channels USING btree (deployment_end_date) WHERE ((is_active = true) AND (deployment_end_date IS NOT NULL));
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
