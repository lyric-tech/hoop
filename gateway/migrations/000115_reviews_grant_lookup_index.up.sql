SET search_path TO private;

-- every session open looks up the caller's active grant for a rule
CREATE INDEX IF NOT EXISTS index_reviews_grant_lookup
    ON reviews (org_id, owner_id, access_request_rule_name, revoked_at DESC)
    WHERE type = 'jit' AND status = 'APPROVED';
