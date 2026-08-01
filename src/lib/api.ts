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
