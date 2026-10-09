CREATE TABLE identity.password_accounts (
 user_id bigint PRIMARY KEY REFERENCES public.admin_users(id),
 login_name text NOT NULL UNIQUE CHECK(length(login_name) BETWEEN 3 AND 254 AND login_name=lower(login_name) AND login_name~'^[a-z0-9._+@-]+$'),
 password_hash text NOT NULL CHECK(length(password_hash)<=512),
 credential_revision integer NOT NULL DEFAULT 1 CHECK(credential_revision>0),
 one_use boolean NOT NULL DEFAULT false, temporary_expires_at timestamptz, temporary_used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.account_policy (
 id integer PRIMARY KEY CHECK(id=1), max_accounts integer NOT NULL CHECK(max_accounts BETWEEN 1 AND 10000)
);
INSERT INTO identity.account_policy(id,max_accounts) VALUES(1,100);
CREATE TABLE identity.auth_attempts (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('login','nonce','password_change')),
 account_hash text NOT NULL, source_hash text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_account ON identity.auth_attempts(kind,account_hash,at);
CREATE INDEX auth_attempts_source ON identity.auth_attempts(kind,source_hash,at);
CREATE INDEX auth_attempts_time ON identity.auth_attempts(at);
CREATE TABLE identity.login_nonces (
 token_hash text PRIMARY KEY, source_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE INDEX login_nonces_expiry ON identity.login_nonces(expires_at);
ALTER TABLE public.admin_sessions ADD COLUMN last_seen_at timestamptz;
-- Auth-only command receipts contain a slow salted digest, never passwords or recovery tokens.
CREATE TABLE identity.account_commands (
 user_id bigint NOT NULL REFERENCES public.admin_users(id), command_key text NOT NULL,
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,command_key), CHECK(length(command_key) BETWEEN 8 AND 200)
);
