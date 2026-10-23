CREATE SCHEMA IF NOT EXISTS events;

CREATE TABLE events.story_background_proofs (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  story_public_id uuid NOT NULL,
  query_id text NOT NULL,
  candidate_id text NOT NULL,
  proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (query_id <> candidate_id)
);
CREATE UNIQUE INDEX story_background_active_pair ON events.story_background_proofs(story_public_id,query_id,candidate_id) WHERE active;
CREATE INDEX story_background_query ON events.story_background_proofs(query_id) WHERE active;
CREATE INDEX story_background_candidate ON events.story_background_proofs(candidate_id) WHERE active;
