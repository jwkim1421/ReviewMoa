import type {
  JobSnapshot,
  JobStatus,
  ProductIdentity,
  Report,
} from "../domain/types";

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) {
    throw new Error("중앙 수집 API가 설정되지 않았습니다.");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (payload?.error === "JOB_NOT_FOUND") {
      throw new Error("저장된 작업을 찾지 못했습니다. 새로 요청해 주세요.");
    }
    if (payload?.error === "TEMPORARY_DATABASE_ERROR") {
      throw new Error("저장소 응답이 잠시 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (payload?.error === "UNAUTHORIZED") {
      throw new Error("운영자 인증 정보가 올바르지 않습니다.");
    }
    throw new Error(payload?.error ?? "요청에 실패했습니다.");
  }
  return response.json() as Promise<T>;
}

export interface CreateJobResult {
  id: string;
  status: JobStatus;
  operatorToken?: string;
  product?: ProductIdentity;
  report?: Report;
  cached?: boolean;
  deduplicated?: boolean;
}

export function createJob(
  product: ProductIdentity,
  options?: { collector?: "ios-safari" },
) {
  return request<CreateJobResult>("/v1/jobs", {
    method: "POST",
    body: JSON.stringify({ product, ...options }),
  });
}

export function getJob(jobId: string) {
  return request<JobSnapshot>(`/v1/jobs/${encodeURIComponent(jobId)}`);
}

export function refreshJob(
  jobId: string,
  options?: { collector?: "ios-safari" },
) {
  return request<CreateJobResult>(`/v1/jobs/${encodeURIComponent(jobId)}/refresh`, {
    method: "POST",
    body: options ? JSON.stringify(options) : undefined,
  });
}

export interface AdminMetric {
  total: number;
  successful: number;
  failed: number;
}

export interface AdminDiagnosticJob {
  id: string;
  product: {
    source: string;
    sourceLabel?: string;
    productId: string;
  };
  status: string;
  statusGroup: "successful" | "failed" | "waiting" | "active";
  errorCode?: string | null;
  interruptionReason?: string | null;
  collector?: string | null;
  handoffSource?: string | null;
  attemptCount: number;
  retryable: boolean;
  requestedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
  progress?: {
    stage?: string;
    source?: string;
    rating?: number;
    checked?: number;
    accepted?: number;
    extensionVersion?: string;
    diagnostics?: {
      adapter?: string;
      pageKind?: string;
      mobile?: boolean;
      failure?: string;
      collectionStrategy?: string;
      ready?: boolean;
      summaryDetected?: boolean;
      attemptCount?: number;
      sourceDistribution?: Record<string, number>;
      ratingDistribution?: Record<string, number>;
      collectionTargets?: Record<string, number>;
      validation?: { ok?: boolean; reason?: string };
      sourceTotal?: {
        ok?: boolean;
        reason?: string;
        displayedReviewTotal?: number;
        sourceReviewCount?: number;
      };
    };
  };
}

export interface AdminDiagnostics {
  generatedAt: string;
  limit: number;
  summary: {
    total: number;
    successful: number;
    failed: number;
    waiting: number;
    active: number;
    successRate: number | null;
    bySource: Record<string, AdminMetric>;
    byExtensionVersion: Record<string, AdminMetric>;
    byErrorCode: Record<string, number>;
  };
  jobs: AdminDiagnosticJob[];
}

export function getAdminDiagnostics(token: string, limit = 50) {
  return request<AdminDiagnostics>(`/v1/admin/diagnostics?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
