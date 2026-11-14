-- The policy line's instrument gate (TASK-0576, Owner 2026-11-07): a document the program does not recognise as a final,
-- mining-related legal instrument is hidden through the existing automatic_excluded flag, and this column says it was
-- the gate (kind, final, mining, reason, recipe). It keeps the hold reversible: a later pass that recognises the
-- instrument, or the regate command's --restore, clears exactly the holds the gate set, never a model exclusion or a
-- manual withdrawal. Private: readers keep reading automatic_excluded only.
ALTER TABLE publication.policy_documents ADD COLUMN instrument_gate_hold jsonb;
