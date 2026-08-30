BEGIN;

SET search_path TO private;

DROP INDEX IF EXISTS idx_ai_agents_owner_user_id;
ALTER TABLE ai_agents DROP COLUMN IF EXISTS owner_user_id;

COMMIT;
