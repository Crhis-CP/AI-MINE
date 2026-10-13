CREATE TABLE editorial.withdrawal_records (
  id bigserial PRIMARY KEY,
  lane text NOT NULL CHECK(lane IN ('news','policy')),
  target_type text NOT NULL CHECK(target_type IN ('event','story','report')),
  target_key text NOT NULL,
  target jsonb NOT NULL,
  member_ids text[] NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(target_type='report' OR lane='news')
);
CREATE INDEX withdrawal_target ON editorial.withdrawal_records(lane,target_type,target_key);
CREATE TABLE editorial.withdrawal_restorations (
  withdrawal_id bigint PRIMARY KEY REFERENCES editorial.withdrawal_records(id),
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
