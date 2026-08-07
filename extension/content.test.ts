// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://brand.naver.com/test/products/1"}

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
  prepareReviewArea(config?: unknown, job?: { id: string }, waitTimeout?: number): Promise<boolean>;
  readNaverRatingDistribution(): Record<number, number> | null;
  readVisibleNaverReviews(options: {
    duplicateBodies: Set<string>;
    seenKeys: Set<string>;
  }): Array<{
    id: string;
    rating: number;
    content: string;
    classification: string;
  }>;
  validateNaverCollection(
    reviews: Array<{ rating: number }>,
    distribution: Record<number, number>,
  ): { ok: boolean; reason?: string };
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
        <section role="dialog">
          <button data-shp-area="sprvarevlist_l.sortfilter" aria-checked="true">최신순 정렬하기</button>
          <article data-shp-contents-type="review">
          <span>★ 4</span>
            <p data-shp-area="sprvarevlist_l.review">전체 리뷰 목록에서 새로 확인한 충분히 긴 리뷰 본문입니다.</p>
          </article>
        </section>
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
        <section role="dialog">
          <button data-shp-area="sprvarevlist_l.sortfilter" aria-checked="true">최신순 정렬하기</button>
          <article data-shp-contents-type="review">
            <span>★ 5</span>
            <p data-shp-area="sprvarevlist_l.review">두 번째 버튼으로 연 전체 리뷰 목록의 충분히 긴 본문입니다.</p>
          </article>
        </section>
      `;
    });

    await expect(collector.openFullNaverReviewList(undefined, 1)).resolves.toBe(true);
    expect(collector.hasOnlyNaverSummaryReviews()).toBe(false);
  });

  it("waits for a slowly rendered Naver full-review dialog on iPhone", async () => {
    document.body.innerHTML = `
      <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
        <span>★ 5</span>
        <p>대표 영역에 먼저 노출된 충분히 긴 리뷰 본문입니다.</p>
      </article>
      <button data-shp-area="sprvsub.topreviewmore">리뷰 전체보기</button>
    `;
    document
      .querySelector("button[data-shp-area='sprvsub.topreviewmore']")!
      .addEventListener("click", () => {
        window.setTimeout(() => {
          document.body.innerHTML = `
            <section role="dialog">
              <button data-shp-area="sprvarevlist_l.sortfilter">최신순 정렬하기</button>
              <article data-shp-contents-type="review">
                <span>★ 5</span>
                <p data-shp-area="sprvarevlist_l.review">느린 모바일 렌더링 뒤 확인한 전체 리뷰의 충분히 긴 본문입니다.</p>
              </article>
            </section>
          `;
        }, 25);
      });

    await expect(collector.openFullNaverReviewList(undefined, 100)).resolves.toBe(true);
  });

  it("retries a Naver full-review button exposed before iPhone hydration completes", async () => {
    document.body.innerHTML = `
      <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
        <span>★ 5</span>
        <p>대표 영역에 먼저 노출된 충분히 긴 리뷰 본문입니다.</p>
      </article>
      <button data-shp-area="sprvsub.topreviewmore">리뷰 전체보기</button>
    `;
    let clickCount = 0;
    document
      .querySelector("button[data-shp-area='sprvsub.topreviewmore']")!
      .addEventListener("click", () => {
        clickCount += 1;
        if (clickCount < 2) return;
        document.body.innerHTML = `
          <section role="dialog">
            <button data-shp-area="sprvarevlist_l.sortfilter">최신순 정렬하기</button>
            <article data-shp-contents-type="review">
              <span>★ 4</span>
              <p data-shp-area="sprvarevlist_l.review">두 번째 클릭에서 열린 전체 리뷰의 충분히 긴 본문입니다.</p>
            </article>
          </section>
        `;
      });

    await expect(collector.openFullNaverReviewList(undefined, 1_100)).resolves.toBe(true);
    expect(clickCount).toBe(2);
  });

  it("tries Naver full-list controls even when another review node confuses summary detection", async () => {
    document.body.innerHTML = `
      <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
        <span>★ 5</span>
        <p>대표 영역에 먼저 노출된 충분히 긴 리뷰 본문입니다.</p>
      </article>
      <article data-shp-contents-type="review" data-shp-area="sprvsub.preview">
        <span>별점 5점</span>
        <p>초기 화면 판정을 흐리는 다른 리뷰 관련 노드입니다.</p>
      </article>
      <button data-shp-area="sprvsub.topreviewmore">리뷰 전체보기</button>
    `;
    const fullListButton = document.querySelector(
      "button[data-shp-area='sprvsub.topreviewmore']",
    )!;
    fullListButton.addEventListener("click", () => {
      document.body.innerHTML = `
        <section role="dialog">
          <button data-shp-area="sprvarevlist_l.sortfilter" aria-checked="true">최신순 정렬하기</button>
          <article data-shp-contents-type="review">
            <span>★ 4</span>
            <p data-shp-area="sprvarevlist_l.review">혼합 노드가 있어도 전체 목록에서 새로 확인한 충분히 긴 리뷰입니다.</p>
          </article>
        </section>
      `;
    });

    expect(collector.hasOnlyNaverSummaryReviews()).toBe(false);
    await expect(collector.openFullNaverReviewList(undefined, 1)).resolves.toBe(true);
    expect(document.body.textContent).toContain("혼합 노드가 있어도");
  });

  it("loads the review area before deciding whether Naver only exposed summary reviews", async () => {
    document.body.innerHTML = `<button id="review-tab">리뷰 12</button>`;
    document.querySelector("#review-tab")!.addEventListener("click", () => {
      document.body.innerHTML = `
        <article data-shp-contents-type="review" data-shp-area="sprvsub.topreview">
          <span>★ 5</span>
          <p>리뷰 탭을 연 뒤에 나타난 대표 리뷰의 충분히 긴 본문입니다.</p>
        </article>
        <a data-shp-area="sprvsub.rvmore">리뷰 1,204</a>
        <button data-shp-area="sprvsub.topreviewmore">리뷰 전체보기</button>
      `;
      document
        .querySelector("button[data-shp-area='sprvsub.topreviewmore']")!
        .addEventListener("click", () => {
          document.body.innerHTML = `
            <section role="dialog">
              <button data-shp-area="sprvarevlist_l.sortfilter" aria-checked="true">최신순 정렬하기</button>
              <article data-shp-contents-type="review">
                <span>★ 4</span>
                <p data-shp-area="sprvarevlist_l.review">전체 목록 버튼을 통해 확인한 새로운 리뷰의 충분히 긴 본문입니다.</p>
              </article>
            </section>
          `;
        });
    });

    await expect(
      collector.prepareReviewArea(
        { reviewTabSelectors: ["#review-tab"] },
        { id: "ordering-regression" },
        1,
      ),
    ).resolves.toBe(true);
    expect(collector.hasOnlyNaverSummaryReviews()).toBe(false);
    expect(document.body.textContent).toContain("전체 목록 버튼");
  });

  it("reads only Naver full-list reviews and keeps the rating from each review card", () => {
    document.body.innerHTML = `
      <section role="dialog">
        <button data-shp-area="sprvarevlist_l.sortfilter" aria-checked="true">최신순 정렬하기</button>
        <div>5점 (최고예요) 1건</div>
        <div>4점 (좋아요) 1건</div>
        <div>3점 (괜찮아요) 0건</div>
        <div>2점 (그저 그래요) 0건</div>
        <div>1점 (별로예요) 0건</div>
        <article data-shp-contents-id="five-star-review">
          <span aria-label="별점 5점"></span>
          <time>2026.08.08.</time>
          <p data-shp-area="sprvarevlist_l.review">본문에 평점 1점이라는 말이 있어도 실제 카드 별점은 5점입니다.</p>
        </article>
        <article data-shp-contents-id="four-star-review">
          <span aria-label="별점 4점"></span>
          <time>2026.08.07.</time>
          <p data-shp-area="sprvarevlist_l.review">구성이 알차고 아이가 좋아하지만 가격은 조금 아쉬워요.</p>
        </article>
        <aside data-shp-area="sprvartopspick_l.list">
          <p>스토어 PICK 대표 리뷰는 실제 목록에 포함하지 않습니다.</p>
        </aside>
      </section>
    `;

    const distribution = collector.readNaverRatingDistribution();
    const reviews = collector.readVisibleNaverReviews({
      duplicateBodies: new Set(),
      seenKeys: new Set(),
    });

    expect(distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
    expect(reviews).toHaveLength(2);
    expect(reviews.map(({ id, rating }) => ({ id, rating }))).toEqual([
      { id: "five-star-review", rating: 5 },
      { id: "four-star-review", rating: 4 },
    ]);
    expect(collector.validateNaverCollection(reviews, distribution!)).toEqual({ ok: true });
  });

  it("rejects a Naver collection that contradicts the source rating distribution", () => {
    const validation = collector.validateNaverCollection(
      [{ rating: 5 }, { rating: 1 }],
      { 5: 1, 4: 0, 3: 0, 2: 0, 1: 0 },
    );
    expect(validation).toMatchObject({
      ok: false,
      reason: "naver_rating_distribution_mismatch",
    });
  });

  it("rejects the previously observed partial sample instead of publishing it", () => {
    const reviews = [
      ...Array.from({ length: 8 }, () => ({ rating: 5 })),
      ...Array.from({ length: 3 }, () => ({ rating: 4 })),
      { rating: 3 },
    ];
    const validation = collector.validateNaverCollection(
      reviews,
      { 5: 100, 4: 4, 3: 2, 2: 0, 1: 0 },
    );
    expect(validation).toMatchObject({
      ok: false,
      reason: "naver_collection_incomplete",
    });
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
