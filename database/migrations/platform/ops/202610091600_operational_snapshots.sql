CREATE TABLE ops.operational_snapshots (
  dataset text PRIMARY KEY,
  sampled_at timestamptz,
  payload jsonb,
  last_error_at timestamptz,
  CHECK((sampled_at IS NULL) = (payload IS NULL))
);
