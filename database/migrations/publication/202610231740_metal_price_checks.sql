CREATE TABLE publication.metal_price_checks (
  source text PRIMARY KEY CHECK (source ~ '^[a-z][a-z0-9_-]*$'),
  checked_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  changed boolean NOT NULL
);
