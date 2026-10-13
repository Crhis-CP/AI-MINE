CREATE SCHEMA IF NOT EXISTS identity;
-- No credentials or contact fields enter the read-only capability projection.
CREATE TABLE identity.account_access (
  user_id bigint PRIMARY KEY REFERENCES public.admin_users(id),
  role text NOT NULL CHECK(role IN ('owner','admin')),
  models_manage boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  must_change_password boolean NOT NULL DEFAULT false,
  CHECK(role<>'owner' OR active)
);
CREATE UNIQUE INDEX one_account_owner ON identity.account_access(role) WHERE role='owner';
