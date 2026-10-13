CREATE TABLE publication.site_information (
 id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL CHECK(revision>0),
 value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication.site_information_commands (
 actor text NOT NULL, request_key text NOT NULL, input_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor,request_key)
);
