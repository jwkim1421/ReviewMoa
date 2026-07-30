import type { Page } from "playwright-core";
import type {
  CollectionOutcome,
  CollectorReview,
  ReviewClassification,
} from "../types.js";

export const NAVER_REVIEW_ITEM_SELECTOR = [
  "[data-review-id]",
  "[data-review-no]",
  "[data-shp-contents-type='review']",
  "[data-shp-area*='review'] li",
  "li[class*='ReviewList_review_item']",
  "div[class*='ReviewList_review_item']",
  "li[class*='review_item']",
  "div[class*='review_item']",
  "li[class*='purchase_review']",
].join(",");

const REVIEW_TAB_SELECTORS = [
  "a[href*='#REVIEW']",
  "a[href*='review']",
  "button[data-shp-area*='review']",
  "a[data-shp-area*='review']",
];
const FULL_REVIEW_SELECTORS = [
  "a[data-shp-area='sprvsub.rvmore']",
];
const NEXT_SELECTORS = [
  "button[aria-label='다음']",
  "a[aria-label='다음']",
  "button[aria-label*='다음 페이지']",
  "a[aria-label*='다음 페이지']",
];
const RATINGS = [5, 4, 3, 2, 1] as const;
const MAX_INCLUDED_PER_RATING = 100;
const MAX_SCANNED_REVIEWS = 3_000;
const MAX_PAGE_ATTEMPTS = 40;

interface ExtractedReview {
  id?: string;
  rating: number;
  content: string;
  createdAt?: string;
  option?: string;
}

