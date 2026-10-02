-- ---------------------------------------------------------------------------
-- Notifications (F21)
-- ---------------------------------------------------------------------------

CREATE TABLE notify_targets (
  key          text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('content', 'alert', 'feedback')),
  kind         text NOT NULL CHECK (kind IN ('feishu_webhook', 'feishu_chat', 'log')),
  enabled      boolean NOT NULL DEFAULT false,
  -- Content published before a slot was enabled is never back-filled into it.
  enabled_at   timestamptz,
  config_ref   text,
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id             bigserial PRIMARY KEY,
  target_key     text NOT NULL REFERENCES notify_targets (key),
  subject_kind   text NOT NULL,
  subject_id     text NOT NULL,
  dedupe_key     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'skipped')),
  attempts       integer NOT NULL DEFAULT 0,
  payload        jsonb,
  response       text,
  origin         text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'imported')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_key, dedupe_key)
);

CREATE INDEX deliveries_status_idx ON deliveries (status, created_at);

-- Short leases keep concurrent same-title cards out before the formal identity is known.
CREATE TABLE delivery_leases (
  lease_key   text PRIMARY KEY,
  holder      text NOT NULL,
  expires_at  timestamptz NOT NULL
);
