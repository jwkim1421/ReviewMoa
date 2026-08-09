import type { CollectionOutcome, CollectorReview } from "./types.js";

export interface CanaryPolicy {
  minReviews: number;
  requiredRatings: Array<1 | 2 | 3 | 4 | 5>;
  requireFullList: boolean;
  minDatedRatio: number;
}

export interface CanaryEvaluation {
  status: "passed" | "blocked" | "failed";
  code: string;
  exitCode: 0 | 1 | 2;
  reviewCount: number;
  ratingCounts: Record<string, number>;
  datedRatio: number;
}

const RATINGS = [5, 4, 3, 2, 1] as const;
const UI_SUFFIX_PATTERN = /(?:더보기\s*)?(?:이미지\s*펼치기\s*)+$/u;

function reviewStats(reviews: CollectorReview[]) {
  const ratingCounts = Object.fromEntries(RATINGS.map((rating) => [
    rating,
    reviews.filter((review) => review.rating === rating).length,
  ]));
  const dated = reviews.filter((review) => Boolean(review.createdAt)).length;
  return {
    ratingCounts,
    datedRatio: reviews.length ? dated / reviews.length : 0,
  };
}

function result(
  status: CanaryEvaluation["status"],
  code: string,
  exitCode: CanaryEvaluation["exitCode"],
  reviews: CollectorReview[] = [],
): CanaryEvaluation {
  const stats = reviewStats(reviews);
  return {
    status,
    code,
    exitCode,
    reviewCount: reviews.length,
    ratingCounts: stats.ratingCounts,
    datedRatio: Math.round(stats.datedRatio * 100) / 100,
  };
}

function datesAreNewestFirst(reviews: CollectorReview[]) {
  return RATINGS.every((rating) => {
    const dates = reviews
      .filter((review) => review.rating === rating && review.createdAt)
      .map((review) => review.createdAt!);
    return dates.every((date, index) => index === 0 || dates[index - 1].localeCompare(date) >= 0);
  });
}

export function evaluateCanaryOutcome(
  outcome: CollectionOutcome,
  policy: CanaryPolicy,
): CanaryEvaluation {
  if (outcome.kind === "interrupted") {
    return result("blocked", outcome.reason, 2);
  }
  if (outcome.kind === "failed") {
    return result("failed", outcome.code, 1);
  }

  const reviews = outcome.reviews;
  if (policy.requireFullList && outcome.partialReason === "summary_only") {
    return result("failed", "summary_only", 1, reviews);
  }
  if (reviews.length < policy.minReviews) {
    return result("failed", "review_count_below_minimum", 1, reviews);
  }
  if (new Set(reviews.map((review) => review.id)).size !== reviews.length) {
    return result("failed", "duplicate_review_id", 1, reviews);
  }
  if (reviews.some((review) => !review.content.trim() || UI_SUFFIX_PATTERN.test(review.content))) {
    return result("failed", "unclean_review_content", 1, reviews);
  }
  const stats = reviewStats(reviews);
  if (stats.datedRatio < policy.minDatedRatio) {
    return result("failed", "dated_review_ratio_below_minimum", 1, reviews);
  }
  if (!datesAreNewestFirst(reviews)) {
    return result("failed", "reviews_not_newest_first", 1, reviews);
  }
  if (policy.requiredRatings.some((rating) => stats.ratingCounts[String(rating)] === 0)) {
    return result("failed", "required_rating_missing", 1, reviews);
  }
  if (Object.values(stats.ratingCounts).some((count) => count > 100)) {
    return result("failed", "rating_limit_exceeded", 1, reviews);
  }
  return result("passed", "quality_gate_passed", 0, reviews);
}
