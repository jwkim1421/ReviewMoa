// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

type CollectorHooks = {
  detectInterruption(): {
    status: string;
    reason: string;
    message: string;
  } | null;
  extractRating(node: Element): number | null;
  readVisibleReviews(
    config: unknown,
    options: {
      forcedRating?: number;
      duplicateBodies: Set<string>;
      seenKeys: Set<string>;
    },
  ): Array<{
    id: string;
    rating: number;
    content: string;
    classification: string;
  }>;
  selectLatestByRating<T extends {
    rating: number;
    classification: string;
    createdAt?: string;
  }>(reviews: T[]): T[];
};

let collector: CollectorHooks;

beforeAll(async () => {
  await import("./content.js");
  collector = (globalThis as typeof globalThis & {
    REVIEWMOA_COLLECTOR_TEST: CollectorHooks;
  }).REVIEWMOA_COLLECTOR_TEST;
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("review collector", () => {
  it("extracts explicit ratings and does not default an unknown rating to five", () => {
    document.body.innerHTML = `
      <article id="known" data-rating="2"><p>배송은 왔지만 제품이 파손되어 아쉬워요.</p></article>
      <article id="unknown"><p>별점 표시를 확인할 수 없는 충분히 긴 리뷰 본문입니다.</p></article>
    `;
    expect(collector.extractRating(document.querySelector("#known")!)).toBe(2);
    expect(collector.extractRating(document.querySelector("#unknown")!)).toBeNull();
  });

  it("extracts visible reviews and separates sponsored signals", () => {
    document.body.innerHTML = `
      <ul id="review-list">
        <li data-review-id="r1" data-rating="5">
          <p class="review-content">배송이 빠르고 사용하기 편해서 만족합니다.</p>
          <time>2026-07-26</time>
        </li>
        <li data-review-id="r2" data-rating="4">
          <p class="review-content">제품을 제공받아 작성했으며 포장은 깔끔했습니다.</p>
          <time>2026-07-25</time>
        </li>
      </ul>
    `;
    const reviews = collector.readVisibleReviews(undefined, {
      duplicateBodies: new Set(),
      seenKeys: new Set(),
    });
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ id: "r1", rating: 5, classification: "included" });
    expect(reviews[1]).toMatchObject({ id: "r2", rating: 4, classification: "sponsored" });
  });

  it("extracts a Naver data-shp review with a visible star score", () => {
    document.body.innerHTML = `
      <article
        data-shp-contents-type="review"
        data-shp-contents-id="naver-review-503"
      >
        <span>★ 5</span>
        <p>포장이 꼼꼼하고 아이가 잘 먹어서 만족합니다.</p>
        <time>2026.07.19.</time>
      </article>
    `;
    const reviews = collector.readVisibleReviews(undefined, {
      duplicateBodies: new Set(),
      seenKeys: new Set(),
    });
    expect(reviews).toEqual([
      expect.objectContaining({
        id: "naver-review-503",
        rating: 5,
        classification: "included",
      }),
    ]);
  });

  it("keeps at most one hundred included reviews per rating", () => {
    const rows = Array.from({ length: 115 }, (_, index) => ({
      id: `review-${index}`,
      rating: 5,
      content: `리뷰 ${index}`,
      classification: index < 5 ? "sponsored" : "included",
      createdAt: new Date(Date.UTC(2026, 6, 27 - index)).toISOString(),
    }));
    const selected = collector.selectLatestByRating(rows);
    expect(selected.filter((review) => review.classification === "included")).toHaveLength(100);
    expect(selected.filter((review) => review.classification === "sponsored")).toHaveLength(5);
  });

  it("recognizes Naver receipt security verification as CAPTCHA", () => {
    document.body.innerHTML = `
      <main>
        <h1>NAVER 보안 확인을 완료해 주세요.</h1>
        <p>해당 영수증은 가상으로 제작되었습니다. 빈 칸을 채워주세요.</p>
      </main>
    `;
    expect(collector.detectInterruption()).toMatchObject({
      status: "waiting_for_user",
      reason: "captcha",
    });
  });
});
