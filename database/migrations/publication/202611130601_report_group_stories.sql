-- The story a report group belongs to (TASK-0575): computed by events from grouping evidence the members already
-- carry, with no model call, and read by the story page and the 精选 fold. fact_id is the fact the group reports;
-- NULL means the group is a development of its own in that story.
CREATE TABLE publication.report_group_stories (
  lane text NOT NULL DEFAULT 'news' CHECK (lane='news'),
  group_id uuid PRIMARY KEY,
  story_id bigint NOT NULL,
  fact_id bigint,
  relation text NOT NULL CHECK (relation IN ('SAME_OCCURRENCE','SAME_STORY')),
  basis jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((relation='SAME_OCCURRENCE')=(fact_id IS NOT NULL))
);
CREATE INDEX report_group_stories_story_idx ON publication.report_group_stories(story_id);
