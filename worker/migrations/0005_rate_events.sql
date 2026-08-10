CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS rate_events_window_idx ON rate_events(window_start);
