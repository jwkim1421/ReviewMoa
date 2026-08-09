// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanNaverReviewContent,
  collectNaverReviews,
  extractNaverReviewNodes,
  NAVER_REVIEW_ITEM_SELECTOR,
  selectNaverReviews,
} from "../src/adapters/naver";

const fixture = readFileSync(
  resolve("collector/tests/fixtures/naver-product.html"),
  "utf8",
);
const fullReviewFixture = readFileSync(
  resolve("test/fixtures/naver-mobile-full-review-dialog.html"),
  "utf8",
);

beforeEach(() => {
  document.documentElement.innerHTML = fixture;
});

class FixtureLocator {
  constructor(private readonly elements: Element[]) {}

  filter(options: { hasText?: RegExp }) {
    return new FixtureLocator(options.hasText
      ? this.elements.filter((element) =>
        options.hasText!.test(element.textContent?.trim() ?? "")
      )
      : this.elements);
  }

  count() {
    return Promise.resolve(this.elements.length);
  }

  nth(index: number) {
    return new FixtureLocator(this.elements[index] ? [this.elements[index]] : []);
  }

  isVisible() {
    return Promise.resolve(this.elements.length === 1);
  }

  isEnabled() {
    return Promise.resolve(
      this.elements.length === 1 &&
      !this.elements[0].hasAttribute("disabled"),
    );
  }

  click() {
    (this.elements[0] as HTMLElement | undefined)?.click();
    return Promise.resolve();
  }

  innerText() {
    return Promise.resolve((this.elements[0] as HTMLElement | undefined)?.innerText ?? "");
  }

  evaluateAll<T>(callback: (elements: Element[]) => T) {
    return Promise.resolve(callback(this.elements));
  }
}

function fixturePage() {
  return {
  locator(selector: string) {
      return new FixtureLocator(Array.from(document.querySelectorAll(selector)));
    },
    waitForTimeout() {
      return Promise.resolve();
    },
    url() {
      return "https://smartstore.naver.com/fixture/products/123";
    },
  } as unknown as Page;
}

describe("Naver review adapter", () => {
  it("passes the shared full-review fixture quality gate", async () => {
    document.documentElement.innerHTML = fullReviewFixture;
    const rows = extractNaverReviewNodes(
      Array.from(document.querySelectorAll(NAVER_REVIEW_ITEM_SELECTOR)),
    );
    const reviews = selectNaverReviews(
      rows,
      "https://m.brand.naver.com/fixture/products/123",
    );

    expect(rows).toHaveLength(8);
    expect(Object.fromEntries([5, 4, 3, 2, 1].map((rating) => [
      rating,
      reviews.filter((review) => review.rating === rating).length,
    ]))).toEqual({ 1: 1, 2: 1, 3: 1, 4: 2, 5: 3 });
    expect(reviews.filter((review) => review.rating === 5).map((review) => review.createdAt))
      .toEqual(["2026-08-09", "2026-08-07", "2026-08-01"]);
    expect(reviews.every((review) => !/더보기|이미지\s*펼치기/u.test(review.content)))
      .toBe(true);
    await expect(collectNaverReviews(fixturePage())).resolves.toMatchObject({
      kind: "completed",
      reviews: expect.arrayContaining([
        expect.objectContaining({ id: "fixture-1", rating: 1 }),
        expect.objectContaining({ id: "fixture-5-new", rating: 5 }),
      ]),
    });
  });

  it("removes Naver UI suffixes without changing the review body", () => {
    expect(cleanNaverReviewContent(
      "내용은 그대로 유지합니다. 더보기 이미지 펼치기 이미지 펼치기",
    )).toBe("내용은 그대로 유지합니다.");
  });

  it("extracts only reviews with a verified rating and body", () => {
    const rows = extractNaverReviewNodes(
      Array.from(document.querySelectorAll(NAVER_REVIEW_ITEM_SELECTOR)),
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: "naver-review-1",
      rating: 5,
      content: "배송이 빠르고 설치가 쉬워서 아주 만족합니다.",
      createdAt: "2026-07-28",
      option: "색상: 화이트",
    });
    expect(rows[1]).toMatchObject({
      id: "naver-review-2",
      rating: 2,
      createdAt: "2026-07-27",
    });
  });

  it("classifies sponsored and rating-mismatch signals conservatively", () => {
    const rows = extractNaverReviewNodes(
      Array.from(document.querySelectorAll(NAVER_REVIEW_ITEM_SELECTOR)),
    );
    const reviews = selectNaverReviews(
      rows,
      "https://smartstore.naver.com/fixture/products/123",
    );

    expect(reviews.find(({ id }) => id === "naver-review-sponsored"))
      .toMatchObject({ rating: 4, classification: "sponsored" });
    expect(reviews.find(({ id }) => id === "naver-review-2"))
      .toMatchObject({ rating: 2, classification: "included" });
  });

  it("deduplicates nested selector matches by review identity", () => {
    const first = document.querySelector("[data-review-id='naver-review-1']")!;
    const rows = extractNaverReviewNodes([first, first]);
    expect(rows).toHaveLength(1);
  });

  it("supports Naver's stable review content identity attributes", () => {
    document.body.innerHTML = `
      <button
        data-shp-contents-type="review"
        data-shp-contents-id="5029668271"
      >
        <span><span><span class="blind">평점</span>5</span></span>
        <span>오픈형이라 귀가 편하고 음질도 만족스러운 실제 리뷰 본문입니다.</span>
      </button>
    `;
    const rows = extractNaverReviewNodes(
      Array.from(document.querySelectorAll(NAVER_REVIEW_ITEM_SELECTOR)),
    );
    expect(rows).toEqual([{
      id: "5029668271",
      rating: 5,
      content: "오픈형이라 귀가 편하고 음질도 만족스러운 실제 리뷰 본문입니다.",
      createdAt: undefined,
      option: undefined,
    }]);
  });

  it("returns a completed collection outcome from a rendered review list", async () => {
    const outcome = await collectNaverReviews(fixturePage());
    expect(outcome).toMatchObject({ kind: "completed" });
    if (outcome.kind !== "completed") throw new Error("수집 결과가 완료 상태가 아닙니다.");
    expect(outcome.reviews).toHaveLength(3);
    expect(outcome.reviews.map(({ id }) => id)).toContain("naver-review-1");
  });

  it("returns top-review summaries as an explicitly partial collection", async () => {
    document.body.innerHTML = `
      <button
        data-shp-area="sprvsub.topreview"
        data-shp-contents-type="review"
        data-shp-contents-id="top-review-1"
      >
        <span><span class="blind">평점</span>5</span>
        <span>상단 대표 리뷰만 확인된 경우에는 전체 수집으로 처리하지 않습니다.</span>
      </button>
    `;
    await expect(collectNaverReviews(fixturePage())).resolves.toMatchObject({
      kind: "completed",
      partialReason: "summary_only",
      reviews: [{
        id: "top-review-1",
        rating: 5,
      }],
    });
  });
});
