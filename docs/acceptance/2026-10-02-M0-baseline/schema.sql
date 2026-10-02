--
-- PostgreSQL database dump
--



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
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_sessions (
    id_hash text NOT NULL,
    user_id bigint NOT NULL,
    csrf_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_agent text
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id bigint NOT NULL,
    feishu_union_id text,
    email text,
    display_name text,
    role text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    CONSTRAINT admin_users_role_check CHECK ((role = 'admin'::text))
);


--
-- Name: admin_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_users_id_seq OWNED BY public.admin_users.id;


--
-- Name: analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analyses (
    id bigint NOT NULL,
    article_id text NOT NULL,
    input_revision integer NOT NULL,
    origin text NOT NULL,
    model text,
    prompt_version text,
    receipt_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    relevance text,
    category text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    subjects text[] DEFAULT '{}'::text[] NOT NULL,
    title_zh text,
    summary_zh text,
    reason_zh text,
    score numeric(5,2),
    selected boolean,
    output jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analyses_origin_check CHECK ((origin = ANY (ARRAY['model'::text, 'replay'::text, 'rule'::text]))),
    CONSTRAINT analyses_relevance_check CHECK ((relevance = ANY (ARRAY['pass'::text, 'block'::text, 'unknown'::text])))
);


--
-- Name: analyses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.analyses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: analyses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.analyses_id_seq OWNED BY public.analyses.id;


--
-- Name: article_discoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_discoveries (
    article_id text NOT NULL,
    source_id text NOT NULL,
    via text NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: article_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_revisions (
    article_id text NOT NULL,
    revision integer NOT NULL,
    content_hash text,
    title text NOT NULL,
    body_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.articles (
    id text NOT NULL,
    source_id text NOT NULL,
    identity_key text NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    author text,
    language text,
    published_at timestamp with time zone,
    published_at_claim timestamp with time zone,
    discovered_at timestamp with time zone NOT NULL,
    source_updated_at timestamp with time zone,
    timeline_at timestamp with time zone NOT NULL,
    backfill boolean DEFAULT false NOT NULL,
    backfill_reason text,
    revision integer DEFAULT 1 NOT NULL,
    content_hash text,
    excerpt text,
    body_text text,
    body_html text,
    body_status text DEFAULT 'pending'::text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    x_post jsonb,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    grouped_at timestamp with time zone,
    processing_state text DEFAULT 'new'::text NOT NULL,
    processing_error text,
    processing_queued_at timestamp with time zone,
    processing_attempts integer DEFAULT 0 NOT NULL,
    processing_retry_at timestamp with time zone,
    x_article jsonb,
    CONSTRAINT articles_body_status_check CHECK ((body_status = ANY (ARRAY['pending'::text, 'ok'::text, 'unconfirmed'::text, 'none'::text]))),
    CONSTRAINT articles_id_check CHECK ((id ~ '^[a-zA-Z0-9_-]{1,80}$'::text)),
    CONSTRAINT articles_processing_state_check CHECK ((processing_state = ANY (ARRAY['new'::text, 'analyzed'::text, 'skipped'::text, 'failed'::text, 'blocked'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    subject text,
    reason text,
    before jsonb,
    after jsonb,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budgets (
    service text NOT NULL,
    per_minute integer NOT NULL,
    per_hour integer NOT NULL,
    per_day integer NOT NULL,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id bigint NOT NULL,
    target_key text NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    dedupe_key text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    payload jsonb,
    response text,
    origin text DEFAULT 'live'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deliveries_origin_check CHECK ((origin = ANY (ARRAY['live'::text, 'imported'::text]))),
    CONSTRAINT deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'unknown'::text, 'skipped'::text])))
);


--
-- Name: deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deliveries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deliveries_id_seq OWNED BY public.deliveries.id;


--
-- Name: delivery_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_leases (
    lease_key text NOT NULL,
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: editorial_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.editorial_overrides (
    article_id text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    visibility text,
    reason text,
    version integer DEFAULT 1 NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editorial_overrides_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'summary-only'::text, 'withdrawn'::text])))
);


--
-- Name: embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.embeddings (
    kind text NOT NULL,
    ref_id text NOT NULL,
    model text NOT NULL,
    text_hash text NOT NULL,
    vector real[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT embeddings_kind_check CHECK ((kind = ANY (ARRAY['fact'::text, 'article'::text, 'story'::text])))
);


--
-- Name: fact_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fact_articles (
    fact_id bigint NOT NULL,
    article_id text NOT NULL,
    role text DEFAULT 'report'::text NOT NULL,
    evidence text,
    manual boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fact_articles_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'report'::text, 'mention'::text])))
);


