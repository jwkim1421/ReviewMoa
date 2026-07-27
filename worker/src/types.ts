export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  OPENAI_API_KEY?: string;
  AI_MODEL?: string;
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
