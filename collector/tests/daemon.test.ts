import type { BrowserContext } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  processClaimedJob,
  type CollectorApiClient,
} from "../src/daemon";
import type {
  CollectionOutcome,
  CollectorJob,
  CollectorProgress,
  CollectorReview,
  FailureCode,
  InterruptionReason,
} from "../src/types";

const JOB: CollectorJob = {
  id: "job-1",
  cacheKey: "naver:123:all",
  product: {
    source: "naver",
    productId: "123",
    canonicalUrl: "https://smartstore.naver.com/store/products/123",
  },
  status: "collecting",
  requestedAt: "2026-07-28T00:00:00.000Z",
  startedAt: "2026-07-28T00:00:01.000Z",
  claimedBy: "home-mac-01",
  leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  heartbeatAt: "2026-07-28T00:00:01.000Z",
  attemptCount: 1,
};

function fakeApi() {
  const calls: string[] = [];
  const api: CollectorApiClient = {
    async claim() {
      return null;
    },
    async heartbeat(_jobId: string, progress: CollectorProgress) {
      calls.push(
        progress.partialReason
          ? `heartbeat:${progress.stage}:${progress.partialReason}`
          : `heartbeat:${progress.stage}`,
      );
    },
    async uploadReviews(_jobId: string, reviews: CollectorReview[]) {
      calls.push(`reviews:${reviews.length}`);
      return reviews.length;
    },
    async interrupt(_jobId: string, reason: InterruptionReason) {
      calls.push(`interrupt:${reason}`);
    },
    async complete() {
      calls.push("complete");
    },
    async fail(_jobId: string, code: FailureCode) {
      calls.push(`fail:${code}`);
    },
  };
  return { api, calls };
}

async function runWithOutcome(outcome: CollectionOutcome) {
  const { api, calls } = fakeApi();
  const collect = vi.fn(async () => outcome);
  await processClaimedJob(
    api,
    {} as BrowserContext,
    JOB,
    { heartbeatIntervalMs: 60_000, navigationTimeoutMs: 60_000 },
    collect,
  );
  return { calls, collect };
}

describe("collector job lifecycle", () => {
  it("uploads reviews and completes a collected job", async () => {
    const result = await runWithOutcome({
      kind: "completed",
      reviews: [{
        id: "review-1",
        rating: 5,
        content: "만족합니다.",
        classification: "included",
      }],
    });

    expect(result.calls).toEqual([
      "heartbeat:opening",
      "reviews:1",
      "heartbeat:completing",
      "complete",
    ]);
    expect(result.collect).toHaveBeenCalledOnce();
  });

  it("interrupts CAPTCHA without uploading or completing", async () => {
    const result = await runWithOutcome({ kind: "interrupted", reason: "captcha" });
    expect(result.calls).toEqual(["heartbeat:opening", "interrupt:captcha"]);
  });

  it("passes a summary-only marker through the completing heartbeat", async () => {
    const result = await runWithOutcome({
      kind: "completed",
      partialReason: "summary_only",
      reviews: [{
        id: "review-1",
        rating: 5,
        content: "공개된 대표 리뷰입니다.",
        classification: "included",
      }],
    });
    expect(result.calls).toEqual([
      "heartbeat:opening",
      "reviews:1",
      "heartbeat:completing:summary_only",
      "complete",
    ]);
  });

  it("reports a safe adapter failure", async () => {
    const result = await runWithOutcome({
      kind: "failed",
      code: "adapter_not_implemented",
    });
    expect(result.calls).toEqual([
      "heartbeat:opening",
      "fail:adapter_not_implemented",
    ]);
  });
});
