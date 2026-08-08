export type SourceSite =
  | "naver"
  | "coupang"
  | "kurly"
  | "ohouse"
  | "11st"
  | "ssg"
  | "gmarket"
  | "generic";

export type CapabilityStatus =
  | "verified"
  | "partial"
  | "login_required"
  | "unsupported"
  | "blocked";

export type JobStatus =
  | "probing"
  | "waiting_for_login"
  | "waiting_for_user"
  | "waiting_for_operator"
  | "collecting"
  | "filtering"
  | "queued"
  | "analyzing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface JobProgress {
  stage?: string;
  source?: string;
  rating?: number;
  checked?: number;
  accepted?: number;
  message?: string;
}

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  product: ProductIdentity;
  progress?: JobProgress;
  interruptionReason?: string | null;
  errorCode?: string | null;
  requestedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
  report?: Report;
}

export type ReviewClassification =
  | "included"
  | "sponsored"
  | "duplicate"
  | "rating_mismatch"
  | "uncertain";

export interface ProductIdentity {
  source: SourceSite;
  sourceLabel: string;
  originalUrl: string;
  canonicalUrl: string;
  productId: string;
  experimental: boolean;
}

export interface ReviewCapability {
  status: CapabilityStatus;
  hasReviewArea: boolean;
  supportsNewestSort: boolean;
  supportsRatingFilter: boolean;
  requiresLogin: boolean;
  message: string;
}

export interface RawReview {
  id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  content: string;
  createdAt?: string;
  option?: string;
  classification: ReviewClassification;
}

export interface RatingSummary {
  rating: 1 | 2 | 3 | 4 | 5;
  sourceCount?: number;
  checked: number;
  included: number;
  excluded: number;
  summary: string;
  reviews: RawReview[];
}

export interface Report {
  id: string;
  product: ProductIdentity & { name: string };
  collectedAt: string;
  refreshedAt: string;
  rawExpiresAt: string;
  reportExpiresAt: string;
  verdict: string;
  analysis?: {
    positive: string;
    negative: string;
    conclusion: string;
  };
  analysisProvider?: "openrouter" | "openai" | "rules";
  confidence: number;
  confidenceBreakdown?: {
    completeness: number;
    evidence: number;
    consistency: number;
    freshness: number;
    health: number;
  };
  confidenceReasons: string[];
  sampleNotice?: string;
  strengths: Array<{ label: string; mentions: number; ratio: number }>;
  cautions: Array<{ label: string; mentions: number; ratio: number }>;
  anomalyCounts: Record<Exclude<ReviewClassification, "included">, number>;
  ratings: RatingSummary[];
  limitations: string[];
  cached: boolean;
  collectionVerified?: boolean;
  demo?: boolean;
}
