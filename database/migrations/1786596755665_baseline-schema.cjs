/**
 * Baseline (squashed) schema migration.
 *
 * This single migration reproduces the ENTIRE current database schema.
 * It replaces the previous baseline plus the 36 incremental migrations
 * that followed it: all of those have been squashed into this one file
 * now that there is no production database to migrate forward from.
 *
 * The schema DDL below is a cleaned copy of the exact output of
 *   pg_dump --schema-only --no-owner --no-privileges
 * against the current, verified-correct development database, with only
 * the following dump artifacts removed (none of which affect the schema
 * this migration produces):
 *   - psql meta-commands (\restrict/\unrestrict) and SET/set_config
 *     dump directives (statement_timeout, search_path, etc.);
 *   - the "-- *not* creating schema" note and COMMENT ON SCHEMA public;
 *   - the pgmigrations table, its sequence, PK, and DEFAULT — that table
 *     is created and owned by node-pg-migrate itself.
 * Everything else (the update_updated_at_column() function, every table,
 * sequence, default, column comment, constraint, index — including the
 * partial WHERE clauses — trigger, and foreign key) is preserved verbatim
 * and in the same order pg_dump emitted it.
 *
 * As with the original baseline, this replays raw SQL via pgm.sql(...)
 * rather than translating it into node-pg-migrate's schema-builder API,
 * to guarantee byte-for-byte fidelity with the verified schema. Every
 * schema change from this point forward should be its own incremental
 * migration rather than an edit to this file.
 *
 * The schema DDL is followed by the seed-data INSERTs that previously
 * lived in five separate seed migrations (TAK color/role system_config,
 * branding site_config, excluded_email_domains, signup email templates,
 * and the team_transfer_completed email template). Each is reproduced in
 * its own clearly-commented pgm.sql block below, preserving its exact
 * content and ON CONFLICT idempotency. The TAK color/role seed preserves
 * its original ENV-based dynamic logic (it reads process.env at migration
 * run time). NOTE: the base seed rows that database/init.js inserts
 * (sync_status, escalation/verification system_config, the four base
 * email templates, and group_membership_rules) still live in init.js and
 * run AFTER this migration, exactly as before — they are intentionally
 * NOT duplicated here. The two email-template styling UPDATEs that a
 * former migration applied to access_request_verification and
 * access_request_approved have been folded directly into init.js's
 * INSERT bodies (so the styled content is seeded in the first place),
 * because init.js runs after migrations and an UPDATE here would no-op.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

// ---------------------------------------------------------------------------
// TAK color/role system_config seed (ported verbatim from the former
// 1786790000000_seed-tak-color-role-system-config.cjs migration).
//
// Requirement 32.1: preserve each TAK_COLOR_*/TAK_ROLE_* environment
// variable's CURRENT value (read at migration-run time) as the initial
// default of its system_config row. This MUST stay dynamic — the values
// are read from process.env inside up() below, not frozen at author time.
// ---------------------------------------------------------------------------
const SEED_ENV_VARS = [
  // TAK color mappings (14 total)
  'TAK_COLOR_YELLOW',
  'TAK_COLOR_CYAN',
  'TAK_COLOR_GREEN',
  'TAK_COLOR_RED',
  'TAK_COLOR_PURPLE',
  'TAK_COLOR_ORANGE',
  'TAK_COLOR_BLUE',
  'TAK_COLOR_MAGENTA',
  'TAK_COLOR_WHITE',
  'TAK_COLOR_MAROON',
  'TAK_COLOR_DARK_BLUE',
  'TAK_COLOR_TEAL',
  'TAK_COLOR_DARK_GREEN',
  'TAK_COLOR_BROWN',
  // TAK role descriptions (8 total)
  'TAK_ROLE_TEAM_MEMBER',
  'TAK_ROLE_TEAM_LEAD',
  'TAK_ROLE_SNIPER',
  'TAK_ROLE_MEDIC',
  'TAK_ROLE_FORWARD_OBSERVER',
  'TAK_ROLE_RTO',
  'TAK_ROLE_K9',
  'TAK_ROLE_HQ',
];

/**
 * Converts a TAK color/role environment variable name into its
 * system_config.config_key (e.g. TAK_COLOR_DARK_BLUE -> tak_color_dark_blue).
 * @param {string} envVarName
 * @returns {string}
 */
const toConfigKey = (envVarName) => envVarName.toLowerCase();

/**
 * Escapes a value for safe embedding as a single-quoted SQL string literal
 * (double every embedded single quote).
 * @param {string} value
 * @returns {string}
 */
const sqlStringLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  // -------------------------------------------------------------------------
  // 1. Full schema DDL (cleaned pg_dump --schema-only output; see file header).
  // -------------------------------------------------------------------------
  pgm.sql(`
--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;




--
-- Name: access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_requests (
    id integer NOT NULL,
    request_type character varying(50) NOT NULL,
    requester_email character varying(255) NOT NULL,
    requester_first_name character varying(255),
    requester_last_name character varying(255),
    existing_user_id integer,
    target_team_id integer,
    current_team_id integer,
    requested_role character varying(50),
    requested_first_name character varying(255),
    requested_last_name character varying(255),
    justification text,
    status character varying(20) DEFAULT 'pending'::character varying,
    email_verified boolean DEFAULT false,
    email_verification_token character varying(255),
    email_verification_expires_at timestamp without time zone,
    assigned_to_admin integer,
    escalation_level integer DEFAULT 0,
    escalates_at timestamp without time zone,
    processed_by integer,
    processed_at timestamp without time zone,
    denial_reason text,
    created_at timestamp without time zone DEFAULT now(),
    callsign_suffix character varying(255),
    signup_code_used character varying(8),
    approval_team_id integer,
    initiated_by integer
);


--
-- Name: COLUMN access_requests.approval_team_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.access_requests.approval_team_id IS 'Requirement 3.2/3.3: the Team whose Team_Admins may approve or deny this Transfer_Request.';


--
-- Name: COLUMN access_requests.initiated_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.access_requests.initiated_by IS 'Requirement 3.2/3.3: the Initiating_Admin who created this Transfer_Request.';


--
-- Name: access_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.access_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: access_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.access_requests_id_seq OWNED BY public.access_requests.id;


--
-- Name: admin_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_preferences (
    id integer NOT NULL,
    user_id integer,
    notification_method character varying(20) DEFAULT 'daily_digest'::character varying,
    digest_time time without time zone DEFAULT '09:00:00'::time without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: admin_notification_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notification_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notification_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notification_preferences_id_seq OWNED BY public.admin_notification_preferences.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    user_id integer,
    action character varying(100) NOT NULL,
    resource_type character varying(50) NOT NULL,
    resource_id integer,
    details jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: bch_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bch_channels (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    display_name character varying(255) NOT NULL,
    description text,
    service_account_id character varying(255),
    service_account_username character varying(255),
    service_account_password text,
    read_group_id character varying(255),
    write_group_id character varying(255),
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: bch_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bch_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bch_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bch_channels_id_seq OWNED BY public.bch_channels.id;


--
-- Name: bulk_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_operations (
    id integer NOT NULL,
    operation_name character varying(100) NOT NULL,
    total_items integer NOT NULL,
    processed_items integer DEFAULT 0,
    failed_items integer DEFAULT 0,
    status character varying(20) DEFAULT 'pending'::character varying,
    progress_percentage numeric(5,2) DEFAULT 0,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone
);


--
-- Name: bulk_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bulk_operations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bulk_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bulk_operations_id_seq OWNED BY public.bulk_operations.id;


--
-- Name: channel_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_memberships (
    id integer NOT NULL,
    user_id integer,
    channel_id integer,
    permission character varying(20) DEFAULT 'read_write'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: channel_memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channel_memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channel_memberships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.channel_memberships_id_seq OWNED BY public.channel_memberships.id;


--
-- Name: channel_requests; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: channel_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channel_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channel_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.channel_requests_id_seq OWNED BY public.channel_requests.id;


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    display_name character varying(255) NOT NULL,
    description text,
    team_id integer,
    authentik_group_id character varying(255),
    authentik_read_group_id character varying(255),
    authentik_write_group_id character varying(255),
    is_primary boolean DEFAULT false,
    channel_type character varying(20) DEFAULT 'primary'::character varying,
    custom_suffix character varying(255),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.channels_id_seq OWNED BY public.channels.id;


--
-- Name: deployment_channels; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: deployment_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deployment_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deployment_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deployment_channels_id_seq OWNED BY public.deployment_channels.id;


--
-- Name: email_rate_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_rate_tracking (
    id integer NOT NULL,
    email character varying(254) NOT NULL,
    window_start timestamp without time zone NOT NULL,
    count integer DEFAULT 1 NOT NULL
);


--
-- Name: email_rate_tracking_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_rate_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_rate_tracking_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_rate_tracking_id_seq OWNED BY public.email_rate_tracking.id;


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_templates (
    id integer NOT NULL,
    template_key character varying(100) NOT NULL,
    subject_template text NOT NULL,
    body_template text NOT NULL,
    description text,
    updated_by integer,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: email_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_templates_id_seq OWNED BY public.email_templates.id;


--
-- Name: group_membership_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_membership_rules (
    id integer NOT NULL,
    rule_name character varying(100) NOT NULL,
    rule_type character varying(50) NOT NULL,
    source_type character varying(50),
    source_id integer,
    target_group_pattern character varying(255) NOT NULL,
    permission_type character varying(20),
    conditions jsonb,
    is_active boolean DEFAULT true,
    priority integer DEFAULT 100,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: group_membership_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.group_membership_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: group_membership_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.group_membership_rules_id_seq OWNED BY public.group_membership_rules.id;


--
-- Name: mou_documents; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: mou_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mou_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mou_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mou_documents_id_seq OWNED BY public.mou_documents.id;


--
-- Name: mou_signatures; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: mou_signatures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mou_signatures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mou_signatures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mou_signatures_id_seq OWNED BY public.mou_signatures.id;


--
-- Name: org_allowed_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_allowed_domains (
    id integer NOT NULL,
    org_id integer NOT NULL,
    domain character varying(255) NOT NULL
);


--
-- Name: org_allowed_domains_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_allowed_domains_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_allowed_domains_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_allowed_domains_id_seq OWNED BY public.org_allowed_domains.id;


--
-- Name: org_interest_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_interest_requests (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(255),
    last_name character varying(255),
    org_name character varying(255) NOT NULL,
    status character varying(20) DEFAULT '''pending'''::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: org_interest_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_interest_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_interest_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_interest_requests_id_seq OWNED BY public.org_interest_requests.id;


--
-- Name: region_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.region_channels (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    display_name character varying(255) NOT NULL,
    description text,
    group_id character varying(255),
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: region_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.region_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: region_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.region_channels_id_seq OWNED BY public.region_channels.id;


--
-- Name: signup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signup_codes (
    id integer NOT NULL,
    team_id integer NOT NULL,
    code character varying(8) NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: signup_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.signup_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: signup_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.signup_codes_id_seq OWNED BY public.signup_codes.id;


--
-- Name: site_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_config (
    id integer NOT NULL,
    config_key character varying(100) NOT NULL,
    config_value text NOT NULL,
    description text,
    updated_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: site_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.site_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: site_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.site_config_id_seq OWNED BY public.site_config.id;


--
-- Name: sync_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_operations (
    id integer NOT NULL,
    operation_type character varying(50) NOT NULL,
    target_user_id integer,
    target_group_id character varying(255),
    payload jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 48,
    next_retry_at timestamp without time zone DEFAULT now(),
    error_message text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_by integer,
    correlation_id uuid,
    failure_category text
);


--
-- Name: COLUMN sync_operations.operation_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sync_operations.operation_type IS 'Operation type discriminator, e.g. ''add_user_to_group'', ''remove_user_from_group'', ''create_group'', ''revoke_tak_certificates'' (Requirement 26.6). No CHECK constraint: see server/workers/operationSchemas.js for the authoritative, application-enforced set of valid values.';


--
-- Name: sync_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sync_operations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sync_operations_id_seq OWNED BY public.sync_operations.id;


--
-- Name: sync_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_status (
    id integer NOT NULL,
    sync_type character varying(50) NOT NULL,
    last_sync timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    error_message text,
    records_synced integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: sync_status_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sync_status_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_status_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sync_status_id_seq OWNED BY public.sync_status.id;


--
-- Name: sync_worker_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_worker_heartbeat (
    id integer NOT NULL,
    last_heartbeat_at timestamp without time zone DEFAULT now() NOT NULL,
    worker_id character varying(255),
    CONSTRAINT sync_worker_heartbeat_single_row CHECK ((id = 1))
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    id integer NOT NULL,
    config_key character varying(100) NOT NULL,
    config_value text NOT NULL,
    description text,
    updated_by integer,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: system_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_config_id_seq OWNED BY public.system_config.id;


--
-- Name: team_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_memberships (
    id integer NOT NULL,
    user_id integer,
    team_id integer,
    role character varying(20) DEFAULT 'member'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    inherited_from_team_id integer
);


--
-- Name: team_memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_memberships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_memberships_id_seq OWNED BY public.team_memberships.id;


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    callsign_prefix character varying(255),
    color character varying(7) DEFAULT '#3B82F6'::character varying,
    visibility character varying(20) DEFAULT 'private'::character varying,
    can_join boolean DEFAULT false,
    parent_team_id integer,
    created_by integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    callsign_name_format character varying(50) DEFAULT 'full_name'::character varying,
    callsign_level_selection integer[]
);


--
-- Name: teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;


--
-- Name: token_revocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_revocations (
    jti uuid NOT NULL,
    expires_at timestamp without time zone NOT NULL
);


--
-- Name: user_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_cache (
    id integer NOT NULL,
    authentik_id character varying(255) NOT NULL,
    username character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(255),
    last_name character varying(255),
    is_active boolean DEFAULT true,
    tak_role character varying(100),
    tak_color character varying(50),
    tak_callsign character varying(100),
    groups text[],
    is_admin boolean DEFAULT false,
    last_synced timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_team_device boolean DEFAULT false NOT NULL,
    device_label text,
    callsign_suffix character varying(255)
);


--
-- Name: user_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_cache_id_seq OWNED BY public.user_cache.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    authentik_user_id integer,
    username character varying(150) NOT NULL,
    email character varying(254) NOT NULL,
    first_name character varying(150),
    last_name character varying(150),
    is_global_manager boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_vendor boolean DEFAULT false NOT NULL,
    is_team_device boolean DEFAULT false NOT NULL,
    device_label text,
    callsign_suffix character varying(255),
    tak_role character varying(50) DEFAULT 'Team Member'::character varying NOT NULL,
    origin_org_id integer
);


--
-- Name: COLUMN users.origin_org_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.origin_org_id IS 'Requirement 13.1: the Organisation that originated this user, recorded at creation. NULL for every row created before this migration and for any user whose originating Organisation has since been deleted; such a user falls back to Email_Domain matching (Requirement 13.7).';


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vendor_channel_grants; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: vendor_channel_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_channel_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_channel_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_channel_grants_id_seq OWNED BY public.vendor_channel_grants.id;


--
-- Name: vendor_channels; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: vendor_channels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vendor_channels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vendor_channels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vendor_channels_id_seq OWNED BY public.vendor_channels.id;


--
-- Name: access_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests ALTER COLUMN id SET DEFAULT nextval('public.access_requests_id_seq'::regclass);


--
-- Name: admin_notification_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences ALTER COLUMN id SET DEFAULT nextval('public.admin_notification_preferences_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: bch_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bch_channels ALTER COLUMN id SET DEFAULT nextval('public.bch_channels_id_seq'::regclass);


--
-- Name: bulk_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations ALTER COLUMN id SET DEFAULT nextval('public.bulk_operations_id_seq'::regclass);


--
-- Name: channel_memberships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_memberships ALTER COLUMN id SET DEFAULT nextval('public.channel_memberships_id_seq'::regclass);


--
-- Name: channel_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_requests ALTER COLUMN id SET DEFAULT nextval('public.channel_requests_id_seq'::regclass);


--
-- Name: channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels ALTER COLUMN id SET DEFAULT nextval('public.channels_id_seq'::regclass);


--
-- Name: deployment_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_channels ALTER COLUMN id SET DEFAULT nextval('public.deployment_channels_id_seq'::regclass);


--
-- Name: email_rate_tracking id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_rate_tracking ALTER COLUMN id SET DEFAULT nextval('public.email_rate_tracking_id_seq'::regclass);


--
-- Name: email_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates ALTER COLUMN id SET DEFAULT nextval('public.email_templates_id_seq'::regclass);


--
-- Name: group_membership_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_membership_rules ALTER COLUMN id SET DEFAULT nextval('public.group_membership_rules_id_seq'::regclass);


--
-- Name: mou_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_documents ALTER COLUMN id SET DEFAULT nextval('public.mou_documents_id_seq'::regclass);


--
-- Name: mou_signatures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures ALTER COLUMN id SET DEFAULT nextval('public.mou_signatures_id_seq'::regclass);


--
-- Name: org_allowed_domains id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_allowed_domains ALTER COLUMN id SET DEFAULT nextval('public.org_allowed_domains_id_seq'::regclass);


--
-- Name: org_interest_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_interest_requests ALTER COLUMN id SET DEFAULT nextval('public.org_interest_requests_id_seq'::regclass);


--
-- Name: region_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_channels ALTER COLUMN id SET DEFAULT nextval('public.region_channels_id_seq'::regclass);


--
-- Name: signup_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes ALTER COLUMN id SET DEFAULT nextval('public.signup_codes_id_seq'::regclass);


--
-- Name: site_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_config ALTER COLUMN id SET DEFAULT nextval('public.site_config_id_seq'::regclass);


--
-- Name: sync_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_operations ALTER COLUMN id SET DEFAULT nextval('public.sync_operations_id_seq'::regclass);


--
-- Name: sync_status id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_status ALTER COLUMN id SET DEFAULT nextval('public.sync_status_id_seq'::regclass);


--
-- Name: system_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config ALTER COLUMN id SET DEFAULT nextval('public.system_config_id_seq'::regclass);


--
-- Name: team_memberships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships ALTER COLUMN id SET DEFAULT nextval('public.team_memberships_id_seq'::regclass);


--
-- Name: teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);


--
-- Name: user_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cache ALTER COLUMN id SET DEFAULT nextval('public.user_cache_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: vendor_channel_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channel_grants ALTER COLUMN id SET DEFAULT nextval('public.vendor_channel_grants_id_seq'::regclass);


--
-- Name: vendor_channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channels ALTER COLUMN id SET DEFAULT nextval('public.vendor_channels_id_seq'::regclass);


--
-- Name: access_requests access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_preferences admin_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_preferences admin_notification_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_user_id_key UNIQUE (user_id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: bch_channels bch_channels_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bch_channels
    ADD CONSTRAINT bch_channels_name_key UNIQUE (name);


--
-- Name: bch_channels bch_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bch_channels
    ADD CONSTRAINT bch_channels_pkey PRIMARY KEY (id);


--
-- Name: bulk_operations bulk_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations
    ADD CONSTRAINT bulk_operations_pkey PRIMARY KEY (id);


--
-- Name: channel_memberships channel_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_pkey PRIMARY KEY (id);


--
-- Name: channel_memberships channel_memberships_user_id_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_user_id_channel_id_key UNIQUE (user_id, channel_id);


--
-- Name: channel_requests channel_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_pkey PRIMARY KEY (id);


--
-- Name: channels channels_name_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_name_team_id_key UNIQUE (name, team_id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: deployment_channels deployment_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_channels
    ADD CONSTRAINT deployment_channels_pkey PRIMARY KEY (id);


--
-- Name: email_rate_tracking email_rate_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_rate_tracking
    ADD CONSTRAINT email_rate_tracking_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_template_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_template_key_key UNIQUE (template_key);


--
-- Name: group_membership_rules group_membership_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_membership_rules
    ADD CONSTRAINT group_membership_rules_pkey PRIMARY KEY (id);


--
-- Name: mou_documents mou_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_pkey PRIMARY KEY (id);


--
-- Name: mou_signatures mou_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_pkey PRIMARY KEY (id);


--
-- Name: org_allowed_domains org_allowed_domains_org_id_domain_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_allowed_domains
    ADD CONSTRAINT org_allowed_domains_org_id_domain_unique UNIQUE (org_id, domain);


--
-- Name: org_allowed_domains org_allowed_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_allowed_domains
    ADD CONSTRAINT org_allowed_domains_pkey PRIMARY KEY (id);


--
-- Name: org_interest_requests org_interest_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_interest_requests
    ADD CONSTRAINT org_interest_requests_pkey PRIMARY KEY (id);


--
-- Name: region_channels region_channels_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_channels
    ADD CONSTRAINT region_channels_name_key UNIQUE (name);


--
-- Name: region_channels region_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_channels
    ADD CONSTRAINT region_channels_pkey PRIMARY KEY (id);


--
-- Name: signup_codes signup_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_code_key UNIQUE (code);


--
-- Name: signup_codes signup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_pkey PRIMARY KEY (id);


--
-- Name: signup_codes signup_codes_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_team_id_key UNIQUE (team_id);


--
-- Name: site_config site_config_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_config
    ADD CONSTRAINT site_config_config_key_key UNIQUE (config_key);


--
-- Name: site_config site_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_config
    ADD CONSTRAINT site_config_pkey PRIMARY KEY (id);


--
-- Name: sync_operations sync_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_operations
    ADD CONSTRAINT sync_operations_pkey PRIMARY KEY (id);


--
-- Name: sync_status sync_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_status
    ADD CONSTRAINT sync_status_pkey PRIMARY KEY (id);


--
-- Name: sync_worker_heartbeat sync_worker_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_worker_heartbeat
    ADD CONSTRAINT sync_worker_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_config_key_key UNIQUE (config_key);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);


--
-- Name: team_memberships team_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_pkey PRIMARY KEY (id);


--
-- Name: team_memberships team_memberships_user_id_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_user_id_team_id_key UNIQUE (user_id, team_id);


--
-- Name: teams teams_name_parent_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_name_parent_team_id_key UNIQUE (name, parent_team_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: token_revocations token_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_revocations
    ADD CONSTRAINT token_revocations_pkey PRIMARY KEY (jti);


--
-- Name: user_cache user_cache_authentik_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cache
    ADD CONSTRAINT user_cache_authentik_id_key UNIQUE (authentik_id);


--
-- Name: user_cache user_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cache
    ADD CONSTRAINT user_cache_pkey PRIMARY KEY (id);


--
-- Name: user_cache user_cache_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cache
    ADD CONSTRAINT user_cache_username_key UNIQUE (username);


--
-- Name: users users_authentik_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_authentik_user_id_key UNIQUE (authentik_user_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: vendor_channel_grants vendor_channel_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_pkey PRIMARY KEY (id);


--
-- Name: vendor_channels vendor_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channels
    ADD CONSTRAINT vendor_channels_pkey PRIMARY KEY (id);


--
-- Name: email_rate_tracking_email_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_rate_tracking_email_index ON public.email_rate_tracking USING btree (email);


--
-- Name: email_rate_tracking_email_window_start_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_rate_tracking_email_window_start_index ON public.email_rate_tracking USING btree (email, window_start);


--
-- Name: idx_access_requests_approval_team_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_approval_team_pending ON public.access_requests USING btree (approval_team_id) WHERE (((status)::text = 'pending'::text) AND ((request_type)::text = 'team_change'::text));


--
-- Name: idx_access_requests_escalates_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_escalates_at ON public.access_requests USING btree (escalates_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_access_requests_one_pending_team_change_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_access_requests_one_pending_team_change_per_user ON public.access_requests USING btree (existing_user_id) WHERE (((status)::text = 'pending'::text) AND ((request_type)::text = 'team_change'::text));


--
-- Name: idx_access_requests_status_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_requests_status_new ON public.access_requests USING btree (status);


--
-- Name: idx_audit_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created ON public.audit_logs USING btree (created_at);


--
-- Name: idx_audit_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_user ON public.audit_logs USING btree (user_id);


--
-- Name: idx_channel_memberships_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_memberships_channel ON public.channel_memberships USING btree (channel_id);


--
-- Name: idx_channel_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_memberships_user ON public.channel_memberships USING btree (user_id);


--
-- Name: idx_channels_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_team ON public.channels USING btree (team_id);


--
-- Name: idx_deployment_channels_pending_deactivation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deployment_channels_pending_deactivation ON public.deployment_channels USING btree (deployment_end_date) WHERE ((is_active = true) AND (deployment_end_date IS NOT NULL));


--
-- Name: idx_mou_documents_one_current_agreement; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mou_documents_one_current_agreement ON public.mou_documents USING btree (is_current_agreement) WHERE (is_current_agreement = true);


--
-- Name: idx_mou_signatures_document_signer_team; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mou_signatures_document_signer_team ON public.mou_signatures USING btree (mou_document_id, signer_team_id) WHERE (signer_team_id IS NOT NULL);


--
-- Name: idx_mou_signatures_document_signer_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mou_signatures_document_signer_user ON public.mou_signatures USING btree (mou_document_id, signer_user_id) WHERE (signer_user_id IS NOT NULL);


--
-- Name: idx_org_interest_requests_email_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_interest_requests_email_status ON public.org_interest_requests USING btree (email, status);


--
-- Name: idx_site_config_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_site_config_key ON public.site_config USING btree (config_key);


--
-- Name: idx_sync_operations_next_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_operations_next_retry ON public.sync_operations USING btree (next_retry_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_sync_operations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sync_operations_status ON public.sync_operations USING btree (status);


--
-- Name: idx_team_memberships_one_direct_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_team_memberships_one_direct_per_user ON public.team_memberships USING btree (user_id) WHERE (inherited_from_team_id IS NULL);


--
-- Name: idx_team_memberships_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_role ON public.team_memberships USING btree (role);


--
-- Name: idx_team_memberships_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_team ON public.team_memberships USING btree (team_id);


--
-- Name: idx_team_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_user ON public.team_memberships USING btree (user_id);


--
-- Name: idx_teams_callsign_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_callsign_prefix ON public.teams USING btree (callsign_prefix) WHERE (callsign_prefix IS NOT NULL);


--
-- Name: idx_teams_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_parent ON public.teams USING btree (parent_team_id);


--
-- Name: idx_user_cache_authentik_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cache_authentik_id ON public.user_cache USING btree (authentik_id);


--
-- Name: idx_user_cache_is_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cache_is_admin ON public.user_cache USING btree (is_admin);


--
-- Name: idx_user_cache_last_synced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cache_last_synced ON public.user_cache USING btree (last_synced);


--
-- Name: idx_user_cache_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cache_username ON public.user_cache USING btree (username);


--
-- Name: idx_users_origin_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_origin_org_id ON public.users USING btree (origin_org_id) WHERE (origin_org_id IS NOT NULL);


--
-- Name: idx_vendor_channel_grants_pending_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vendor_channel_grants_pending_expiry ON public.vendor_channel_grants USING btree (expires_at) WHERE ((revoked_at IS NULL) AND (expires_at IS NOT NULL));


--
-- Name: idx_vendor_channels_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vendor_channels_one_active ON public.vendor_channels USING btree (is_active) WHERE (is_active = true);


--
-- Name: org_allowed_domains_org_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_allowed_domains_org_id_index ON public.org_allowed_domains USING btree (org_id);


--
-- Name: signup_codes_code_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signup_codes_code_index ON public.signup_codes USING btree (code);


--
-- Name: token_revocations_expires_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX token_revocations_expires_at_index ON public.token_revocations USING btree (expires_at);


--
-- Name: admin_notification_preferences update_admin_notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_admin_notification_preferences_updated_at BEFORE UPDATE ON public.admin_notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: channels update_channels_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_templates update_email_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_email_templates_updated_at BEFORE UPDATE ON public.email_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: mou_documents update_mou_documents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_mou_documents_updated_at BEFORE UPDATE ON public.mou_documents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: site_config update_site_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_site_config_updated_at BEFORE UPDATE ON public.site_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: system_config update_system_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_system_config_updated_at BEFORE UPDATE ON public.system_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: teams update_teams_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_teams_updated_at BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users update_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: access_requests access_requests_approval_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_approval_team_id_fkey FOREIGN KEY (approval_team_id) REFERENCES public.teams(id);


--
-- Name: access_requests access_requests_assigned_to_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_assigned_to_admin_fkey FOREIGN KEY (assigned_to_admin) REFERENCES public.users(id);


--
-- Name: access_requests access_requests_current_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_current_team_id_fkey FOREIGN KEY (current_team_id) REFERENCES public.teams(id);


--
-- Name: access_requests access_requests_existing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_existing_user_id_fkey FOREIGN KEY (existing_user_id) REFERENCES public.users(id);


--
-- Name: access_requests access_requests_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: access_requests access_requests_processed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_processed_by_fkey FOREIGN KEY (processed_by) REFERENCES public.users(id);


--
-- Name: access_requests access_requests_target_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_target_team_id_fkey FOREIGN KEY (target_team_id) REFERENCES public.teams(id);


--
-- Name: admin_notification_preferences admin_notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: bch_channels bch_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bch_channels
    ADD CONSTRAINT bch_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: bulk_operations bulk_operations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations
    ADD CONSTRAINT bulk_operations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: channel_memberships channel_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_memberships
    ADD CONSTRAINT channel_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: channel_requests channel_requests_processed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_processed_by_fkey FOREIGN KEY (processed_by) REFERENCES public.users(id);


--
-- Name: channel_requests channel_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: channel_requests channel_requests_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_requests
    ADD CONSTRAINT channel_requests_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: channels channels_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: deployment_channels deployment_channels_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_channels
    ADD CONSTRAINT deployment_channels_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: email_templates email_templates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: mou_documents mou_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: mou_documents mou_documents_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: mou_documents mou_documents_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_documents
    ADD CONSTRAINT mou_documents_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: mou_signatures mou_signatures_countersigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_countersigned_by_fkey FOREIGN KEY (countersigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: mou_signatures mou_signatures_mou_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_mou_document_id_fkey FOREIGN KEY (mou_document_id) REFERENCES public.mou_documents(id) ON DELETE CASCADE;


--
-- Name: mou_signatures mou_signatures_signer_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_signer_team_id_fkey FOREIGN KEY (signer_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: mou_signatures mou_signatures_signer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mou_signatures
    ADD CONSTRAINT mou_signatures_signer_user_id_fkey FOREIGN KEY (signer_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_allowed_domains org_allowed_domains_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_allowed_domains
    ADD CONSTRAINT org_allowed_domains_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: region_channels region_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_channels
    ADD CONSTRAINT region_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: signup_codes signup_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: signup_codes signup_codes_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_codes
    ADD CONSTRAINT signup_codes_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: site_config site_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_config
    ADD CONSTRAINT site_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: sync_operations sync_operations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_operations
    ADD CONSTRAINT sync_operations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: system_config system_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: team_memberships team_memberships_inherited_from_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_inherited_from_team_id_fkey FOREIGN KEY (inherited_from_team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_memberships team_memberships_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_memberships team_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: teams teams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: teams teams_parent_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_parent_team_id_fkey FOREIGN KEY (parent_team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: users users_origin_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_origin_org_id_fkey FOREIGN KEY (origin_org_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: vendor_channel_grants vendor_channel_grants_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: vendor_channel_grants vendor_channel_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channel_grants
    ADD CONSTRAINT vendor_channel_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: vendor_channels vendor_channels_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_channels
    ADD CONSTRAINT vendor_channels_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
`);

  // -------------------------------------------------------------------------
  // 2. Seed: TAK color/role system_config rows (former 1786790000000).
  //    ENV-based and dynamic — reads process.env at migration-run time.
  // -------------------------------------------------------------------------
  const valuesSql = SEED_ENV_VARS.map((envVarName) => {
    const configKey = toConfigKey(envVarName);
    const configValue = process.env[envVarName] || '';
    const description = `Migrated from ${envVarName} environment variable (Requirement 32.1)`;
    return `(${sqlStringLiteral(configKey)}, ${sqlStringLiteral(configValue)}, ${sqlStringLiteral(description)})`;
  }).join(',\n    ');

  pgm.sql(`
    INSERT INTO system_config (config_key, config_value, description)
    VALUES
    ${valuesSql}
    ON CONFLICT (config_key) DO NOTHING;
  `);

  // -------------------------------------------------------------------------
  // 3a. Seed: request-access-page site_config rows. These were originally
  //     INSERTed by the previous baseline migration's up(); the schema DDL
  //     above (from pg_dump --schema-only) carries no data, so they are
  //     re-seeded here to preserve site_config parity. ON CONFLICT added for
  //     idempotency (the original used a bare INSERT).
  // -------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO site_config (config_key, config_value, description) VALUES
    ('request_access_title', 'Request Team Access', 'Title shown on the request access page'),
    ('request_access_subtitle', 'Fill out this form to request access to a TAK team', 'Subtitle shown on the request access page'),
    ('request_access_footer', 'Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to TAK.GOV for more information on TAK.', 'Footer text shown at the bottom of the request access page')
    ON CONFLICT (config_key) DO NOTHING;
  `);

  // -------------------------------------------------------------------------
  // 3b. Seed: branding site_config rows (former 1786800000000).
  // -------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO site_config (config_key, config_value, description)
    VALUES
    ('organization_display_name', 'TAK Team Manager', 'Organization display name shown throughout the App UI (Requirement 32.2)'),
    ('organization_logo_path', '', 'Reference (path/URL) to the organization logo asset (Requirement 32.2)')
    ON CONFLICT (config_key) DO NOTHING;
  `);

  // -------------------------------------------------------------------------
  // 4. Seed: excluded_email_domains system_config row (former 1786890000000).
  // -------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO system_config (config_key, config_value, description)
    VALUES (
      'excluded_email_domains',
      '[]',
      'Global list of consumer/freemail domains blocked from org interest requests (Requirement 6)'
    )
    ON CONFLICT (config_key) DO NOTHING;
  `);

  // -------------------------------------------------------------------------
  // 5. Seed: signup email templates (former 1786900000000).
  // -------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'signup_pending_review',
      'Your account request is being reviewed',
      'Hi,

Your account request is currently being reviewed by a team administrator. You will receive another email once a decision has been made.

If you have questions, contact your team administrator.',
      'Sent when a user re-submits email at step 1 but already has a pending approval'
    )
    ON CONFLICT (template_key) DO NOTHING;

    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'signup_already_active',
      'You already have an account',
      'Hi,

An account already exists with this email address.

If you need to reset your password, visit: {{password_reset_url}}

If you did not initiate this request, please ignore this email.',
      'Sent when a user submits email at step 1 but already has an active account'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);

  // -------------------------------------------------------------------------
  // 6. Seed: team_transfer_completed email template (former 1786930000000).
  //    Dollar-quoted body ($tpl$...$tpl$), ON CONFLICT DO NOTHING.
  // -------------------------------------------------------------------------
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'team_transfer_completed',
      'Your team assignment has changed',
      $tpl$Hi {{first_name}},

Your team assignment has been changed to:

  {{team_path}}

Your TAK callsign is now: {{callsign}}

Your previous team's channels are no longer available to you. If this
change is unexpected, contact your team administrator.$tpl$,
      'Sent to a user whose Direct_Membership was moved by a Team_Transfer'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);

  // NOTE: the former styling UPDATEs (access_request_verification and
  // access_request_approved) are intentionally NOT here. Their final styled
  // body_template content has been folded into database/init.js's INSERTs,
  // which run after this migration. See file header.
};

/**
 * Baseline teardown. Drops every object created by up(), in an order that
 * respects foreign keys. Triggers are dropped first, then all tables with
 * CASCADE (which also drops their sequences, constraints, indexes, and FKs),
 * then the shared trigger function. CASCADE + IF EXISTS keeps this simple and
 * order-robust.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
DROP TRIGGER IF EXISTS update_admin_notification_preferences_updated_at ON public.admin_notification_preferences;
DROP TRIGGER IF EXISTS update_channels_updated_at ON public.channels;
DROP TRIGGER IF EXISTS update_email_templates_updated_at ON public.email_templates;
DROP TRIGGER IF EXISTS update_mou_documents_updated_at ON public.mou_documents;
DROP TRIGGER IF EXISTS update_site_config_updated_at ON public.site_config;
DROP TRIGGER IF EXISTS update_system_config_updated_at ON public.system_config;
DROP TRIGGER IF EXISTS update_teams_updated_at ON public.teams;
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;

DROP TABLE IF EXISTS public.access_requests CASCADE;
DROP TABLE IF EXISTS public.admin_notification_preferences CASCADE;
DROP TABLE IF EXISTS public.audit_logs CASCADE;
DROP TABLE IF EXISTS public.bch_channels CASCADE;
DROP TABLE IF EXISTS public.bulk_operations CASCADE;
DROP TABLE IF EXISTS public.channel_memberships CASCADE;
DROP TABLE IF EXISTS public.channel_requests CASCADE;
DROP TABLE IF EXISTS public.channels CASCADE;
DROP TABLE IF EXISTS public.deployment_channels CASCADE;
DROP TABLE IF EXISTS public.email_rate_tracking CASCADE;
DROP TABLE IF EXISTS public.email_templates CASCADE;
DROP TABLE IF EXISTS public.group_membership_rules CASCADE;
DROP TABLE IF EXISTS public.mou_documents CASCADE;
DROP TABLE IF EXISTS public.mou_signatures CASCADE;
DROP TABLE IF EXISTS public.org_allowed_domains CASCADE;
DROP TABLE IF EXISTS public.org_interest_requests CASCADE;
DROP TABLE IF EXISTS public.region_channels CASCADE;
DROP TABLE IF EXISTS public.signup_codes CASCADE;
DROP TABLE IF EXISTS public.site_config CASCADE;
DROP TABLE IF EXISTS public.sync_operations CASCADE;
DROP TABLE IF EXISTS public.sync_status CASCADE;
DROP TABLE IF EXISTS public.sync_worker_heartbeat CASCADE;
DROP TABLE IF EXISTS public.system_config CASCADE;
DROP TABLE IF EXISTS public.team_memberships CASCADE;
DROP TABLE IF EXISTS public.teams CASCADE;
DROP TABLE IF EXISTS public.token_revocations CASCADE;
DROP TABLE IF EXISTS public.user_cache CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.vendor_channel_grants CASCADE;
DROP TABLE IF EXISTS public.vendor_channels CASCADE;

DROP FUNCTION IF EXISTS public.update_updated_at_column();
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
