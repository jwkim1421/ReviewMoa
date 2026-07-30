ALTER TABLE jobs ADD COLUMN operator_token_hash TEXT;
ALTER TABLE jobs ADD COLUMN operator_token_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN handoff_source TEXT;

CREATE INDEX IF NOT EXISTS jobs_operator_token_idx
ON jobs(operator_token_hash);
