ALTER TABLE ai.usage_attempts ADD COLUMN task_key text;
ALTER TABLE ai.usage_attempts ADD COLUMN task_limit_micros bigint;
CREATE INDEX usage_attempts_task ON ai.usage_attempts(task_key) WHERE task_key IS NOT NULL;
