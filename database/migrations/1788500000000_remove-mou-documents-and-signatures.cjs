/**
 * Removes the MOU/Document Management feature (production-hardening
 * Requirement 28) at the schema level. The feature never
 * had a client UI, and the login-time agreement gate it backed
 * (`server/middleware/requireCurrentAgreement.js`) has been removed
 * alongside it -- it is no longer needed; the server-side routes
 * (`server/routes/mou.js`), service (`server/services/MouService.js`),
 * permission-registry entries, and audit-log resource-name resolution
 * have already been removed in the same change that adds this migration.
 *
 * Drops, in dependency order (child before parent, matching the baseline
 * schema's own teardown-block ordering in
 * `1786596755665_baseline-schema.cjs`):
 *   - `mou_signatures` (FK to `mou_documents` ON DELETE CASCADE, plus FKs
 *     to `users`/`teams`)
 *   - `mou_documents` (FKs to `users`/`teams`; carried the
 *     `idx_mou_documents_one_current_agreement` singleton-enforcement
 *     index and the `update_mou_documents_updated_at` trigger)
 *
 * This is a genuinely destructive migration: every row in these two
 * tables is deleted on `up()`. Per this repository's convention
 * (see `1788400000000_remove-vendor-channels-and-channel-requests.cjs`),
 * do not hand-edit the baseline file to retroactively strip this schema --
 * this incremental migration is the correct place for it.
 *
 * `down()` reconstructs the original column/table definitions verbatim
 * from the baseline schema (column types, defaults, constraints, indexes,
 * FKs, trigger) so a rollback restores an empty-but-structurally-identical
 * schema -- though naturally with no data, since `up()`'s DROP is
 * unrecoverable.
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
DROP TABLE IF EXISTS public.mou_signatures CASCADE;

DROP TABLE IF EXISTS public.mou_documents CASCADE;
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
CREATE TABLE public.mou_documents (
    id integer NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    team_id integer,
    requires_countersignature boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    is_current_agreement boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    updated_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.mou_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.mou_documents_id_seq OWNED BY public.mou_documents.id;

ALTER TABLE ONLY public.mou_documents ALTER COLUMN id SET DEFAULT nextval('public.mou_documents_id_seq'::regclass);

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_mou_documents_one_current_agreement ON public.mou_documents USING btree (is_current_agreement) WHERE (is_current_agreement = true);

CREATE TRIGGER update_mou_documents_updated_at BEFORE UPDATE ON public.mou_documents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.mou_signatures (
    id integer NOT NULL,
    mou_document_id integer NOT NULL,
    signer_user_id integer,
    signer_team_id integer,
    signed_at timestamp without time zone DEFAULT now() NOT NULL,
    signature_method character varying(20) NOT NULL,
    signature_data text,
    countersigned_by integer,
    countersigned_at timestamp without time zone
);

CREATE SEQUENCE public.mou_signatures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.mou_signatures_id_seq OWNED BY public.mou_signatures.id;

ALTER TABLE ONLY public.mou_signatures ALTER COLUMN id SET DEFAULT nextval('public.mou_signatures_id_seq'::regclass);

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_countersigned_by_fkey FOREIGN KEY (countersigned_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_mou_document_id_fkey FOREIGN KEY (mou_document_id) REFERENCES public.mou_documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_signer_team_id_fkey FOREIGN KEY (signer_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_signer_user_id_fkey FOREIGN KEY (signer_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_mou_signatures_document_signer_team ON public.mou_signatures USING btree (mou_document_id, signer_team_id) WHERE (signer_team_id IS NOT NULL);

CREATE UNIQUE INDEX idx_mou_signatures_document_signer_user ON public.mou_signatures USING btree (mou_document_id, signer_user_id) WHERE (signer_user_id IS NOT NULL);
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
