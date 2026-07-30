import type { BrowserContext, Page } from "playwright-core";
import type { CollectorConfig } from "./config.js";
import type { CollectionOutcome, CollectorJob } from "./types.js";
import { collectNaverReviews } from "./adapters/naver.js";
import {
  isAllowedNavigationUrl,
  isAllowedProductUrl,
  isKnownLoginUrl,
} from "./url-safety.js";

const CAPTCHA_PATTERN =
  /captcha|자동입력|보안문자|로봇이 아닙니다|보안 확인을 완료|실제 사용자임을 확인|빈 칸을 채워주세요/i;
const LOGIN_PATTERN = /로그인 후|로그인이 필요|login required/i;
const ACCESS_BLOCKED_PATTERN = /access denied|접근이 제한|비정상적인 접근|요청을 처리할 수 없습니다/i;
const PRODUCT_UNAVAILABLE_PATTERN = /판매 종료|상품이 존재하지|삭제된 상품|페이지를 찾을 수 없습니다/i;
const SITE_ERROR_PATTERN = /시스템\s*오류|에러페이지|일시적인 오류가 발생/i;

export function classifyPageInterruption(text: string, title = ""): CollectionOutcome | null {
  if (CAPTCHA_PATTERN.test(text)) {
    return { kind: "interrupted", reason: "captcha" };
  }
  if (ACCESS_BLOCKED_PATTERN.test(text)) {
    return { kind: "interrupted", reason: "access_blocked" };
  }
  if (LOGIN_PATTERN.test(text)) {
    return { kind: "interrupted", reason: "login_required" };
  }
  if (PRODUCT_UNAVAILABLE_PATTERN.test(text)) {
    return { kind: "failed", code: "product_unavailable" };
  }
  if (SITE_ERROR_PATTERN.test(`${title} ${text}`)) {
    return { kind: "interrupted", reason: "operator_required" };
  }
  return null;
}

async function pageText(page: Page) {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

export async function collectClaimedJob(
  context: BrowserContext,
  job: CollectorJob,
  config: Pick<CollectorConfig, "navigationTimeoutMs">,
  options?: {
    afterCollect?: (page: Page, outcome: CollectionOutcome) => Promise<void>;
  },
): Promise<CollectionOutcome> {
  if (!isAllowedProductUrl(job.product.canonicalUrl)) {
    return { kind: "failed", code: "unsupported_redirect" };
  }
  const page = await context.newPage();
  let blockedRedirect = false;
  try {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !isAllowedNavigationUrl(request.url())
      ) {
        blockedRedirect = true;
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(job.product.canonicalUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    if (isKnownLoginUrl(page.url())) {
      return { kind: "interrupted", reason: "login_required" };
    }
    if (!isAllowedProductUrl(page.url())) {
      return { kind: "failed", code: "unsupported_redirect" };
    }

    const text = await pageText(page);
    let outcome: CollectionOutcome;
    const interruption = classifyPageInterruption(text, await page.title());
    if (interruption) {
      outcome = interruption;
      await options?.afterCollect?.(page, outcome);
      return outcome;
    }
    if (job.product.source === "naver") {
      outcome = await collectNaverReviews(page);
      await options?.afterCollect?.(page, outcome);
      return outcome;
    }
    outcome = { kind: "failed", code: "adapter_not_implemented" };
    await options?.afterCollect?.(page, outcome);
    return outcome;
  } catch (error) {
    if (blockedRedirect) return { kind: "failed", code: "unsupported_redirect" };
    if (error instanceof Error && /Timeout/i.test(error.name + error.message)) {
      return { kind: "failed", code: "browser_timeout" };
    }
    return { kind: "failed", code: "collection_failed" };
  } finally {
    await page.close().catch(() => undefined);
  }
}
