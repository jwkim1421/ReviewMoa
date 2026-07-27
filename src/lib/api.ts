import { createLocalReport } from "../domain/analyze";
import type { ProductIdentity, RawReview, Report, ReviewCapability } from "../domain/types";

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error("API_NOT_CONFIGURED");
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error((await response.text()) || "요청에 실패했습니다.");
  return response.json() as Promise<T>;
}

export async function probeProduct(product: ProductIdentity): Promise<{
  capability: ReviewCapability;
  report?: Report;
}> {
  if (!API_BASE) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return {
      capability: {
        status: "partial",
        hasReviewArea: false,
        supportsNewestSort: false,
        supportsRatingFilter: false,
        requiresLogin: false,
        message: `${product.sourceLabel} 상품 URL 형식을 확인했습니다. 확장 프로그램에서 리뷰 영역을 검증합니다.`,
      },
    };
  }
  return request("/v1/jobs/probe", {
    method: "POST",
    body: JSON.stringify({ product }),
  });
}

export async function analyzeProduct(product: ProductIdentity, reviews?: RawReview[]): Promise<Report> {
  if (!API_BASE) {
    if (!reviews) throw new Error("REVIEW_COLLECTION_REQUIRED");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return createLocalReport(product, reviews, "상품 리뷰 분석");
  }
  if (!reviews) throw new Error("REVIEW_COLLECTION_REQUIRED");
  const job = await request<{ id: string }>("/v1/jobs", {
    method: "POST",
    body: JSON.stringify({ product }),
  });
  if (reviews.length) {
    for (let index = 0; index < reviews.length; index += 100) {
      await request(`/v1/jobs/${job.id}/reviews`, {
        method: "POST",
        body: JSON.stringify({ reviews: reviews.slice(index, index + 100) }),
      });
    }
  }
  return request(`/v1/jobs/${job.id}/complete`, { method: "POST" });
}
