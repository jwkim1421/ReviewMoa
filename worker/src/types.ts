export interface AppEnv extends Env {
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
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
