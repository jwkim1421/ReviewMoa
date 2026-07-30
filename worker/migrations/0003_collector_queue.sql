ALTER TABLE jobs ADD COLUMN requested_at TEXT;
ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN finished_at TEXT;
ALTER TABLE jobs ADD COLUMN claimed_by TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN progress_json TEXT;
ALTER TABLE jobs ADD COLUMN interruption_reason TEXT;

UPDATE jobs
SET requested_at = created_at
WHERE requested_at IS NULL;

CREATE INDEX IF NOT EXISTS jobs_queue_idx
ON jobs(status, requested_at);

CREATE INDEX IF NOT EXISTS jobs_lease_idx
ON jobs(status, lease_expires_at);
