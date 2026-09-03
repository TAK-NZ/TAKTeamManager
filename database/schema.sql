-- ============================================================================
-- TAK Team Manager Database Schema (AUTO-GENERATED SNAPSHOT)
--
-- This file is a point-in-time reference generated via
-- `pg_dump --schema-only` against a database fully migrated by
-- `database/migrations/` (run via `node-pg-migrate` / `database/init.js`).
--
-- DO NOT HAND-EDIT this file. It is not executed by application code and
-- is not the source of truth for the schema -- `database/migrations/*.cjs`
-- is. Every future schema change must ship as a new migration file; this
-- snapshot should then be regenerated (see the migrations README/task
-- history for the exact `pg_dump` invocation used) so it stays a useful,
-- readable reference for the current schema shape.
-- ============================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 15.18 (Debian 15.18-1.pgdg13+1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    created_at timestamp without time zone DEFAULT now(),
    category character varying(20) DEFAULT 'BCH'::character varying NOT NULL,
    CONSTRAINT bch_channels_category_check CHECK (((category)::text = ANY ((ARRAY['BCH'::character varying, 'UTL'::character varying])::text[])))
);


--
-- Name: COLUMN bch_channels.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bch_channels.category IS 'Which channel category this row belongs to: ''BCH'' (broadcast/ETL feeds, the original category) or ''UTL'' (utility channels, e.g. "UTL - Data Packages"). NOT NULL DEFAULT ''BCH'' -- every row is unambiguously one category or the other, with no Sub_Team-style "not applicable" state. Drives the Authentik group-name prefix (tak_BCH.../tak_UTL...) via BCH_CHANNEL_CATEGORY_PREFIX in server/config/constants.js. Every row, regardless of category, is an unconditional read-group membership target for every active user -- category changes NAMING only, never the sync-worker''s unconditional-membership treatment.';


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
-- Name: cert_expiry_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cert_expiry_notifications (
    id integer NOT NULL,
    client_uid character varying(255) NOT NULL,
    cert_id integer NOT NULL,
    threshold_days integer NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cert_expiry_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cert_expiry_notifications IS 'cert-expiry-notifications Requirement 1: tracks which Cert_Expiry_Tier has already been resolved (emailed or deliberately skipped as stale-backlog) for a given certificate, keyed on (client_uid, cert_id, threshold_days) so a renewed certificate (new cert_id) starts every tier fresh. No foreign key to tak_devices -- this row must survive DeviceSync deleting a stale tak_devices row untouched, since it records a past send rather than a live reference.';


--
-- Name: cert_expiry_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cert_expiry_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cert_expiry_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cert_expiry_notifications_id_seq OWNED BY public.cert_expiry_notifications.id;


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
    created_at timestamp without time zone DEFAULT now(),
    tier character varying(20),
    CONSTRAINT region_channels_tier_check CHECK (((tier)::text = ANY ((ARRAY['response'::character varying, 'support'::character varying])::text[])))
);


--
-- Name: COLUMN region_channels.tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.region_channels.tier IS 'Which channel tier this region channel belongs to: ''response'' (Emergency_Response, ES-only inner circle, gated by teams.response_channel_access) or ''support'' (all-agency outer circle, gated by teams.support_channel_access). No default -- every insert path supplies it explicitly. See docs.tak.nz Channel Structure.';


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
-- Name: tak_devices; Type: TABLE; Schema: public; Owner: -
--

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
    updated_at timestamp with time zone DEFAULT now(),
    connected boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE tak_devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tak_devices IS 'Requirement 4.1/4.2: locally persisted TAK Server client certificates ("devices") for the optional device-management feature. One row per certificate clientUid.';


--
-- Name: COLUMN tak_devices.last_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tak_devices.last_seen_at IS 'Requirement 3.2-3.5: best-effort, monotonic-forward Last_Seen from the lastEventTime reported by the Client_Endpoints_API (GET /Marti/api/clientEndPoints). NULL means TAK Server retains no entry for this device; never rewound or nulled once set.';


--
-- Name: COLUMN tak_devices.connected; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tak_devices.connected IS 'Requirement 20.2-20.7: Connection_Status from ClientEndpoint.lastStatus (Client_Endpoints_API), collapsed per client_uid by the Status_Collapse_Rule -- connected when at least one reported entry says Connected, case-insensitively. Written by the Subscription_Poller only, on every successful poll, for every reported uid and NOT behind the Monotonic_Guard that clamps last_seen_at; set false for rows absent from a successful poll. A failed poll writes nothing.';


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
    callsign_level_selection integer[],
    pseudonymous_usernames boolean,
    response_channel_access boolean,
    support_channel_access boolean
);


--
-- Name: COLUMN teams.pseudonymous_usernames; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.pseudonymous_usernames IS 'takserver-enrollment Requirement 6: Organisation-level only, exactly as callsign_level_selection is. NULL on a Sub_Team (parent_team_id IS NOT NULL); false or true on an Organisation. Fixed at Organisation creation -- Requirement 7.2 rejects a change, because switching it would require every members username to change and would invalidate every certificate Common Name in the Organisation.';


--
-- Name: COLUMN teams.response_channel_access; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.response_channel_access IS 'Organisation-level only, exactly as pseudonymous_usernames and callsign_level_selection are. NULL on a Sub_Team (parent_team_id IS NOT NULL); false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into response-tier region channels. Defaults to false at Organisation creation (application-supplied, not a column default) and is mutable thereafter -- unlike pseudonymous_usernames, flipping it only triggers group-membership reconciliation, never an identifier/certificate consequence.';