--
-- Name: facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facts (
    id bigint NOT NULL,
    public_id text NOT NULL,
    story_id bigint,
    title text NOT NULL,
    subject text,
    action text,
    object text,
    conditions text,
    occurred_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    manual boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: facts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.facts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: facts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.facts_id_seq OWNED BY public.facts.id;


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback (
    id bigint NOT NULL,
    content text NOT NULL,
    email text,
    page_url text,
    screenshot_key text,
    source_hash text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    note text,
    forwarded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    forward_error text,
    CONSTRAINT feedback_status_check CHECK ((status = ANY (ARRAY['new'::text, 'triaged'::text, 'replied'::text, 'resolved'::text, 'spam'::text])))
);


--
-- Name: feedback_bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback_bans (
    source_hash text NOT NULL,
    reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feedback_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feedback_id_seq OWNED BY public.feedback.id;


--
-- Name: fetch_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fetch_runs (
    id bigint NOT NULL,
    source_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    found_count integer DEFAULT 0 NOT NULL,
    new_count integer DEFAULT 0 NOT NULL,
    error text,
    detail jsonb,
    CONSTRAINT fetch_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: fetch_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fetch_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fetch_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fetch_runs_id_seq OWNED BY public.fetch_runs.id;


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    as_of date NOT NULL,
    pair text NOT NULL,
    rate numeric(12,6) NOT NULL,
    source_name text NOT NULL,
    source_url text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grouping_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grouping_decisions (
    id bigint NOT NULL,
    article_id text NOT NULL,
    fact_id bigint,
    story_id bigint,
    verdict text NOT NULL,
    candidates jsonb,
    receipt_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: grouping_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grouping_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grouping_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grouping_decisions_id_seq OWNED BY public.grouping_decisions.id;


--
-- Name: grouping_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grouping_overrides (
    article_id text NOT NULL,
    mode text DEFAULT 'standalone'::text NOT NULL,
    reason text,
    actor text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grouping_overrides_mode_check CHECK ((mode = 'standalone'::text))
);


--
-- Name: hot_rankings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hot_rankings (
    id bigint NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    rule_version text NOT NULL,
    entries jsonb NOT NULL,
    evidence jsonb,
    published boolean DEFAULT true NOT NULL
);


--
-- Name: hot_rankings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hot_rankings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hot_rankings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hot_rankings_id_seq OWNED BY public.hot_rankings.id;


--
-- Name: ingest_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_events (
    id bigint NOT NULL,
    client text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    summary jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingest_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ingest_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ingest_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ingest_events_id_seq OWNED BY public.ingest_events.id;


--
-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runs (
    id bigint NOT NULL,
    job text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    detail jsonb,
    error text,
    CONSTRAINT job_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: job_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: job_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_runs_id_seq OWNED BY public.job_runs.id;


--
-- Name: lb_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_aliases (
    id text NOT NULL,
    source_key text NOT NULL,
    alias text NOT NULL,
    normalized_alias text NOT NULL,
    model_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lb_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_models (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    provider text,
    provider_slug text,
    released_at timestamp with time zone,
    release_date_source text,
    context_window_tokens integer,
    input_price_usd numeric(12,4),
    output_price_usd numeric(12,4),
    metadata_source text,
    metadata_updated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lb_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_prices (
    model_id text NOT NULL,
    kind text NOT NULL,
    currency text NOT NULL,
    input numeric(14,6),
    output numeric(14,6),
    cached_input numeric(14,6),
    source_url text,
    verified_on date,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lb_prices_currency_check CHECK ((currency = ANY (ARRAY['CNY'::text, 'USD'::text]))),
    CONSTRAINT lb_prices_kind_check CHECK ((kind = ANY (ARRAY['official'::text, 'subscription'::text, 'relay'::text])))
);


--
-- Name: lb_rankings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_rankings (
    id bigint NOT NULL,
    run_id text NOT NULL,
    board text NOT NULL,
    model_id text NOT NULL,
    rank integer NOT NULL,
    score double precision,
    uncertainty double precision,
    coverage double precision,
    confidence text,
    metric_count integer,
    summary text,
    component_scores jsonb,
    detail jsonb
);


--
-- Name: lb_rankings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lb_rankings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lb_rankings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lb_rankings_id_seq OWNED BY public.lb_rankings.id;


--
-- Name: lb_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_runs (
    id text NOT NULL,
    methodology_version text NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    source_snapshot_ids text[] DEFAULT '{}'::text[] NOT NULL,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    origin text DEFAULT 'computed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lb_runs_origin_check CHECK ((origin = ANY (ARRAY['computed'::text, 'imported'::text]))),
    CONSTRAINT lb_runs_status_check CHECK ((status = ANY (ARRAY['published'::text, 'failed'::text, 'shadow'::text, 'historical'::text])))
);


--
-- Name: lb_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_scores (
    id text NOT NULL,
    snapshot_id text NOT NULL,
    model_id text NOT NULL,
    configuration_key text NOT NULL,
    configuration_label text,
    configuration_kind text,
    configuration_priority integer,
    selected_for_product boolean DEFAULT false NOT NULL,
    selection_reason text,
    metric_key text NOT NULL,
    metric_name text,
    raw_score double precision,
    normalized_score double precision,
    lower_bound double precision,
    upper_bound double precision,
    source_rank integer,
    sample_size integer,
    source_model_name text,
    source_organization text,
    source_published_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lb_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lb_snapshots (
    id text NOT NULL,
    source_key text NOT NULL,
    source_name text NOT NULL,
    source_url text,
    license text,
    attribution_url text,
    content_hash text,
    published_at timestamp with time zone,
    fetched_at timestamp with time zone NOT NULL,
    record_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: monitor_event_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitor_event_posts (
    event_id text NOT NULL,
    post_id text NOT NULL,
    stage text NOT NULL,
    action text,
    text text NOT NULL,
    original_text text NOT NULL
);


--
-- Name: monitor_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitor_events (
    id text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    title text NOT NULL,
    scope text DEFAULT ''::text NOT NULL,
    schedule jsonb,
    estimate jsonb,
    presentation jsonb,
    confirmed_at timestamp with time zone,
    occurred_on date,
    confirmation_basis text,
    withdrawn boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    display_label text DEFAULT ''::text NOT NULL,
    CONSTRAINT monitor_events_confirmation_basis_check CHECK ((confirmation_basis = ANY (ARRAY['source_post'::text, 'receipt_review'::text]))),
    CONSTRAINT monitor_events_status_check CHECK ((status = ANY (ARRAY['announced'::text, 'confirmed'::text]))),
    CONSTRAINT monitor_events_type_check CHECK ((type = ANY (ARRAY['direct_reset'::text, 'reset_credit'::text])))
);


--
-- Name: monitor_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitor_posts (
    id text NOT NULL,
    author text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    text text NOT NULL,
    url text NOT NULL,
    context jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw jsonb,
    translation text,
    recognition jsonb,
    receipt_id bigint,
    origin text DEFAULT 'live'::text NOT NULL,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    activity jsonb,
    outage jsonb,
    CONSTRAINT monitor_posts_origin_check CHECK ((origin = ANY (ARRAY['live'::text, 'imported'::text])))
);


--
-- Name: monitor_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitor_state (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notify_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notify_targets (
    key text NOT NULL,
    purpose text NOT NULL,
    kind text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    enabled_at timestamp with time zone,
    config_ref text,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notify_targets_kind_check CHECK ((kind = ANY (ARRAY['feishu_webhook'::text, 'feishu_chat'::text, 'log'::text]))),
    CONSTRAINT notify_targets_purpose_check CHECK ((purpose = ANY (ARRAY['content'::text, 'alert'::text, 'feedback'::text])))
);


--
-- Name: pool_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pool_search (
    article_id text NOT NULL,
    direct text NOT NULL,
    body text DEFAULT ''::text NOT NULL
);
ALTER TABLE ONLY public.pool_search ALTER COLUMN body SET COMPRESSION lz4;


--
-- Name: publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publications (
    article_id text NOT NULL,
    analysis_id bigint,
    revision integer DEFAULT 1 NOT NULL,
    visibility text DEFAULT 'public'::text NOT NULL,
    eligible boolean DEFAULT false NOT NULL,
    selected boolean DEFAULT false NOT NULL,
    title text NOT NULL,
    original_title text,
    summary text,
    reason text,
    category text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    score numeric(5,2),
    source_id text NOT NULL,
    channel text NOT NULL,
    first_party boolean DEFAULT false NOT NULL,
    url text NOT NULL,
    published_at timestamp with time zone,
    discovered_at timestamp with time zone NOT NULL,
    timeline_at timestamp with time zone NOT NULL,
    backfill boolean DEFAULT false NOT NULL,
    selected_ready_at timestamp with time zone,
    visible_after timestamp with time zone,
    body_mode text DEFAULT 'summary'::text NOT NULL,
    syndicate boolean DEFAULT false NOT NULL,
    indexable boolean DEFAULT false NOT NULL,
    story_id bigint,
    fact_id bigint,
    search_text text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sort_at timestamp with time zone NOT NULL,
    seo_indexed_at timestamp with time zone,
    seo_excluded_at timestamp with time zone,
    CONSTRAINT publications_body_mode_check CHECK ((body_mode = ANY (ARRAY['full'::text, 'summary'::text]))),
    CONSTRAINT publications_channel_check CHECK ((channel = ANY (ARRAY['news'::text, 'x'::text]))),
    CONSTRAINT publications_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'summary-only'::text, 'withdrawn'::text])))
);


--
-- Name: quote_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_translations (
    tweet_id text NOT NULL,
    text_hash text NOT NULL,
    text_zh text NOT NULL,
    origin text DEFAULT 'model'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT quote_translations_origin_check CHECK ((origin = ANY (ARRAY['model'::text, 'reused'::text])))
);


--
-- Name: receipt_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_attempts (
    id bigint NOT NULL,
    receipt_id bigint NOT NULL,
    attempt integer NOT NULL,
    service text NOT NULL,
    model text,
    origin text DEFAULT 'live'::text NOT NULL,
    status text NOT NULL,
    request_id text,
    usage jsonb,
    cost numeric(14,6),
    currency text,
    cost_basis text,
    latency_ms integer,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT receipt_attempts_cost_basis_check CHECK ((cost_basis = ANY (ARRAY['actual'::text, 'estimated'::text]))),
    CONSTRAINT receipt_attempts_origin_check CHECK ((origin = ANY (ARRAY['live'::text, 'replay'::text, 'imported'::text]))),
    CONSTRAINT receipt_attempts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'failed'::text, 'unknown'::text])))
);


--
-- Name: receipt_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receipt_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipt_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.receipt_attempts_id_seq OWNED BY public.receipt_attempts.id;


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipts (
    id bigint NOT NULL,
    logical_key text NOT NULL,
    service text NOT NULL,
    model text,
    purpose text NOT NULL,
    subject text,
    status text NOT NULL,
    request jsonb,
    response jsonb,
    request_id text,
    usage jsonb,
    cost numeric(14,6),
    currency text,
    cost_basis text,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    origin text DEFAULT 'live'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT receipts_cost_basis_check CHECK ((cost_basis = ANY (ARRAY['actual'::text, 'estimated'::text]))),
    CONSTRAINT receipts_origin_check CHECK ((origin = ANY (ARRAY['live'::text, 'replay'::text, 'imported'::text]))),
    CONSTRAINT receipts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'completed'::text, 'failed'::text, 'unknown'::text])))
);


