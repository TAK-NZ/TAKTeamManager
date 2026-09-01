/**
 * Removes the Vendor Time-Limited Channel Access feature (production-hardening
 * Requirement 21) and the Channel Creation Approval Workflow
 * feature (production-hardening Requirement 23) at the
 * schema level. Both features shipped with zero client UI and are no longer
 * needed; their server-side routes/services/permission-registry entries/sync
 * operations have already been removed in the same change that adds this
 * migration.
 *
 * Drops, in dependency order (children before parents, matching the
 * baseline schema's own teardown-block ordering in
 * `1786596755665_baseline-schema.cjs`):
 *   - `vendor_channel_grants` (FKs to `users`, `vendor_channels`)
 *   - `vendor_channels` (FK to `users`; carried the
 *     `idx_vendor_channels_one_active` singleton-enforcement index)
 *   - `channel_requests` (FKs to `teams`, `users`)
 *   - `users.is_vendor` (the flag `VendorChannelService` set/read to gate
 *     grant creation; referenced nowhere else -- confirmed no user-listing,
 *     sync, or audit code reads it)
 *
 * This is a genuinely destructive migration: every row in these three
 * tables is deleted on `up()`, and `is_vendor`'s historical values are lost.
 * Per this repository's own tables count, seven migrations exist after the
 * baseline squash prior to this one -- do not hand-edit the baseline file to
 * retroactively strip this schema; this incremental migration is the
 * correct place for it.
 *
 * `down()` reconstructs the original column/table definitions verbatim from
 * the baseline schema (column types, defaults, constraints, indexes, FKs)
 * so a rollback restores an empty-but-structurally-identical schema --
 * though naturally with no data, since `up()`'s DROP is unrecoverable.
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
DROP TABLE IF EXISTS public.vendor_channel_grants CASCADE;

DROP TABLE IF EXISTS public.vendor_channels CASCADE;

DROP TABLE IF EXISTS public.channel_requests CASCADE;

ALTER TABLE public.users
    DROP COLUMN IF EXISTS is_vendor;
`);
};

/**
 * Reverses exactly what `up()` did, restoring the original baseline
 * definitions.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
ALTER TABLE public.users
    ADD COLUMN is_vendor boolean DEFAULT false NOT NULL;

CREATE TABLE public.channel_requests (
    id integer NOT NULL,
    team_id integer NOT NULL,
    custom_suffix character varying(100) NOT NULL,
    member_permissions jsonb NOT NULL,
    requested_by integer,
    status character varying(20) DEFAULT 'pending'::character varying,
    processed_by integer,
    processed_at timestamp without time zone,
    denial_reason text,
    created_at timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.channel_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.channel_requests_id_seq OWNED BY public.channel_requests.id;

ALTER TABLE ONLY public.channel_requests ALTER COLUMN id SET DEFAULT nextval('public.channel_requests_id_seq'::regclass);

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_processed_by_fkey FOREIGN KEY (processed_by) REFERENCES public.users(id);

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;

CREATE TABLE public.vendor_channels (
    id integer NOT NULL,
    name character varying(255) DEFAULT 'VND'::character varying NOT NULL,
    display_name character varying(255) DEFAULT 'VND'::character varying NOT NULL,
    description text,
    authentik_group_id character varying(255),
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.vendor_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.vendor_channels_id_seq OWNED BY public.vendor_channels.id;

ALTER TABLE ONLY public.vendor_channels ALTER COLUMN id SET DEFAULT nextval('public.vendor_channels_id_seq'::regclass);

ALTER TABLE ONLY public.vendor_channels
    ADD CONSTRAINT vendor_channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendor_channels
    ADD CONSTRAINT vendor_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_vendor_channels_one_active ON public.vendor_channels USING btree (is_active) WHERE (is_active = true);

CREATE TABLE public.vendor_channel_grants (
    id integer NOT NULL,
    user_id integer NOT NULL,
    channel_id integer NOT NULL,
    granted_by integer,
    granted_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone,
    revoked_at timestamp without time zone,
    revoked_by integer
);

CREATE SEQUENCE public.vendor_channel_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.vendor_channel_grants_id_seq OWNED BY public.vendor_channel_grants.id;

ALTER TABLE ONLY public.vendor_channel_grants ALTER COLUMN id SET DEFAULT nextval('public.vendor_channel_grants_id_seq'::regclass);

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX idx_vendor_channel_grants_pending_expiry ON public.vendor_channel_grants USING btree (expires_at) WHERE ((revoked_at IS NULL) AND (expires_at IS NOT NULL));
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
