import type {
  CollectorJob,
  CollectorProgress,
  CollectorReview,
  FailureCode,
  InterruptionReason,
} from "./types.js";

interface ApiConfig {
  apiBase: string;
  token: string;
  collectorId: string;
}

export class CollectorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class CollectorApi {
  constructor(private readonly config: ApiConfig) {}

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const response = await fetch(`${this.config.apiBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({})) as { error?: string } & T;
    if (!response.ok) {
      throw new CollectorApiError(
        payload.error ?? `Collector API 요청 실패 (${response.status})`,
        response.status,
        payload.error,
      );
    }
    return payload;
  }

  async claim() {
    const result = await this.request<{ job: CollectorJob }>("/v1/collector/claim", {
      collectorId: this.config.collectorId,
    });
    return result?.job ?? null;
  }

  async heartbeat(jobId: string, progress: CollectorProgress) {
    return this.request(`/v1/collector/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
      collectorId: this.config.collectorId,
      progress,
    });
  }

  async uploadReviews(jobId: string, reviews: CollectorReview[]) {
    let accepted = 0;
    for (let index = 0; index < reviews.length; index += 100) {
      const batch = reviews.slice(index, index + 100);
      const result = await this.request<{ accepted: number }>(
        `/v1/collector/jobs/${encodeURIComponent(jobId)}/reviews`,
        { collectorId: this.config.collectorId, reviews: batch },
      );
      accepted += result?.accepted ?? 0;
    }
    return accepted;
  }

  interrupt(jobId: string, reason: InterruptionReason) {
    return this.request(`/v1/collector/jobs/${encodeURIComponent(jobId)}/interrupt`, {
      collectorId: this.config.collectorId,
      reason,
    });
  }

  complete(jobId: string) {
    return this.request(`/v1/collector/jobs/${encodeURIComponent(jobId)}/complete`, {
      collectorId: this.config.collectorId,
    });
  }

  fail(jobId: string, code: FailureCode) {
    return this.request(`/v1/collector/jobs/${encodeURIComponent(jobId)}/fail`, {
      collectorId: this.config.collectorId,
      code,
    });
  }
}
