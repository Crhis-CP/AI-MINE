-- 读者兴趣记录 (TASK-0596; Owner 2026-11-07): per complete Beijing day, the page views of ops.visit_pages summed by
-- what the reader filters classify the viewed articles under (category, mineral, company, country), the day's most
-- read articles, and the list and topic pages. Counts only, no visitor; kept for good as a reference (a day is a few
-- dozen rows). Re-recording a day replaces it.
CREATE TABLE ops.reader_interest_days (
  day date PRIMARY KEY,
  -- Views of article pages that day; classified_views those of articles that still had a page when it was recorded.
  item_views integer NOT NULL CHECK (item_views >= 0),
  classified_views integer NOT NULL CHECK (classified_views >= 0 AND classified_views <= item_views),
  list_views integer NOT NULL CHECK (list_views >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
-- The day's 50 most read articles; title and category as the lists showed them when the day was recorded.
CREATE TABLE ops.reader_interest_items (
  day date NOT NULL REFERENCES ops.reader_interest_days(day) ON DELETE CASCADE,
  article_id text NOT NULL CHECK (length(article_id) BETWEEN 1 AND 120),
  title text CHECK (length(title) <= 500),
  category text CHECK (length(category) <= 60),
  views integer NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, article_id)
);
-- Views summed per filter value (an article under two minerals counts for both) and per list or topic page.
CREATE TABLE ops.reader_interest_facets (
  day date NOT NULL REFERENCES ops.reader_interest_days(day) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN ('category','mineral','company','country','page')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  views integer NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, dimension, key)
);
