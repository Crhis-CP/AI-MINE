-- A proof for an older material revision must not survive a body update with the same date version.
ALTER TABLE publications ADD COLUMN source_time_material_revision integer CHECK(source_time_material_revision>0);
