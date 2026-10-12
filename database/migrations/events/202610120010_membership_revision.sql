ALTER TABLE fact_articles ADD COLUMN input_revision integer;
COMMENT ON COLUMN fact_articles.input_revision IS 'Automatic membership is valid only for this source revision; null requires reassessment.';