--
-- Name: receipts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.receipts_id_seq OWNED BY public.receipts.id;


--
-- Name: regroup_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regroup_pending (
    article_id text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_revisions (
    report_id bigint NOT NULL,
    revision integer NOT NULL,
    content jsonb NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    reason text
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id bigint NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    content jsonb NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    model text,
    revision integer DEFAULT 1 NOT NULL,
    origin text DEFAULT 'model'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reports_kind_check CHECK ((kind = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text]))),
    CONSTRAINT reports_origin_check CHECK ((origin = ANY (ARRAY['model'::text, 'imported'::text, 'manual'::text])))
);


--
-- Name: reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reports_id_seq OWNED BY public.reports.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: selectbench_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selectbench_results (
    run_id text NOT NULL,
    model text NOT NULL,
    case_id text NOT NULL,
    title text NOT NULL,
    stratum text,
    gold text NOT NULL,
    decision text,
    score numeric(5,2),
    relevance text,
    category text,
    reason text,
    receipt_id bigint,
    error text
);


--
-- Name: selectbench_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selectbench_runs (
    id text NOT NULL,
    label text NOT NULL,
    split text,
    sample_size integer NOT NULL,
    seed integer,
    prompt_version text,
    models text[] NOT NULL,
    summary jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    imported_by text
);


