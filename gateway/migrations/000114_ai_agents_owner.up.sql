BEGIN;

SET search_path TO private;

-- The owner is the user an agent acts for: its display name and the email
-- recorded on every session, review and audit entry are derived from this row.
-- Nullable so agents created before this migration keep their literal name.
--
-- ON DELETE RESTRICT is deliberate: silently dropping the owner would revert
-- the agent to reporting its own name in the email column, quietly changing
-- who past and future actions appear to belong to. Reassign or revoke the
-- agent before deleting the user.
ALTER TABLE ai_agents
    ADD COLUMN owner_user_id UUID NULL REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX idx_ai_agents_owner_user_id ON ai_agents(owner_user_id);

COMMIT;
