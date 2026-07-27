import { createDemoReport } from "../domain/demo";
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
        status: product.experimental ? "partial" : "verified",
        hasReviewArea: true,
        supportsNewestSort: true,
        supportsRatingFilter: !product.experimental,
        requiresLogin: false,
        message: product.experimental
          ? "범용 방식으로 리뷰 영역을 확인합니다."
          : `${product.sourceLabel} 상품 URL 형식을 확인했습니다.`,
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return createDemoReport(product);
  }
  const job = await request<{ id: string }>("/v1/jobs", {
    method: "POST",
    body: JSON.stringify({ product }),
  });
  if (reviews?.length) {
    for (let index = 0; index < reviews.length; index += 100) {
      await request(`/v1/jobs/${job.id}/reviews`, {
        method: "POST",
        body: JSON.stringify({ reviews: reviews.slice(index, index + 100) }),
      });
    }
    return request(`/v1/jobs/${job.id}/complete`, { method: "POST" });
  }
  return request(`/v1/jobs/${job.id}/demo-complete`, { method: "POST" });
}
