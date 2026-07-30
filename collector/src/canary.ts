import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { launchCollectorBrowser } from "./browser.js";
import { collectClaimedJob } from "./collect.js";
import type { CollectorConfig } from "./config.js";
import type { CollectorJob } from "./types.js";
import { isAllowedProductUrl } from "./url-safety.js";

function canaryProduct(input: string) {
  const url = new URL(input);
  url.search = "";
  url.hash = "";
  const productId = url.pathname.match(/\/(?:products|catalog)\/(\d+)/)?.[1];
  if (!productId || !isAllowedProductUrl(url.toString())) {
    throw new Error("허용된 네이버 상품 URL이 아닙니다.");
  }
  return {
    source: "naver",
    sourceLabel: "네이버",
    productId,
    canonicalUrl: url.toString(),
  };
}

function canaryConfig(): CollectorConfig {
  const profileDir = resolve(
    process.env.REVIEWMOA_PROFILE_DIR ??
      join(homedir(), "Library", "Application Support", "ReviewMoa", "chrome-profile"),
  );
  return {
    apiBase: "https://canary.invalid",
    token: "canary-not-used",
    collectorId: "local-canary",
    profileDir,
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    navigationTimeoutMs: 60_000,
    headless: process.env.REVIEWMOA_HEADLESS === "true",
    runOnce: true,
  };
}

const input = process.argv[2];
if (!input) {
  throw new Error("사용법: npm run collector:canary -- <네이버 상품 URL>");
}

const config = canaryConfig();
const product = canaryProduct(input);
const now = new Date().toISOString();
const job: CollectorJob = {
  id: `canary-${product.productId}`,
  cacheKey: `naver:${product.productId}:all`,
  product,
  status: "collecting",
  requestedAt: now,
  startedAt: now,
  claimedBy: config.collectorId,
  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  heartbeatAt: now,
  attemptCount: 1,
};

const context = await launchCollectorBrowser(config);
try {
  let diagnostics: Record<string, unknown> | undefined;
  const outcome = await collectClaimedJob(context, job, config, {
    async afterCollect(page, result) {
      if (result.kind !== "failed") return;
      const reviewElements = await page.locator(
        "button, a, [role='button'], h1, h2, h3, [class*='review'], [class*='Review'], [id*='review'], [id*='Review'], [data-shp-area*='review']",
      ).evaluateAll((elements) =>
        elements
          .filter((element) => /리뷰|구매평|상품평|review/i.test(
            [
              element.textContent,
              element.id,
              element.className,
              element.getAttribute("aria-label"),
              element.getAttribute("data-shp-area"),
            ].filter(Boolean).join(" "),
          ))
          .slice(0, 30)
          .map((element) => ({
            tag: element.tagName,
            id: element.id || undefined,
            className: typeof element.className === "string"
              ? element.className.slice(0, 240)
              : undefined,
            ariaLabel: element.getAttribute("aria-label") ?? undefined,
            dataShpArea: element.getAttribute("data-shp-area") ?? undefined,
            href: element.getAttribute("href") ?? undefined,
            ariaControls: element.getAttribute("aria-controls") ?? undefined,
            text: element.getAttribute("data-shp-contents-type") === "review"
              ? "[review content omitted]"
              : element.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
          }))
      );
      diagnostics = {
        finalUrl: page.url(),
        title: await page.title(),
        layout: await page.evaluate(() => {
          const fullReview = document.querySelector(
            "[data-shp-area='sprvsub.rvmore']",
          )?.getBoundingClientRect();
          const reviewTab = document.querySelector(
            "[data-shp-area='tab.select']",
          )?.getBoundingClientRect();
          return {
            scrollY: window.scrollY,
            innerHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
            fullReviewTop: fullReview?.top,
            reviewTabTop: reviewTab?.top,
          };
        }),
        frames: page.frames().map((frame) => {
          const frameUrl = frame.url();
          if (frameUrl === "about:blank") return frameUrl;
          try {
            const parsed = new URL(frameUrl);
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return "unknown";
          }
        }),
        reviewElements,
      };
    },
  });
  if (outcome.kind !== "completed") {
    console.log(JSON.stringify({
      url: product.canonicalUrl,
      outcome: outcome.kind,
      reason: "reason" in outcome ? outcome.reason : outcome.code,
      diagnostics,
    }, null, 2));
  } else {
    const ratingCounts = Object.fromEntries(
      [5, 4, 3, 2, 1].map((rating) => [
        rating,
        outcome.reviews.filter((review) => review.rating === rating).length,
      ]),
    );
    const classificationCounts = Object.fromEntries(
      ["included", "sponsored", "duplicate", "rating_mismatch", "uncertain"].map(
        (classification) => [
          classification,
          outcome.reviews.filter((review) => review.classification === classification).length,
        ],
      ),
    );
    console.log(JSON.stringify({
      url: product.canonicalUrl,
      outcome: outcome.kind,
      partialReason: outcome.partialReason,
      reviewCount: outcome.reviews.length,
      ratingCounts,
      classificationCounts,
      samples: outcome.reviews.slice(0, 3).map((review) => ({
        id: review.id,
        rating: review.rating,
        createdAt: review.createdAt,
        option: review.option,
        content: review.content.slice(0, 160),
      })),
    }, null, 2));
  }
} finally {
  await context.close();
}