--
-- Name: COLUMN teams.support_channel_access; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.teams.support_channel_access IS 'Organisation-level only, exactly as response_channel_access is (see that column''s comment for the tri-state rationale). NULL on a Sub_Team; false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into support-tier region channels. Defaults to true at Organisation creation (application-supplied) -- the outer/support tier is the all-agency default, opposite of response_channel_access. Mutable thereafter.';


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
    email character varying(255),
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
    callsign_suffix character varying(255),
    CONSTRAINT user_cache_email_required_unless_device CHECK (((email IS NOT NULL) OR (is_team_device = true)))
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
    email character varying(254),
    first_name character varying(150),
    last_name character varying(150),
    is_global_manager boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_team_device boolean DEFAULT false NOT NULL,
    device_label text,
    callsign_suffix character varying(255),
    tak_role character varying(50) DEFAULT 'Team Member'::character varying NOT NULL,
    origin_org_id integer,
    account_status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    CONSTRAINT users_account_status_check CHECK (((account_status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'orphaned'::character varying])::text[]))),
    CONSTRAINT users_email_required_unless_device CHECK (((email IS NOT NULL) OR (is_team_device = true)))
);


--
-- Name: COLUMN users.email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.email IS 'takserver-enrollment Requirement 5.3/5.4: nullable ONLY for a Team_Owned_Device. The Device_Email_Null_Invariant (users_email_required_unless_device) is what licenses the null; a human row with no email has no account-recovery path and is rejected by this constraint. The Authentik_Sync maps Authentiks empty-string email to NULL at exactly one point, normaliseAuthentikEmail.';


--
-- Name: COLUMN users.origin_org_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.origin_org_id IS 'Requirement 13.1: the Organisation that originated this user, recorded at creation. NULL for every row created before this migration and for any user whose originating Organisation has since been deleted; such a user falls back to Email_Domain matching (Requirement 13.7).';


--
-- Name: COLUMN users.account_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.account_status IS 'account-lifecycle-management: one of ''active'' (default), ''suspended'' (admin-initiated, reversible -- Authentik account and its is_active flag still exist, just locked; every live TAK Server certificate revoked), or ''orphaned'' (automatically detected by the Reconciliation_Sweep in authentikSync.js when the row''s authentik_user_id no longer appears in Authentik''s current user list; irreversible -- there is no Authentik identity left to reactivate). Kept consistent with users.is_active/user_cache.is_active by application code, not a trigger: is_active is false for both ''suspended'' and ''orphaned''. An ''orphaned'' row is NEVER deleted -- audit_logs.user_id and sibling foreign keys are non-cascading, so the row and its full history are retained indefinitely; a matching new sign-up instead adopts it via Account_Reclaim (see UserProvisioningService.createAndAddUser''s reclaimedUserId branch).';


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
-- Name: cert_expiry_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cert_expiry_notifications ALTER COLUMN id SET DEFAULT nextval('public.cert_expiry_notifications_id_seq'::regclass);


--
-- Name: channel_memberships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_memberships ALTER COLUMN id SET DEFAULT nextval('public.channel_memberships_id_seq'::regclass);


--
-- Name: channels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels ALTER COLUMN id SET DEFAULT nextval('public.channels_id_seq'::regclass);


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
-- Name: bch_channels bch_channels_name_category_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bch_channels
    ADD CONSTRAINT bch_channels_name_category_key UNIQUE (name, category);


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
-- Name: cert_expiry_notifications cert_expiry_notifications_client_uid_cert_id_threshold_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_client_uid_cert_id_threshold_key UNIQUE (client_uid, cert_id, threshold_days);


--
-- Name: cert_expiry_notifications cert_expiry_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_pkey PRIMARY KEY (id);


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
-- Name: region_channels region_channels_name_tier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_channels
    ADD CONSTRAINT region_channels_name_tier_key UNIQUE (name, tier);


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
-- Name: tak_devices tak_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tak_devices
    ADD CONSTRAINT tak_devices_pkey PRIMARY KEY (client_uid);


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
-- Name: idx_cert_expiry_notifications_client_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cert_expiry_notifications_client_uid ON public.cert_expiry_notifications USING btree (client_uid);


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
-- Name: idx_tak_devices_cert_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tak_devices_cert_id ON public.tak_devices USING btree (cert_id);


--
-- Name: idx_tak_devices_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tak_devices_user_id ON public.tak_devices USING btree (user_id);


--
-- Name: idx_tak_devices_user_id_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tak_devices_user_id_live ON public.tak_devices USING btree (user_id) WHERE (revoked = false);


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
-- Name: idx_users_account_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_account_status ON public.users USING btree (account_status) WHERE ((account_status)::text <> 'active'::text);


--
-- Name: idx_users_origin_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_origin_org_id ON public.users USING btree (origin_org_id) WHERE (origin_org_id IS NOT NULL);


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
-- Name: site_config update_site_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_site_config_updated_at BEFORE UPDATE ON public.site_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: system_config update_system_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_system_config_updated_at BEFORE UPDATE ON public.system_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tak_devices update_tak_devices_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tak_devices_updated_at BEFORE UPDATE ON public.tak_devices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


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
-- Name: channels channels_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: email_templates email_templates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


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
-- Name: tak_devices tak_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tak_devices
    ADD CONSTRAINT tak_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


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
-- PostgreSQL database dump complete
--


