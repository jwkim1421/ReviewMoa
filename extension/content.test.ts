// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

type CollectorHooks = {
  detectInterruption(): {
    status: string;
    reason: string;
    message: string;
  } | null;
  findFullNaverReviewControl(): Element | null;
  hasOnlyNaverSummaryReviews(config?: unknown): boolean;
  openFullNaverReviewList(config?: unknown, waitTimeout?: number): Promise<boolean>;
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
  showCollectionOverlay(message: string): void;
  hideCollectionOverlay(): void;
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

  it("opens Naver's full review list instead of stopping at representative reviews", async () => {
    document.body.innerHTML = `
      <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
        <span>★ 5</span>
        <p>대표 영역에 먼저 노출된 충분히 긴 리뷰 본문입니다.</p>
      </article>
      <a data-shp-area="sprvsub.rvmore" target="_blank">리뷰 6,003</a>
    `;
    const control = collector.findFullNaverReviewControl() as HTMLAnchorElement;
    control.addEventListener("click", (event) => {
      event.preventDefault();
      document.body.innerHTML = `
        <article data-shp-contents-type="review" data-shp-area="sprvsub.review">
          <span>★ 4</span>
          <p>전체 리뷰 목록에서 새로 확인한 충분히 긴 리뷰 본문입니다.</p>
        </article>
      `;
    });

    expect(collector.hasOnlyNaverSummaryReviews()).toBe(true);
    await expect(collector.openFullNaverReviewList()).resolves.toBe(true);
    expect(control.hasAttribute("target")).toBe(false);
    expect(collector.hasOnlyNaverSummaryReviews()).toBe(false);
  });

  it("tries the actual full-list button when the first Naver review link only scrolls", async () => {
    document.body.innerHTML = `
      <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
        <span>★ 5</span>
        <p>대표 영역에 먼저 노출된 충분히 긴 리뷰 본문입니다.</p>
      </article>
      <a data-shp-area="sprvsub.rvmore">리뷰 6,003</a>
      <button data-shp-area="sprvsub.topreviewmore">리뷰 전체보기</button>
    `;
    const fullListButton = document.querySelector(
      "button[data-shp-area='sprvsub.topreviewmore']",
    )!;
    fullListButton.addEventListener("click", () => {
      document.body.innerHTML = `
        <article data-shp-contents-type="review" data-shp-area="sprvsub.review">
          <span>★ 5</span>
          <p>두 번째 버튼으로 연 전체 리뷰 목록의 충분히 긴 본문입니다.</p>
        </article>
      `;
    });

    await expect(collector.openFullNaverReviewList(undefined, 1)).resolves.toBe(true);
    expect(collector.hasOnlyNaverSummaryReviews()).toBe(false);
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

  it("covers the product page while reviews are being collected", () => {
    collector.showCollectionOverlay("5점 리뷰를 확인하고 있어요.");

    const overlay = document.querySelector("#reviewmoa-collection-overlay") as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.shadowRoot?.querySelector("strong")?.textContent).toContain("리뷰 수집 중");
    expect(overlay.shadowRoot?.querySelector("p")?.textContent).toBe(
      "5점 리뷰를 확인하고 있어요.",
    );
    expect(overlay.shadowRoot?.textContent).toContain(
      "수집이 끝나면 리뷰모아로 자동으로 돌아갑니다.",
    );

    collector.hideCollectionOverlay();
    expect(document.querySelector("#reviewmoa-collection-overlay")).toBeNull();
  });
});
