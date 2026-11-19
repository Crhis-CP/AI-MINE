-- Package 2 entity library (plan step 2.2): one Chinese name per company. The database, not code, holds the companies,
-- their spellings and the links the deterministic linker finds in each article. Nothing in the paid prompt reads these
-- tables, so no receipt changes. Relations between entities (owner of a mine) are left out until a defect needs them.
CREATE SCHEMA IF NOT EXISTS entities;

-- The 24 taxonomy ids are reused as ids, so analyses.subjects joins without a mapping table. A merge only points the
-- loser at the winner; statements and links are not rewritten, so an undo restores the exact earlier state.
CREATE TABLE entities.entities (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'organization', 'asset')),
  -- NULL means no established Chinese name: readers see the original, never an invented translation (rule 15).
  name_zh text CHECK (name_zh IS NULL OR length(trim(name_zh)) > 0),
  name_original text NOT NULL CHECK (length(trim(name_original)) > 0),
  -- false for Chinese companies, whose name needs no bracketed original.
  show_original boolean NOT NULL DEFAULT true,
  origin text NOT NULL CHECK (origin IN ('taxonomy', 'glossary', 'seed', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  merged_into text REFERENCES entities.entities (id) CHECK (merged_into IS NULL OR merged_into <> id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);

-- One row per fact about an entity: a spelling, a ticker, a publisher domain, a source owner id, a headquarters.
-- norm is computed in code (aliasKey), so lookups never depend on database collation.
CREATE TABLE entities.statements (
  id bigserial PRIMARY KEY,
  entity_id text NOT NULL REFERENCES entities.entities (id),
  property text NOT NULL CHECK (property IN ('alias', 'ticker', 'domain', 'source_owner', 'headquarters')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 200),
  norm text NOT NULL CHECK (length(norm) BETWEEN 1 AND 200),
  -- text links on its own; anchored only beside other evidence for the same entity; lookup never matches running text.
  scope text CHECK (scope IN ('text', 'anchored', 'lookup')),
  lang text,
  note text,
  case_sensitive boolean NOT NULL DEFAULT false,
  origin text NOT NULL CHECK (origin IN ('taxonomy', 'glossary', 'seed', 'admin', 'history')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  UNIQUE (entity_id, property, norm),
  -- Only spellings that can occur in running text carry a matching scope; a domain or an owner id never does.
  CHECK ((scope IS NOT NULL) = (property IN ('alias', 'ticker')))
);
CREATE INDEX statements_lookup_idx ON entities.statements (property, norm);

CREATE TABLE entities.merges (
  id bigserial PRIMARY KEY,
  loser_id text NOT NULL REFERENCES entities.entities (id),
  winner_id text NOT NULL REFERENCES entities.entities (id),
  -- Entities that pointed at the loser and were moved to the winner; an undo moves exactly these back.
  repointed text[] NOT NULL DEFAULT '{}',
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by text,
  CHECK (loser_id <> winner_id),
  CHECK ((undone_at IS NULL) = (undone_by IS NULL))
);

-- What the linker found in one revision of one article. entity_id is kept as linked and never rewritten by a merge;
-- readers of links resolve merges through entities.merged_into. No foreign key to public tables, as for the
-- enrichment tables: the article and its analysis belong to other modules.
CREATE TABLE entities.article_links (
  article_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  entity_id text NOT NULL REFERENCES entities.entities (id),
  lane text NOT NULL CHECK (lane IN ('news', 'policy')),
  role text NOT NULL CHECK (role IN ('subject', 'mention', 'publisher')),
  method text NOT NULL CHECK (method IN ('text', 'model_subject', 'publisher_domain', 'source_owner', 'manual')),
  alias text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('title', 'body', 'source', 'model')),
  position integer,
  hits integer NOT NULL DEFAULT 1 CHECK (hits > 0),
  linker_version text NOT NULL,
  analysis_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_revision, entity_id, method)
);
CREATE INDEX article_links_entity_idx ON entities.article_links (entity_id, article_id);
