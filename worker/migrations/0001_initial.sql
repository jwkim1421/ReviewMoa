CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  product_json TEXT NOT NULL,
  status TEXT NOT NULL,
  capability_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_cache_key_idx ON jobs(cache_key);

CREATE TABLE IF NOT EXISTS reviews (
  job_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  content TEXT NOT NULL,
  created_at TEXT,
  option_name TEXT,
  classification TEXT NOT NULL,
  raw_expires_at TEXT NOT NULL,
  PRIMARY KEY(job_id, review_id)
);

CREATE INDEX IF NOT EXISTS reviews_job_rating_idx ON reviews(job_id, rating);
CREATE INDEX IF NOT EXISTS reviews_expiry_idx ON reviews(raw_expires_at);

CREATE TABLE IF NOT EXISTS reports (
  cache_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  raw_expires_at TEXT NOT NULL,
  report_expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reports_expiry_idx ON reports(report_expires_at);
