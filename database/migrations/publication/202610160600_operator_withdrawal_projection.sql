-- Public qualification can distinguish an explicit operator hold from an automatically absent signal page.
ALTER TABLE publications ADD COLUMN operator_withdrawn boolean NOT NULL DEFAULT false;
