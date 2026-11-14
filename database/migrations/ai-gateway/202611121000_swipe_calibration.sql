-- Swipe calibration desk (TASK-0621): one deck per Beijing day. A card keeps a copy of what the reader would see and
-- of what the system had decided when it was dealt; answers are append-only (taking one back is a new revision).
-- Nothing here publishes, withdraws or changes a selection rule.
CREATE TABLE ai.swipe_cards (
  day date NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  article_id text NOT NULL,
  analysis_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('near_miss', 'near_pass', 'split', 'blocked', 'recheck')),
  system text NOT NULL CHECK (system IN ('selected', 'kept', 'blocked')),
  score numeric(5, 2),
  threshold numeric(5, 2),
  title text NOT NULL,
  preview text NOT NULL,
  source_name text NOT NULL,
  category text,
  discovered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  PRIMARY KEY (day, position),
  UNIQUE (day, article_id)
);

CREATE INDEX swipe_cards_article_idx ON ai.swipe_cards (article_id);

CREATE TABLE ai.swipe_answers (
  day date NOT NULL,
  article_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  answer text CHECK (answer IN ('no', 'yes', 'star')),
  reasons text[] NOT NULL DEFAULT '{}',
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, article_id, revision),
  FOREIGN KEY (day, article_id) REFERENCES ai.swipe_cards (day, article_id)
);