--
-- Name: selected_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selected_ledger (
    seq bigint NOT NULL,
    article_id text NOT NULL,
    op text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    visible_at timestamp with time zone DEFAULT now() NOT NULL,
    payload jsonb,
    CONSTRAINT selected_ledger_op_check CHECK ((op = ANY (ARRAY['upsert'::text, 'remove'::text])))
);


--
-- Name: selected_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.selected_state (
    article_id text NOT NULL,
    in_set boolean NOT NULL,
    payload_hash text,
    last_seq bigint NOT NULL
);


--
-- Name: service_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_prices (
    service text NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    currency text NOT NULL,
    input_per_mtok numeric(14,6),
    cached_per_mtok numeric(14,6),
    output_per_mtok numeric(14,6),
    per_request numeric(14,6),
    source_url text,
    verified_on date,
    note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_prices_currency_check CHECK ((currency = ANY (ARRAY['CNY'::text, 'USD'::text])))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sources (
    id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    first_party boolean DEFAULT false NOT NULL,
    owner_entity_id text,
    tier text DEFAULT 'T2'::text NOT NULL,
    participation_mode text DEFAULT 'editorial'::text NOT NULL,
    signal_group_id text,
    interval_minutes integer DEFAULT 30 NOT NULL,
    site_fulltext boolean DEFAULT false NOT NULL,
    syndicate_fulltext boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    health text DEFAULT 'unknown'::text NOT NULL,
    fail_count integer DEFAULT 0 NOT NULL,
    last_fetch_at timestamp with time zone,
    last_ok_at timestamp with time zone,
    last_error text,
    cursor jsonb,
    next_fetch_at timestamp with time zone,
    icon_url text,
    imported_from text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    icon_checked_at timestamp with time zone,
    CONSTRAINT sources_health_check CHECK ((health = ANY (ARRAY['ok'::text, 'degraded'::text, 'failing'::text, 'paused'::text, 'unknown'::text]))),
    CONSTRAINT sources_interval_minutes_check CHECK (((interval_minutes >= 1) AND (interval_minutes <= 1440))),
    CONSTRAINT sources_kind_check CHECK ((kind = ANY (ARRAY['rss'::text, 'web_list'::text, 'json_list'::text, 'x_search'::text, 'mp_account'::text, 'external'::text]))),
    CONSTRAINT sources_participation_mode_check CHECK ((participation_mode = ANY (ARRAY['editorial'::text, 'hot_signal'::text, 'isolated'::text]))),
    CONSTRAINT sources_tier_check CHECK ((tier = ANY (ARRAY['T1'::text, 'T1_5'::text, 'T2'::text, 'EXCLUDE_MP'::text])))
);


--
-- Name: stored_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stored_files (
    key text NOT NULL,
    content_type text NOT NULL,
    bytes integer NOT NULL,
    purpose text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: stories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stories (
    id bigint NOT NULL,
    public_id uuid NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    action text,
    frame jsonb,
    first_report_at timestamp with time zone,
    latest_at timestamp with time zone,
    digest text,
    digest_updated_at timestamp with time zone,
    latest text,
    merged_into bigint,
    version integer DEFAULT 1 NOT NULL,
    origin text DEFAULT 'model'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    CONSTRAINT stories_origin_check CHECK ((origin = ANY (ARRAY['model'::text, 'replay'::text, 'manual'::text]))),
    CONSTRAINT stories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'watching'::text, 'settled'::text])))
);


--
-- Name: stories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stories_id_seq OWNED BY public.stories.id;


