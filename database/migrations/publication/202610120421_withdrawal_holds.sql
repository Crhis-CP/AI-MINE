CREATE TABLE publication.withdrawal_targets (
  withdrawal_id bigint PRIMARY KEY,
  lane text NOT NULL CHECK(lane IN ('news','policy')),
  target_type text NOT NULL CHECK(target_type IN ('event','story','report')),
  target_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK(target_type='report' OR lane='news')
);
CREATE INDEX active_withdrawal_targets ON publication.withdrawal_targets(lane,target_type,target_key) WHERE active;
CREATE TABLE publication.withdrawal_members (
  withdrawal_id bigint NOT NULL REFERENCES publication.withdrawal_targets(withdrawal_id),
  article_id text NOT NULL,
  PRIMARY KEY(withdrawal_id,article_id)
);
CREATE INDEX withdrawn_member_lookup ON publication.withdrawal_members(article_id,withdrawal_id);
