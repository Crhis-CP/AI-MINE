CREATE TABLE policy.quality_releases (
  id text PRIMARY KEY, source_ids text[] NOT NULL, languages text[] NOT NULL,
  fulltext_recipe text NOT NULL, interpretation_recipe text NOT NULL, models text[] NOT NULL,
  reviewed_by text NOT NULL CHECK(reviewed_by='owner'), review_evidence text NOT NULL CHECK(length(review_evidence)>0),
  evaluation_hash text NOT NULL CHECK(evaluation_hash ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz NOT NULL, valid_until timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
  CHECK(valid_until>reviewed_at)
);
