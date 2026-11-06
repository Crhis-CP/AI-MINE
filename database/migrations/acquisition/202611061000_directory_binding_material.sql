-- Public policy reads ask, for every document on a list, whether its material is still bound in the current catalogue
-- (the source's head scan). Bindings were keyed only by catalogue record, and superseded scans are kept, so each check
-- scanned the whole table or every record of the head scan. This answers it from the scan and material directly.
CREATE INDEX directory_bindings_scan_material ON acquisition.directory_bindings(scan_id,material_id);
