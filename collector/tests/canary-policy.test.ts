import { describe, expect, it } from "vitest";
import { evaluateCanaryOutcome, type CanaryPolicy } from "../src/canary-policy";
import type { CollectorReview } from "../src/types";

const policy: CanaryPolicy = {
  minReviews: 5,
  requiredRatings: [5, 4, 3, 2, 1],
  requireFullList: true,
  minDatedRatio: 1,
};

const reviews: CollectorReview[] = [5, 4, 3, 2, 1].map((rating) => ({
  id: `review-${rating}`,
  rating: rating as CollectorReview["rating"],
  content: `${rating}점에 해당하는 충분히 긴 정상 리뷰 본문입니다.`,
  createdAt: `2026-08-0${rating}`,
  classification: "included",
}));

describe("Naver live canary quality policy", () => {
  it("passes a complete, clean, rating-balanced result", () => {
    expect(evaluateCanaryOutcome({ kind: "completed", reviews }, policy)).toMatchObject({
      status: "passed",
      code: "quality_gate_passed",
      exitCode: 0,
      reviewCount: 5,
      ratingCounts: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 },
      datedRatio: 1,
    });
  });

  it("fails summary-only, incomplete, unclean, and unsorted results", () => {
    expect(evaluateCanaryOutcome({
      kind: "completed",
      reviews,
      partialReason: "summary_only",
    }, policy)).toMatchObject({ status: "failed", code: "summary_only" });
    expect(evaluateCanaryOutcome({ kind: "completed", reviews: reviews.slice(0, 4) }, policy))
      .toMatchObject({ status: "failed", code: "review_count_below_minimum" });
    expect(evaluateCanaryOutcome({
      kind: "completed",
      reviews: reviews.map((review, index) => index === 0
        ? { ...review, content: `${review.content} 더보기 이미지 펼치기` }
        : review),
    }, policy)).toMatchObject({ status: "failed", code: "unclean_review_content" });
    expect(evaluateCanaryOutcome({
      kind: "completed",
      reviews: [
        { ...reviews[0], id: "newer", createdAt: "2026-08-01" },
        { ...reviews[0], id: "older", createdAt: "2026-08-02" },
        ...reviews.slice(1),
      ],
    }, { ...policy, minReviews: 6 })).toMatchObject({
      status: "failed",
      code: "reviews_not_newest_first",
    });
  });

  it("treats CAPTCHA and access restriction as blocked without retrying", () => {
    expect(evaluateCanaryOutcome({ kind: "interrupted", reason: "captcha" }, policy))
      .toEqual(expect.objectContaining({ status: "blocked", code: "captcha", exitCode: 2 }));
    expect(evaluateCanaryOutcome({ kind: "interrupted", reason: "access_blocked" }, policy))
      .toEqual(expect.objectContaining({ status: "blocked", code: "access_blocked", exitCode: 2 }));
  });

  it("fails when a required rating is absent", () => {
    expect(evaluateCanaryOutcome({
      kind: "completed",
      reviews: reviews.filter((review) => review.rating !== 1),
    }, { ...policy, minReviews: 4 })).toMatchObject({
      status: "failed",
      code: "required_rating_missing",
    });
  });
});
