ALTER TABLE notify_targets ADD COLUMN jurisdiction text;
ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_purpose_check;
ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_purpose_check
  CHECK (purpose IN ('content','country_content','alert','feedback'));
ALTER TABLE notify_targets ADD CONSTRAINT notify_target_country
  CHECK ((purpose='country_content' AND jurisdiction IS NOT NULL AND jurisdiction ~ '^[A-Z]{2}$')
    OR (purpose<>'country_content' AND jurisdiction IS NULL));
ALTER TABLE notify_targets ADD CONSTRAINT notify_main_general
  CHECK (key <> 'feishu-content-main' OR jurisdiction IS NULL);
