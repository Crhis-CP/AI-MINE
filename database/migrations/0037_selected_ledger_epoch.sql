-- Initialize before a public reader first asks for a synchronization watermark.
-- Keep existing epochs stable, including when this statement is replayed.
INSERT INTO settings (key, value)
VALUES (
  'selected_ledger_epoch',
  jsonb_build_object('epoch', translate(substr(encode(uuid_send(gen_random_uuid()), 'base64'), 1, 8), '+/', '-_'))
)
ON CONFLICT (key) DO NOTHING;
