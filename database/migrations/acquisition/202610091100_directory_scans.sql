CREATE TABLE acquisition.directory_scans (
  id text PRIMARY KEY, source_id text NOT NULL, contract_hash text NOT NULL, permission_version bigint NOT NULL,
  contract jsonb NOT NULL, state text NOT NULL DEFAULT 'running', next_page integer NOT NULL,
  total_pages integer, total_records integer, record_count integer NOT NULL DEFAULT 0, document_count integer,
  first_fingerprint text, started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,retry_at timestamptz,reason text,
  CHECK(state IN ('running','complete','failed','obsolete'))
);
CREATE INDEX directory_source_state ON acquisition.directory_scans(source_id,state,started_at DESC);
CREATE TABLE acquisition.directory_pages (
  scan_id text NOT NULL REFERENCES acquisition.directory_scans(id), page_number integer NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('data','probe','failure')),fetched_at timestamptz NOT NULL,
  url text NOT NULL, body_hash text, body bytea, fingerprint text, evidence jsonb NOT NULL,
  PRIMARY KEY(scan_id,page_number,purpose)
);
CREATE TABLE acquisition.directory_seen (
  source_id text NOT NULL, id_namespace text NOT NULL,record_id text NOT NULL,
  first_seen_at timestamptz NOT NULL, page_scan_id text NOT NULL REFERENCES acquisition.directory_scans(id),
  PRIMARY KEY(source_id,id_namespace,record_id)
);
CREATE TABLE acquisition.directory_records (
  scan_id text NOT NULL REFERENCES acquisition.directory_scans(id), record_id text NOT NULL,page_number integer NOT NULL,
  identity_key text NOT NULL, document_id text, role text NOT NULL CHECK(role IN ('current','history')),
  url text NOT NULL, metadata_hash text NOT NULL, first_seen_at timestamptz NOT NULL, metadata jsonb NOT NULL,
  PRIMARY KEY(scan_id,record_id)
);
CREATE TABLE acquisition.directory_heads (
  source_id text PRIMARY KEY, scan_id text NOT NULL REFERENCES acquisition.directory_scans(id),applied_at timestamptz NOT NULL
);
CREATE TABLE acquisition.directory_bindings (
  scan_id text NOT NULL,record_id text NOT NULL,material_id text NOT NULL,material_revision integer NOT NULL,wake_hash text NOT NULL,
  PRIMARY KEY(scan_id,record_id), FOREIGN KEY(scan_id,record_id) REFERENCES acquisition.directory_records(scan_id,record_id),
  FOREIGN KEY(material_id,material_revision) REFERENCES public.article_revisions(article_id,revision)
);
CREATE TABLE acquisition.directory_receipts (
  id text PRIMARY KEY,scan_id text NOT NULL REFERENCES acquisition.directory_scans(id),source_id text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('complete','incomplete')),recorded_at timestamptz NOT NULL,
  proof_hash text NOT NULL,evidence jsonb NOT NULL
);
