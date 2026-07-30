export type InterruptionReason =
  | "login_required"
  | "captcha"
  | "access_blocked"
  | "operator_required";

export type FailureCode =
  | "review_area_not_found"
  | "product_unavailable"
  | "unsupported_redirect"
  | "browser_timeout"
  | "access_blocked"
  | "site_error"
  | "collection_failed"
  | "adapter_not_implemented";

export type ReviewClassification =
  | "included"
  | "sponsored"
  | "duplicate"
  | "rating_mismatch"
  | "uncertain";

export interface CollectorReview {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  content: string;
  createdAt?: string;
  option?: string;
  classification: ReviewClassification;
}

export interface CollectorJob {
  id: string;
  cacheKey: string;
  product: {
    source: string;
    sourceLabel?: string;
    productId: string;
    canonicalUrl: string;
    name?: string;
  };
  status: "collecting";
  requestedAt: string | null;
  startedAt: string | null;
  claimedBy: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  attemptCount: number;
  progress?: Record<string, unknown>;
}

export type CollectionOutcome =
  | {
    kind: "completed";
    reviews: CollectorReview[];
    partialReason?: "summary_only";
  }
  | { kind: "interrupted"; reason: InterruptionReason }
  | { kind: "failed"; code: FailureCode };

export interface CollectorProgress {
  stage: "claimed" | "opening" | "probing" | "collecting" | "uploading" | "completing";
  rating?: number;
  checked?: number;
  accepted?: number;
  message?: string;
  partialReason?: "summary_only";
}