export function extractNaverReviewNodes(nodes: Element[]): ExtractedReview[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const textOf = (element: Element | null) => normalize(element?.textContent ?? "");
  const firstText = (node: Element, selectors: string[]) => {
    for (const selector of selectors) {
      const candidates = Array.from(node.querySelectorAll(selector))
        .filter((element) =>
          selector !== "span" ||
          !Array.from(element.querySelectorAll("span"))
            .some((child) => textOf(child).length >= 10)
        )
        .map(textOf)
        .filter((text) => text.length >= 10 && text.length <= 5_000)
        .sort((left, right) => right.length - left.length);
      if (candidates[0]) return candidates[0];
    }
    return "";
  };
  const ratingOf = (node: Element) => {
    const direct = [
      node.getAttribute("data-rating"),
      node.getAttribute("data-score"),
      node.getAttribute("data-star"),
      node.querySelector("[data-rating]")?.getAttribute("data-rating"),
      node.querySelector("[data-score]")?.getAttribute("data-score"),
    ].map(Number).find((value) => Number.isFinite(value) && value >= 1 && value <= 5);
    if (direct) return Math.round(direct);

    const ratingText = [
      node.getAttribute("aria-label"),
      ...Array.from(node.querySelectorAll(
        "[aria-label*='점'], [aria-label*='별'], [title*='점'], [class*='rating'], [class*='Rating']",
      )).map((element) =>
        [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.textContent,
        ].filter(Boolean).join(" ")
      ),
      node.textContent,
    ].filter(Boolean).join(" ");
    const match = ratingText.match(
      /(?:별점|평점|별)\s*([1-5](?:\.\d)?)(?:\s*점)?|([1-5](?:\.\d)?)\s*(?:점|\/\s*5|개)/,
    );
    if (match) return Math.round(Number(match[1] ?? match[2]));

    const width = Array.from(node.querySelectorAll<HTMLElement>(
      "[class*='star'] [style*='width'], [class*='Star'] [style*='width']",
    )).map((element) => Number.parseFloat(element.style.width))
      .find((value) => Number.isFinite(value) && value >= 20 && value <= 100);
    return width ? Math.round(width / 20) : 0;
  };
  const dateOf = (node: Element) => {
    const value = textOf(node.querySelector("time")) || textOf(node);
    const full = value.match(/20\d{2}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/);
    if (full) {
      const [year, month, day] = full[0].split(/[.\-/]\s*/).map(Number);
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    const short = value.match(/(?:^|\s)(\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\.|\s|$)/);
    if (!short) return undefined;
    return `20${short[1]}-${short[2].padStart(2, "0")}-${short[3].padStart(2, "0")}`;
  };

  const reviews: ExtractedReview[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const content = firstText(node, [
      "[data-review-content]",
      "[class*='review_text']",
      "[class*='reviewText']",
      "[class*='review_content']",
      "[class*='ReviewContent']",
      "[class*='ReviewList_text']",
      "[class*='content']",
      "p",
      "span",
    ]);
    const rating = ratingOf(node);
    if (!content || rating < 1 || rating > 5) continue;

    const id = node.getAttribute("data-review-id") ??
      node.getAttribute("data-review-no") ??
      node.getAttribute("data-shp-contents-id") ??
      node.querySelector("[data-review-id]")?.getAttribute("data-review-id") ??
      node.querySelector("[data-review-no]")?.getAttribute("data-review-no") ??
      node.querySelector("[data-shp-contents-id]")?.getAttribute("data-shp-contents-id") ??
      (node.id || undefined);
    const createdAt = dateOf(node);
    const key = id || `${rating}:${createdAt ?? ""}:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const optionElement = node.querySelector(
      "[data-review-option], [class*='option'], [class*='Option']",
    );
    reviews.push({
      id,
      rating,
      content,
      createdAt,
      option: textOf(optionElement) || undefined,
    });
  }
  return reviews;
}

function hashText(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function fingerprint(value: string) {
  return value.toLowerCase().replace(/[^0-9a-z가-힣]/g, "").slice(0, 1_200);
}

function classify(
  review: ExtractedReview,
  duplicateBodies: Set<string>,
): ReviewClassification {
  const sponsoredWords = [
    "체험단",
    "협찬",
    "무료 제공",
    "제품을 제공받",
    "원고료",
    "광고입니다",
  ];
  const positiveWords = ["좋아요", "만족", "추천", "빠르", "편해", "훌륭", "재구매"];
  const negativeWords = ["별로", "불량", "실망", "느려", "파손", "반품", "고장", "아쉽"];
  const normalized = review.content.toLowerCase();
  const bodyFingerprint = fingerprint(normalized);
  let classification: ReviewClassification = "included";
  if (sponsoredWords.some((word) => normalized.includes(word.toLowerCase()))) {
    classification = "sponsored";
  } else if (duplicateBodies.has(bodyFingerprint)) {
    classification = "duplicate";
  } else if (
    review.rating >= 4 &&
    negativeWords.filter((word) => normalized.includes(word)).length >= 2
  ) {
    classification = "rating_mismatch";
  } else if (
    review.rating <= 2 &&
    positiveWords.filter((word) => normalized.includes(word)).length >= 2
  ) {
    classification = "rating_mismatch";
  }
  duplicateBodies.add(bodyFingerprint);
  return classification;
}

export function selectNaverReviews(rows: ExtractedReview[], pageUrl: string) {
  const duplicateBodies = new Set<string>();
  const classified = rows.map((review, index): CollectorReview => ({
    id: review.id ??
      `${pageUrl}#review-${hashText(`${review.content}:${review.createdAt ?? ""}:${index}`)}`,
    rating: review.rating as CollectorReview["rating"],
    content: review.content,
    createdAt: review.createdAt,
    option: review.option,
    classification: classify(review, duplicateBodies),
  }));

  return RATINGS.flatMap((rating) => {
    const ratingRows = classified
      .filter((review) => review.rating === rating)
      .sort((left, right) =>
        (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
      );
    const selected: CollectorReview[] = [];
    let included = 0;
    for (const review of ratingRows) {
      selected.push(review);
      if (review.classification === "included" || review.classification === "uncertain") {
        included += 1;
      }
      if (included >= MAX_INCLUDED_PER_RATING) break;
    }
    return selected;
  });
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const elements = page.locator(selector);
    const count = await elements.count();
    for (let index = 0; index < count; index += 1) {
      const element = elements.nth(index);
      if (
        await element.isVisible().catch(() => false) &&
        await element.isEnabled().catch(() => false)
      ) {
        await element.click();
        return true;
      }
    }
  }
  return false;
}

async function clickTextControl(page: Page, pattern: RegExp) {
  const controls = page.locator("button, a, [role='button']").filter({ hasText: pattern });
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (
      await control.isVisible().catch(() => false) &&
      await control.isEnabled().catch(() => false)
    ) {
      await control.click();
      return true;
    }
  }
  return false;
}

