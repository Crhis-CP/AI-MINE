-- Legacy timestamps and selections are not proof of current identity/value confirmation.
ALTER TABLE articles ADD COLUMN grouping_status text NOT NULL DEFAULT 'pending'
  CHECK (grouping_status IN ('pending','complete','failed'));
ALTER TABLE articles ADD COLUMN grouping_input_revision integer;
ALTER TABLE articles ADD COLUMN grouping_receipt_id bigint REFERENCES receipts(id) ON DELETE SET NULL;
ALTER TABLE articles ADD COLUMN grouping_error text;
ALTER TABLE articles ADD COLUMN selection_adds_value boolean;
ALTER TABLE articles ADD COLUMN selection_value_reason text;
CREATE INDEX articles_grouping_pending_idx ON articles(created_at)
  WHERE grouping_status='pending' AND processing_state='analyzed';
CREATE INDEX articles_grouping_receipt_idx ON articles(grouping_receipt_id)
  WHERE grouping_receipt_id IS NOT NULL;

