import { describe, expect, it } from "vitest";
import { createLocalReport } from "./analyze";
import type { ProductIdentity, RawReview } from "./types";

const product: ProductIdentity = {
  source: "kurly",
  sourceLabel: "컬리",
  originalUrl: "https://www.kurly.com/goods/1",
  canonicalUrl: "https://kurly.com/goods/1",
  productId: "1",
  experimental: false,
};

describe("createLocalReport", () => {
  it("excludes suspicious reviews from rating totals", () => {
    const reviews: RawReview[] = [
      { id: "1", rating: 5, content: "배송이 빨라서 만족해요", classification: "included" },
      { id: "2", rating: 5, content: "체험단 리뷰입니다", classification: "sponsored" },
      { id: "3", rating: 1, content: "제품이 고장 나서 반품했어요", classification: "included" },
    ];
    const report = createLocalReport(product, reviews, "테스트 상품");
    expect(report.ratings.find((item) => item.rating === 5)?.included).toBe(1);
    expect(report.ratings.find((item) => item.rating === 5)?.excluded).toBe(1);
    expect(report.anomalyCounts.sponsored).toBe(1);
  });

  it("reports an empty rating bucket as zero", () => {
    const report = createLocalReport(product, [], "테스트 상품");
    expect(report.ratings.find((item) => item.rating === 3)).toMatchObject({
      checked: 0,
      included: 0,
      reviews: [],
    });
  });

  it("keeps at most five representative originals", () => {
    const reviews = Array.from({ length: 12 }, (_, index): RawReview => ({
      id: String(index),
      rating: 4,
      content: `사용하기 편한 리뷰 ${index}`,
      classification: "included",
    }));
    const report = createLocalReport(product, reviews, "테스트 상품");
    expect(report.ratings.find((item) => item.rating === 4)?.reviews).toHaveLength(5);
  });
});
