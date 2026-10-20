CREATE TABLE publication.report_revision_changes (
  article_id text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1,
  pending boolean NOT NULL DEFAULT true,
  time_hints jsonb NOT NULL,
  priority_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_revision_changes_due ON publication.report_revision_changes(priority_at DESC,updated_at,article_id) WHERE pending;

-- The source change and its notification commit together. No queue or remote work runs in this trigger.
CREATE FUNCTION publication.record_report_revision_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, publication AS $$
DECLARE item text; hints jsonb; priority timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND
    (NEW.visibility,NEW.operator_withdrawn,NEW.eligible,NEW.selected,NEW.selection_candidate,NEW.title,NEW.summary,
        NEW.category,NEW.score,NEW.fact_id,NEW.story_id,NEW.published_at,NEW.source_time,NEW.source_date_version,
        NEW.source_time_material_revision,NEW.source_date_config_hash,NEW.visible_after,
        NEW.source_id,NEW.url,NEW.first_party,NEW.representative_priority,NEW.search_text)
    IS NOT DISTINCT FROM
    (OLD.visibility,OLD.operator_withdrawn,OLD.eligible,OLD.selected,OLD.selection_candidate,OLD.title,OLD.summary,
        OLD.category,OLD.score,OLD.fact_id,OLD.story_id,OLD.published_at,OLD.source_time,OLD.source_date_version,
        OLD.source_time_material_revision,OLD.source_date_config_hash,OLD.visible_after,
        OLD.source_id,OLD.url,OLD.first_party,OLD.representative_priority,OLD.search_text)
  THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN
    item:=NEW.article_id;
    priority:=NEW.timeline_at;
    hints:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('sourceTime',NEW.source_time,
      'legacyAt',greatest(NEW.timeline_at,NEW.visible_after)));
  ELSE
    IF TG_OP='DELETE' THEN
    item:=OLD.article_id;
    priority:=OLD.timeline_at;
    hints:=pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('sourceTime',OLD.source_time,
      'legacyAt',greatest(OLD.timeline_at,OLD.visible_after)));
  ELSE
    item:=NEW.article_id;
    priority:=greatest(OLD.timeline_at,NEW.timeline_at);
    hints:=pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('sourceTime',OLD.source_time,'legacyAt',greatest(OLD.timeline_at,OLD.visible_after)),
      pg_catalog.jsonb_build_object('sourceTime',NEW.source_time,'legacyAt',greatest(NEW.timeline_at,NEW.visible_after)));
    END IF;
  END IF;
  INSERT INTO publication.report_revision_changes(article_id,time_hints,priority_at) VALUES(item,hints,priority)
  ON CONFLICT(article_id) DO UPDATE SET generation=publication.report_revision_changes.generation+1,
    pending=true,priority_at=EXCLUDED.priority_at,
    time_hints=CASE WHEN publication.report_revision_changes.time_hints @> EXCLUDED.time_hints
      THEN publication.report_revision_changes.time_hints ELSE publication.report_revision_changes.time_hints || EXCLUDED.time_hints END,
    updated_at=now();
  RETURN NULL;
END;
$$;
CREATE TRIGGER report_revision_change AFTER INSERT OR UPDATE OR DELETE ON public.publications
  FOR EACH ROW EXECUTE FUNCTION publication.record_report_revision_change();

-- One resumable initial reconciliation. Subsequent deployments do not reseed this journal.
INSERT INTO publication.report_revision_changes(article_id,time_hints,priority_at)
SELECT article_id,pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('sourceTime',source_time,'legacyAt',greatest(timeline_at,visible_after))),timeline_at
FROM public.publications WHERE selected OR selection_candidate;
