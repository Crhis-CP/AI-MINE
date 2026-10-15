-- Reader selection uses a derived priority; private source configuration remains inaccessible.
ALTER TABLE publications ADD COLUMN representative_priority smallint NOT NULL DEFAULT 3 CHECK(representative_priority BETWEEN 0 AND 3);