--
-- Name: story_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_aliases (
    public_id uuid NOT NULL,
    story_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: story_digests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_digests (
    story_id bigint NOT NULL,
    version integer NOT NULL,
    digest text NOT NULL,
    latest text,
    receipt_id bigint,
    article_ids text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    inputs_hash text
);


--
-- Name: story_heat_hourly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_heat_hourly (
    story_id bigint NOT NULL,
    hour timestamp with time zone NOT NULL,
    heat numeric(10,3) NOT NULL,
    participants integer NOT NULL,
    cohort integer DEFAULT 0 NOT NULL,
    complete boolean DEFAULT true NOT NULL
);


--
-- Name: story_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_links (
    story_id bigint NOT NULL,
    other_id bigint NOT NULL,
    relation text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT story_links_relation_check CHECK ((relation = ANY (ARRAY['storyline'::text, 'related'::text])))
);


--
-- Name: story_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.story_signals (
    story_id bigint NOT NULL,
    article_id text NOT NULL,
    participant_key text NOT NULL,
    source_id text NOT NULL,
    kind text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    CONSTRAINT story_signals_kind_check CHECK ((kind = ANY (ARRAY['editorial'::text, 'signal'::text])))
);


--
-- Name: topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.topics (
    slug text NOT NULL,
    name text NOT NULL,
    grp text NOT NULL,
    entity_id text,
    tags text[] NOT NULL,
    definition text NOT NULL,
    related text[] DEFAULT '{}'::text[] NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT topics_grp_check CHECK ((grp = ANY (ARRAY['company'::text, 'field'::text, 'genre'::text])))
);


--
-- Name: translation_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.translation_attempts (
    article_id text NOT NULL,
    revision integer NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    outcome text NOT NULL,
    reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT translation_attempts_outcome_check CHECK ((outcome = ANY (ARRAY['translated'::text, 'partial'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.translations (
    article_id text NOT NULL,
    lang text DEFAULT 'zh'::text NOT NULL,
    revision integer NOT NULL,
    title text,
    body_html text,
    body_text text,
    complete boolean DEFAULT true NOT NULL,
    origin text DEFAULT 'model'::text NOT NULL,
    receipt_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT translations_origin_check CHECK ((origin = ANY (ARRAY['model'::text, 'replay'::text, 'source'::text])))
);


--
-- Name: admin_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users ALTER COLUMN id SET DEFAULT nextval('public.admin_users_id_seq'::regclass);


--
-- Name: analyses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses ALTER COLUMN id SET DEFAULT nextval('public.analyses_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries ALTER COLUMN id SET DEFAULT nextval('public.deliveries_id_seq'::regclass);


--
-- Name: facts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts ALTER COLUMN id SET DEFAULT nextval('public.facts_id_seq'::regclass);


--
-- Name: feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback ALTER COLUMN id SET DEFAULT nextval('public.feedback_id_seq'::regclass);


--
-- Name: fetch_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fetch_runs ALTER COLUMN id SET DEFAULT nextval('public.fetch_runs_id_seq'::regclass);


--
-- Name: grouping_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grouping_decisions ALTER COLUMN id SET DEFAULT nextval('public.grouping_decisions_id_seq'::regclass);


--
-- Name: hot_rankings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hot_rankings ALTER COLUMN id SET DEFAULT nextval('public.hot_rankings_id_seq'::regclass);


--
-- Name: ingest_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events ALTER COLUMN id SET DEFAULT nextval('public.ingest_events_id_seq'::regclass);


--
-- Name: job_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs ALTER COLUMN id SET DEFAULT nextval('public.job_runs_id_seq'::regclass);


--
-- Name: lb_rankings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_rankings ALTER COLUMN id SET DEFAULT nextval('public.lb_rankings_id_seq'::regclass);


--
-- Name: receipt_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_attempts ALTER COLUMN id SET DEFAULT nextval('public.receipt_attempts_id_seq'::regclass);


--
-- Name: receipts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts ALTER COLUMN id SET DEFAULT nextval('public.receipts_id_seq'::regclass);


--
-- Name: reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports ALTER COLUMN id SET DEFAULT nextval('public.reports_id_seq'::regclass);


--
-- Name: stories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stories ALTER COLUMN id SET DEFAULT nextval('public.stories_id_seq'::regclass);


--
-- Name: admin_sessions admin_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_pkey PRIMARY KEY (id_hash);


--
-- Name: admin_users admin_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_email_key UNIQUE (email);


--
-- Name: admin_users admin_users_feishu_union_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_feishu_union_id_key UNIQUE (feishu_union_id);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: analyses analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_pkey PRIMARY KEY (id);


--
-- Name: article_discoveries article_discoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_discoveries
    ADD CONSTRAINT article_discoveries_pkey PRIMARY KEY (article_id, source_id, via);


--
-- Name: article_revisions article_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_revisions
    ADD CONSTRAINT article_revisions_pkey PRIMARY KEY (article_id, revision);


--
-- Name: articles articles_identity_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_identity_key_key UNIQUE (identity_key);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: budgets budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budgets
    ADD CONSTRAINT budgets_pkey PRIMARY KEY (service);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: deliveries deliveries_target_key_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_target_key_dedupe_key_key UNIQUE (target_key, dedupe_key);


--
-- Name: delivery_leases delivery_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_leases
    ADD CONSTRAINT delivery_leases_pkey PRIMARY KEY (lease_key);


--
-- Name: editorial_overrides editorial_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_overrides
    ADD CONSTRAINT editorial_overrides_pkey PRIMARY KEY (article_id);


--
-- Name: embeddings embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embeddings
    ADD CONSTRAINT embeddings_pkey PRIMARY KEY (kind, ref_id, model);


--
-- Name: fact_articles fact_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_articles
    ADD CONSTRAINT fact_articles_pkey PRIMARY KEY (fact_id, article_id);


--
-- Name: facts facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_pkey PRIMARY KEY (id);


--
-- Name: facts facts_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_public_id_key UNIQUE (public_id);


--
-- Name: feedback_bans feedback_bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_bans
    ADD CONSTRAINT feedback_bans_pkey PRIMARY KEY (source_hash);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: fetch_runs fetch_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fetch_runs
    ADD CONSTRAINT fetch_runs_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (as_of, pair);


--
-- Name: grouping_decisions grouping_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grouping_decisions
    ADD CONSTRAINT grouping_decisions_pkey PRIMARY KEY (id);


--
-- Name: grouping_overrides grouping_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grouping_overrides
    ADD CONSTRAINT grouping_overrides_pkey PRIMARY KEY (article_id);


--
-- Name: hot_rankings hot_rankings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hot_rankings
    ADD CONSTRAINT hot_rankings_pkey PRIMARY KEY (id);


--
-- Name: ingest_events ingest_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events
    ADD CONSTRAINT ingest_events_pkey PRIMARY KEY (id);


--
-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);


--
-- Name: lb_aliases lb_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_aliases
    ADD CONSTRAINT lb_aliases_pkey PRIMARY KEY (id);


--
-- Name: lb_models lb_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_models
    ADD CONSTRAINT lb_models_pkey PRIMARY KEY (id);


--
-- Name: lb_models lb_models_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_models
    ADD CONSTRAINT lb_models_slug_key UNIQUE (slug);


--
-- Name: lb_prices lb_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_prices
    ADD CONSTRAINT lb_prices_pkey PRIMARY KEY (model_id, kind);


--
-- Name: lb_rankings lb_rankings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_rankings
    ADD CONSTRAINT lb_rankings_pkey PRIMARY KEY (id);


--
-- Name: lb_rankings lb_rankings_run_id_board_model_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_rankings
    ADD CONSTRAINT lb_rankings_run_id_board_model_id_key UNIQUE (run_id, board, model_id);


--
-- Name: lb_runs lb_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_runs
    ADD CONSTRAINT lb_runs_pkey PRIMARY KEY (id);


--
-- Name: lb_scores lb_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_scores
    ADD CONSTRAINT lb_scores_pkey PRIMARY KEY (id);


--
-- Name: lb_snapshots lb_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_snapshots
    ADD CONSTRAINT lb_snapshots_pkey PRIMARY KEY (id);


--
-- Name: monitor_event_posts monitor_event_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_event_posts
    ADD CONSTRAINT monitor_event_posts_pkey PRIMARY KEY (event_id, post_id);


--
-- Name: monitor_events monitor_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_events
    ADD CONSTRAINT monitor_events_pkey PRIMARY KEY (id);


--
-- Name: monitor_posts monitor_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_posts
    ADD CONSTRAINT monitor_posts_pkey PRIMARY KEY (id);


--
-- Name: monitor_state monitor_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_state
    ADD CONSTRAINT monitor_state_pkey PRIMARY KEY (key);


--
-- Name: notify_targets notify_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notify_targets
    ADD CONSTRAINT notify_targets_pkey PRIMARY KEY (key);


--
-- Name: pool_search pool_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pool_search
    ADD CONSTRAINT pool_search_pkey PRIMARY KEY (article_id);


--
-- Name: publications publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_pkey PRIMARY KEY (article_id);


--
-- Name: quote_translations quote_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_translations
    ADD CONSTRAINT quote_translations_pkey PRIMARY KEY (tweet_id);


--
-- Name: receipt_attempts receipt_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_pkey PRIMARY KEY (id);


--
-- Name: receipt_attempts receipt_attempts_receipt_id_attempt_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_receipt_id_attempt_key UNIQUE (receipt_id, attempt);


--
-- Name: receipts receipts_logical_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_logical_key_key UNIQUE (logical_key);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: regroup_pending regroup_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regroup_pending
    ADD CONSTRAINT regroup_pending_pkey PRIMARY KEY (article_id);


--
-- Name: report_revisions report_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_revisions
    ADD CONSTRAINT report_revisions_pkey PRIMARY KEY (report_id, revision);


--
-- Name: reports reports_kind_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_kind_key_key UNIQUE (kind, key);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: selectbench_results selectbench_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selectbench_results
    ADD CONSTRAINT selectbench_results_pkey PRIMARY KEY (run_id, model, case_id);


--
-- Name: selectbench_runs selectbench_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selectbench_runs
    ADD CONSTRAINT selectbench_runs_pkey PRIMARY KEY (id);


--
-- Name: selected_ledger selected_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selected_ledger
    ADD CONSTRAINT selected_ledger_pkey PRIMARY KEY (seq);


--
-- Name: selected_state selected_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selected_state
    ADD CONSTRAINT selected_state_pkey PRIMARY KEY (article_id);


--
-- Name: service_prices service_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_prices
    ADD CONSTRAINT service_prices_pkey PRIMARY KEY (service, model);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);


--
-- Name: stored_files stored_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stored_files
    ADD CONSTRAINT stored_files_pkey PRIMARY KEY (key);


--
-- Name: stories stories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stories
    ADD CONSTRAINT stories_pkey PRIMARY KEY (id);


--
-- Name: stories stories_public_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stories
    ADD CONSTRAINT stories_public_id_key UNIQUE (public_id);


--
-- Name: story_aliases story_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_aliases
    ADD CONSTRAINT story_aliases_pkey PRIMARY KEY (public_id);


--
-- Name: story_digests story_digests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_digests
    ADD CONSTRAINT story_digests_pkey PRIMARY KEY (story_id, version);


--
-- Name: story_heat_hourly story_heat_hourly_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_heat_hourly
    ADD CONSTRAINT story_heat_hourly_pkey PRIMARY KEY (story_id, hour);


--
-- Name: story_links story_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_links
    ADD CONSTRAINT story_links_pkey PRIMARY KEY (story_id, other_id);


--
-- Name: story_signals story_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_signals
    ADD CONSTRAINT story_signals_pkey PRIMARY KEY (story_id, article_id);


--
-- Name: topics topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.topics
    ADD CONSTRAINT topics_pkey PRIMARY KEY (slug);


--
-- Name: translation_attempts translation_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_attempts
    ADD CONSTRAINT translation_attempts_pkey PRIMARY KEY (article_id);


--
-- Name: translations translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_pkey PRIMARY KEY (article_id, lang);


--
-- Name: analyses_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analyses_article_idx ON public.analyses USING btree (article_id, id DESC);


--
-- Name: articles_discovered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_discovered_idx ON public.articles USING btree (discovered_at DESC);


--
-- Name: articles_processing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_processing_idx ON public.articles USING btree (processing_state, processing_retry_at) WHERE (processing_state = ANY (ARRAY['new'::text, 'failed'::text]));


--
-- Name: articles_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_source_idx ON public.articles USING btree (source_id, discovered_at DESC);


--
-- Name: articles_url_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_url_idx ON public.articles USING btree (url);


--
-- Name: audit_log_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_subject_idx ON public.audit_log USING btree (subject, created_at DESC);


--
-- Name: deliveries_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_status_idx ON public.deliveries USING btree (status, created_at);


--
-- Name: fact_articles_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fact_articles_article_idx ON public.fact_articles USING btree (article_id);


--
-- Name: facts_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_created_idx ON public.facts USING btree (created_at DESC);


--
-- Name: facts_story_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX facts_story_idx ON public.facts USING btree (story_id);


--
-- Name: fetch_runs_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fetch_runs_source_idx ON public.fetch_runs USING btree (source_id, started_at DESC);


--
-- Name: grouping_decisions_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grouping_decisions_article_idx ON public.grouping_decisions USING btree (article_id, id DESC);


--
-- Name: hot_rankings_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hot_rankings_time_idx ON public.hot_rankings USING btree (computed_at DESC) WHERE published;


--
-- Name: ingest_events_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_events_client_idx ON public.ingest_events USING btree (client, created_at DESC);


--
-- Name: job_runs_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_runs_job_idx ON public.job_runs USING btree (job, started_at DESC);


--
-- Name: lb_aliases_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lb_aliases_lookup_idx ON public.lb_aliases USING btree (source_key, normalized_alias);


--
-- Name: lb_aliases_source_alias_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lb_aliases_source_alias_key ON public.lb_aliases USING btree (source_key, alias);


--
-- Name: lb_scores_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lb_scores_model_idx ON public.lb_scores USING btree (model_id);


--
-- Name: lb_scores_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lb_scores_snapshot_idx ON public.lb_scores USING btree (snapshot_id);


--
-- Name: lb_snapshots_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lb_snapshots_source_idx ON public.lb_snapshots USING btree (source_key, fetched_at DESC);


--
-- Name: monitor_event_posts_post_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitor_event_posts_post_idx ON public.monitor_event_posts USING btree (post_id);


--
-- Name: monitor_posts_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitor_posts_time_idx ON public.monitor_posts USING btree (published_at DESC);


--
-- Name: pool_search_body_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pool_search_body_trgm_idx ON public.pool_search USING gin (body public.gin_trgm_ops);


--
-- Name: pool_search_direct_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pool_search_direct_trgm_idx ON public.pool_search USING gin (direct public.gin_trgm_ops);


--
-- Name: publications_eligible_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_eligible_updated_idx ON public.publications USING btree (updated_at) WHERE eligible;


--
-- Name: publications_fact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_fact_idx ON public.publications USING btree (fact_id) WHERE (fact_id IS NOT NULL);


--
-- Name: publications_indexable_timeline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_indexable_timeline_idx ON public.publications USING btree (timeline_at DESC) WHERE ((visibility = 'public'::text) AND indexable);


--
-- Name: publications_pool_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_pool_published_idx ON public.publications USING btree (COALESCE(published_at, discovered_at) DESC, article_id) WHERE ((visibility = 'public'::text) AND eligible);


--
-- Name: publications_pool_timeline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_pool_timeline_idx ON public.publications USING btree (timeline_at DESC, article_id) WHERE ((visibility = 'public'::text) AND eligible);


--
-- Name: publications_search_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_search_trgm_idx ON public.publications USING gin (search_text public.gin_trgm_ops);


--
-- Name: publications_selected_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_selected_ready_idx ON public.publications USING btree (selected_ready_at) WHERE (selected_ready_at IS NOT NULL);


--
-- Name: publications_selected_release_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_selected_release_idx ON public.publications USING btree (visible_after) WHERE (selected AND (visibility = 'public'::text));


--
-- Name: publications_selected_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_selected_sort_idx ON public.publications USING btree (sort_at DESC, article_id) WHERE ((visibility = 'public'::text) AND selected);


--
-- Name: publications_selected_timeline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_selected_timeline_idx ON public.publications USING btree (timeline_at DESC, article_id) WHERE ((visibility = 'public'::text) AND selected);


--
-- Name: publications_story_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_story_idx ON public.publications USING btree (story_id) WHERE (story_id IS NOT NULL);


--
-- Name: publications_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX publications_tags_idx ON public.publications USING gin (tags);


--
-- Name: receipt_attempts_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipt_attempts_pending_idx ON public.receipt_attempts USING btree (started_at) WHERE (status = 'pending'::text);


--
-- Name: receipt_attempts_service_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipt_attempts_service_time_idx ON public.receipt_attempts USING btree (service, origin, started_at);


--
-- Name: receipts_service_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipts_service_time_idx ON public.receipts USING btree (service, created_at);


--
-- Name: receipts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipts_status_idx ON public.receipts USING btree (status) WHERE (status = ANY (ARRAY['pending'::text, 'unknown'::text]));


--
-- Name: receipts_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX receipts_subject_idx ON public.receipts USING btree (subject);


--
-- Name: selected_ledger_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selected_ledger_article_idx ON public.selected_ledger USING btree (article_id, seq DESC);


--
-- Name: selected_ledger_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX selected_ledger_visible_idx ON public.selected_ledger USING btree (visible_at);


--
-- Name: sources_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sources_due_idx ON public.sources USING btree (next_fetch_at) WHERE enabled;


--
-- Name: stories_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stories_latest_idx ON public.stories USING btree (latest_at DESC) WHERE (merged_into IS NULL);


--
-- Name: story_signals_story_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX story_signals_story_idx ON public.story_signals USING btree (story_id, observed_at DESC);


--
-- Name: story_signals_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX story_signals_time_idx ON public.story_signals USING btree (observed_at DESC);


--
-- Name: admin_sessions admin_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_sessions
    ADD CONSTRAINT admin_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: analyses analyses_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_discoveries article_discoveries_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_discoveries
    ADD CONSTRAINT article_discoveries_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_revisions article_revisions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_revisions
    ADD CONSTRAINT article_revisions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: articles articles_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: deliveries deliveries_target_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_target_key_fkey FOREIGN KEY (target_key) REFERENCES public.notify_targets(key);


--
-- Name: editorial_overrides editorial_overrides_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.editorial_overrides
    ADD CONSTRAINT editorial_overrides_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: fact_articles fact_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_articles
    ADD CONSTRAINT fact_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: fact_articles fact_articles_fact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fact_articles
    ADD CONSTRAINT fact_articles_fact_id_fkey FOREIGN KEY (fact_id) REFERENCES public.facts(id) ON DELETE CASCADE;


--
-- Name: facts facts_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facts
    ADD CONSTRAINT facts_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id);


--
-- Name: fetch_runs fetch_runs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fetch_runs
    ADD CONSTRAINT fetch_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: grouping_decisions grouping_decisions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grouping_decisions
    ADD CONSTRAINT grouping_decisions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: grouping_overrides grouping_overrides_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grouping_overrides
    ADD CONSTRAINT grouping_overrides_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: lb_aliases lb_aliases_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_aliases
    ADD CONSTRAINT lb_aliases_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.lb_models(id);


--
-- Name: lb_prices lb_prices_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_prices
    ADD CONSTRAINT lb_prices_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.lb_models(id);


--
-- Name: lb_rankings lb_rankings_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_rankings
    ADD CONSTRAINT lb_rankings_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.lb_models(id);


--
-- Name: lb_rankings lb_rankings_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_rankings
    ADD CONSTRAINT lb_rankings_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.lb_runs(id) ON DELETE CASCADE;


--
-- Name: lb_scores lb_scores_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_scores
    ADD CONSTRAINT lb_scores_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.lb_models(id);


--
-- Name: lb_scores lb_scores_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lb_scores
    ADD CONSTRAINT lb_scores_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.lb_snapshots(id) ON DELETE CASCADE;


--
-- Name: monitor_event_posts monitor_event_posts_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_event_posts
    ADD CONSTRAINT monitor_event_posts_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.monitor_events(id) ON DELETE CASCADE;


--
-- Name: monitor_event_posts monitor_event_posts_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitor_event_posts
    ADD CONSTRAINT monitor_event_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.monitor_posts(id) ON DELETE CASCADE;


--
-- Name: pool_search pool_search_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pool_search
    ADD CONSTRAINT pool_search_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: publications publications_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publications
    ADD CONSTRAINT publications_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: receipt_attempts receipt_attempts_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON DELETE CASCADE;


--
-- Name: regroup_pending regroup_pending_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regroup_pending
    ADD CONSTRAINT regroup_pending_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: report_revisions report_revisions_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_revisions
    ADD CONSTRAINT report_revisions_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.reports(id) ON DELETE CASCADE;


--
-- Name: selectbench_results selectbench_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.selectbench_results
    ADD CONSTRAINT selectbench_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.selectbench_runs(id) ON DELETE CASCADE;


--
-- Name: stories stories_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stories
    ADD CONSTRAINT stories_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.stories(id);


--
-- Name: story_aliases story_aliases_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_aliases
    ADD CONSTRAINT story_aliases_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id);


--
-- Name: story_digests story_digests_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_digests
    ADD CONSTRAINT story_digests_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: story_heat_hourly story_heat_hourly_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_heat_hourly
    ADD CONSTRAINT story_heat_hourly_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: story_links story_links_other_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_links
    ADD CONSTRAINT story_links_other_id_fkey FOREIGN KEY (other_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: story_links story_links_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_links
    ADD CONSTRAINT story_links_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: story_signals story_signals_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_signals
    ADD CONSTRAINT story_signals_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: story_signals story_signals_story_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.story_signals
    ADD CONSTRAINT story_signals_story_id_fkey FOREIGN KEY (story_id) REFERENCES public.stories(id) ON DELETE CASCADE;


--
-- Name: translation_attempts translation_attempts_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_attempts
    ADD CONSTRAINT translation_attempts_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: translations translations_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translations
    ADD CONSTRAINT translations_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


