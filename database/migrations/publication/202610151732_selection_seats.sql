-- A score nominates a report. Public seats are established by the confirmed projection.
ALTER TABLE publications ADD COLUMN selection_candidate boolean NOT NULL DEFAULT false;
ALTER TABLE publications ADD COLUMN seat boolean NOT NULL DEFAULT false;
CREATE INDEX publications_selection_waiting_idx ON publications(selected_ready_at,article_id)
  WHERE selection_candidate AND NOT selected AND visibility='public';
