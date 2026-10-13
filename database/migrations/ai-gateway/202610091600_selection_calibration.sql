CREATE TABLE ai.selection_tool_control(id boolean PRIMARY KEY DEFAULT true CHECK(id),expires_at timestamptz,revision integer NOT NULL DEFAULT 0);
INSERT INTO ai.selection_tool_control(id) VALUES(true);
CREATE TABLE ai.selection_datasets(id text PRIMARY KEY,label text NOT NULL,synthetic boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ai.selection_samples(
 dataset_id text NOT NULL REFERENCES ai.selection_datasets(id),case_id text NOT NULL,sample_revision integer NOT NULL,
 material_id text,material_revision integer,source_date_version bigint,input text NOT NULL,input_hash text NOT NULL,
 split text NOT NULL CHECK(split IN('development','holdout')),stratum text,hidden_input jsonb NOT NULL,
 PRIMARY KEY(dataset_id,case_id)
);
CREATE TABLE ai.selection_labels(
 dataset_id text NOT NULL,case_id text NOT NULL,revision integer NOT NULL,decision text NOT NULL CHECK(decision IN('select','reject','either')),
 note text NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(dataset_id,case_id,revision),FOREIGN KEY(dataset_id,case_id) REFERENCES ai.selection_samples(dataset_id,case_id)
);
CREATE TABLE ai.selection_submissions(id text PRIMARY KEY,standard_version text NOT NULL,content_hash text NOT NULL,prefilter_version text NOT NULL,
 threshold_version text NOT NULL,submitted_at timestamptz NOT NULL DEFAULT now(),material_reference text NOT NULL,change_note text NOT NULL,synthetic boolean NOT NULL);
CREATE TABLE ai.selection_run_evidence(run_id text PRIMARY KEY REFERENCES public.selectbench_runs(id),metadata jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ai.selection_records(id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN('standard_review','holdout','calibration')),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ai.selection_commands(actor text NOT NULL,request_id uuid NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(actor,request_id));
