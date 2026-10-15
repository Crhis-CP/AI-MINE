-- A nomination is not a public selection. Historical release evidence is filled lazily from the
-- existing public projection/ledger; missing evidence never defaults to a past confirmation.
ALTER TABLE publications ADD COLUMN first_selected_at timestamptz;
