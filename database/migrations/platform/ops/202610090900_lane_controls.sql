CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE ops.lane_controls (
  lane text NOT NULL CHECK(lane IN ('news','policy','all')),
  switch text NOT NULL CHECK(switch IN ('collection','processing','publication')),
  holder text NOT NULL CHECK(holder IN ('owner','deploy','system')),
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), paused boolean NOT NULL DEFAULT false,
  reason text, actor text, expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(lane,switch,holder),
  CHECK(NOT paused OR (reason IS NOT NULL AND actor IS NOT NULL AND expires_at IS NOT NULL))
);
INSERT INTO ops.lane_controls(lane,switch,holder)
 SELECT l.lane,s.switch,h.holder FROM (VALUES('news'),('policy'),('all')) AS l(lane)
 CROSS JOIN (VALUES('collection'),('processing'),('publication')) AS s(switch)
 CROSS JOIN (VALUES('owner'),('deploy'),('system')) AS h(holder);
CREATE TABLE ops.lane_control_conflicts (
  id text PRIMARY KEY, lane text NOT NULL, switch text NOT NULL, holder text NOT NULL,
  expected_revision integer NOT NULL, actual_revision integer NOT NULL, actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
