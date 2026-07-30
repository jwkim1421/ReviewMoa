export interface AppEnv extends Env {
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  COLLECTOR_TOKEN?: string;
}

export interface CollectorJobRow {
  id: string;
  cache_key: string;
  product_json: string;
  status: string;
  requested_at: string | null;
  started_at: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number;
  progress_json: string | null;
}

export type Classification =
  | "included"
  | "sponsored"
  | "duplicate"
  | "rating_mismatch"
  | "uncertain";

export interface StoredReview {
  review_id: string;
  rating: number;
  content: string;
  created_at?: string;
  option_name?: string;
  classification: Classification;
}