async function waitForReviewItems(page: Page, timeoutMs = 4_000) {
  const items = page.locator(NAVER_REVIEW_ITEM_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await items.count()) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForFullReviewItems(page: Page, timeoutMs = 5_000) {
  const items = page.locator(
    "[data-shp-contents-type='review']:not([data-shp-area='sprvsub.topreview'])",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await items.count()) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function openFullReviewList(page: Page) {
  if (
    await clickFirstVisible(page, FULL_REVIEW_SELECTORS) &&
    await waitForFullReviewItems(page)
  ) {
    return true;
  }
  if (
    await clickTextControl(page, /^리뷰\s*[\d,]+$/) &&
    await waitForFullReviewItems(page)
  ) {
    return true;
  }
  return await clickFirstVisible(page, [
    "button[data-shp-area='sprvsub.topreviewmore']",
  ]) && await waitForFullReviewItems(page);
}

async function bodyText(page: Page) {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

async function reviewPageSignature(page: Page) {
  const rows = await page.locator(NAVER_REVIEW_ITEM_SELECTOR)
    .evaluateAll(extractNaverReviewNodes);
  return rows.slice(0, 5)
    .map((review) => review.id ?? `${review.rating}:${review.content}`)
    .join("|");
}

async function waitForReviewChange(page: Page, before: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const after = await reviewPageSignature(page);
    if (after && after !== before) return true;
  }
  return false;
}

export async function collectNaverReviews(
  page: Page,
): Promise<CollectionOutcome> {
  const fullListReady = await openFullReviewList(page);

  let hasItems = fullListReady || await waitForReviewItems(page, 1_000);
  if (!hasItems) {
    const opened = await clickFirstVisible(page, REVIEW_TAB_SELECTORS) ||
      await clickTextControl(page, /^(리뷰|구매평|상품평)(\s*[\d,]+)?$/);
    if (opened) hasItems = await waitForReviewItems(page);
  }

  if (!hasItems) {
    const text = await bodyText(page);
    if (/(등록된|작성된|해당하는)?\s*(리뷰|구매평|상품평).{0,12}(없습니다|없어요|0개)/.test(text)) {
      return { kind: "completed", reviews: [] };
    }
    return { kind: "failed", code: "review_area_not_found" };
  }

  const newestApplied = await clickTextControl(page, /^(최신순|최근순|최신 등록순)$/);
  if (newestApplied) await page.waitForTimeout(700);

  const extracted: ExtractedReview[] = [];
  const seenPageSignatures = new Set<string>();
  for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt += 1) {
    const pageRows = await page.locator(NAVER_REVIEW_ITEM_SELECTOR)
      .evaluateAll(extractNaverReviewNodes);
    const signature = pageRows.slice(0, 5)
      .map((review) => review.id ?? `${review.rating}:${review.content}`)
      .join("|");
    if (signature && seenPageSignatures.has(signature)) break;
    if (signature) seenPageSignatures.add(signature);
    extracted.push(...pageRows.slice(0, MAX_SCANNED_REVIEWS - extracted.length));

    const selected = selectNaverReviews(extracted, page.url());
    const enough = RATINGS.every((rating) =>
      selected.filter((review) =>
        review.rating === rating &&
        (review.classification === "included" || review.classification === "uncertain")
      ).length >= MAX_INCLUDED_PER_RATING
    );
    if (enough || extracted.length >= MAX_SCANNED_REVIEWS) break;

    const advanced = await clickFirstVisible(page, NEXT_SELECTORS) ||
      await clickTextControl(page, /^(다음|다음 페이지|더보기|리뷰 더보기)$/);
    if (!advanced) break;
    if (!await waitForReviewChange(page, signature)) break;
  }

  const reviews = selectNaverReviews(extracted, page.url());
  if (!reviews.length) {
    return { kind: "failed", code: "review_area_not_found" };
  }
  const candidateCount = await page.locator(NAVER_REVIEW_ITEM_SELECTOR).count();
  const summaryCount = await page.locator(
    "[data-shp-contents-type='review'][data-shp-area='sprvsub.topreview']",
  ).count();
  if (summaryCount > 0 && candidateCount === summaryCount) {
    return { kind: "completed", reviews, partialReason: "summary_only" };
  }
  return { kind: "completed", reviews };
}
