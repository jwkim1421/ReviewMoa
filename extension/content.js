const COMMON_REVIEW_SELECTORS = [
  "[data-review-id]",
  "[data-review-no]",
  "[data-shp-contents-type='review']",
  "[class*='review-item']",
  "[class*='ReviewItem']",
  "[class*='review_list'] > li",
  "[class*='reviewList'] > li",
  "[id*='review'] li",
  "[id*='Review'] li",
];

const SPONSORED_WORDS = ["체험단", "협찬", "무료 제공", "제품을 제공받", "원고료", "광고입니다"];
const POSITIVE_WORDS = ["좋아요", "만족", "추천", "빠르", "편해", "훌륭", "재구매"];
const NEGATIVE_WORDS = ["별로", "불량", "실망", "느려", "파손", "반품", "고장", "아쉽"];
const RATINGS = [5, 4, 3, 2, 1];
const MAX_INCLUDED_PER_RATING = 100;
const MAX_SCANNED_PER_RATING = 300;
const MAX_SCANNED_WITHOUT_FILTER = 3000;
const MAX_PAGE_ATTEMPTS = 40;
const COLLECTION_OVERLAY_ID = "reviewmoa-collection-overlay";
const NAVER_REVIEW_BODY_SELECTOR = "[data-shp-area='sprvarevlist_l.review']";
const NAVER_SORT_SELECTOR = "[data-shp-area='sprvarevlist_l.sortfilter']";
let operatorWatchTimer;
let activeCollection;
let fullReviewDiagnostics;

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "REVIEWMOA_PROBE_AND_COLLECT") return;
    collectAndReport(message.job).then(sendResponse);
    return true;
  });

  void chrome.runtime.sendMessage({
    type: "REVIEWMOA_PRODUCT_READY",
    url: location.href,
  }).then((response) => {
    if (response?.job) return collectAndReport(response.job);
  }).catch(() => undefined);
}

async function collectAndReport(job) {
  try {
    const result = await runCollection(job);
    await chrome.runtime.sendMessage({
      type: "REVIEWMOA_COLLECTION_RESULT",
      payload: result,
    });
    return result;
  } catch (error) {
    const result = {
      jobId: job.id,
      status: "failed",
      reason: error instanceof Error ? error.message : "collection_failed",
      message: "상품 페이지에서 리뷰 수집을 시작하지 못했습니다.",
    };
    await chrome.runtime.sendMessage({
      type: "REVIEWMOA_COLLECTION_RESULT",
      payload: result,
    });
    return result;
  }
}

function runCollection(job) {
  if (activeCollection) return activeCollection;
  const interruption = detectInterruption();
  if (interruption) {
    hideCollectionOverlay();
    if (
      job.mode === "mobile-handoff" &&
      ["captcha", "login_required", "access_limited"].includes(interruption.reason)
    ) {
      watchForOperatorCompletion(job, interruption.reason);
    }
    return Promise.resolve({ jobId: job.id, ...interruption, url: location.href });
  }
  showCollectionOverlay("상품과 리뷰 영역을 확인하고 있어요.");
  activeCollection = collect(job)
    .then((result) => {
      if (
        job.mode === "mobile-handoff" &&
        ["waiting_for_login", "waiting_for_user"].includes(result.status) &&
        ["captcha", "login_required", "access_limited", "review_area_not_found"].includes(
          result.reason,
        )
      ) {
        hideCollectionOverlay();
        watchForOperatorCompletion(job, result.reason);
      } else if (["completed", "partial"].includes(result.status)) {
        updateCollectionOverlay("리뷰 수집을 마쳤어요. 결과를 정리하고 있어요.");
      }
      return result;
    })
    .catch((error) => {
      hideCollectionOverlay();
      throw error;
    })
    .finally(() => {
      activeCollection = null;
    });
  return activeCollection;
}

function showCollectionOverlay(message) {
  let host = document.getElementById(COLLECTION_OVERLAY_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = COLLECTION_OVERLAY_ID;
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          padding: 24px;
          background: rgba(24, 31, 28, .58);
          -webkit-backdrop-filter: blur(5px);
          backdrop-filter: blur(5px);
          touch-action: none;
          overscroll-behavior: contain;
          cursor: wait;
        }
        .card {
          width: min(320px, calc(100vw - 48px));
          padding: 30px 24px 27px;
          border-radius: 22px;
          color: #27241f;
          background: #fffdf8;
          box-shadow: 0 22px 60px rgba(0, 0, 0, .28);
          text-align: center;
          font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
            "Noto Sans KR", sans-serif;
        }
        .spinner {
          width: 46px;
          height: 46px;
          margin: 0 auto 20px;
          border: 4px solid rgba(49, 92, 76, .18);
          border-top-color: #315c4c;
          border-radius: 50%;
          animation: reviewmoa-spin .85s linear infinite;
        }
        strong { display: block; font-size: 20px; }
        p { min-height: 42px; margin: 10px 0 0; color: #756f65; font-size: 14px; line-height: 1.5; }
        small { display: block; margin-top: 17px; color: #a39b90; font-size: 11px; }
        @keyframes reviewmoa-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="card">
        <div class="spinner" aria-hidden="true"></div>
        <strong>리뷰 수집 중…</strong>
        <p></p>
        <small>수집이 끝나면 리뷰모아로 자동으로 돌아갑니다.</small>
      </div>
    `;
    document.documentElement.append(host);
  }
  updateCollectionOverlay(message);
}

function updateCollectionOverlay(message) {
  const paragraph = document.getElementById(COLLECTION_OVERLAY_ID)
    ?.shadowRoot
    ?.querySelector("p");
  if (paragraph && typeof message === "string" && message) {
    paragraph.textContent = message;
  }
}

function hideCollectionOverlay() {
  document.getElementById(COLLECTION_OVERLAY_ID)?.remove();
}

function watchForOperatorCompletion(job, reason) {
  if (operatorWatchTimer) clearInterval(operatorWatchTimer);
  let clearChecks = 0;
  operatorWatchTimer = setInterval(() => {
    if (detectInterruption()) {
      clearChecks = 0;
      return;
    }
    const text = document.body?.innerText?.slice(0, 12_000) ?? "";
    const productReady = reason === "review_area_not_found"
      ? findReviewNodes(globalThis.REVIEWMOA_GET_SITE_CONFIG?.()).length > 0
      : allowedNaverProductPage(location.href) &&
        /리뷰|상세정보|상품정보|판매자정보/.test(text) &&
        !/시스템\s*오류|에러페이지/.test(`${document.title} ${text}`);
    clearChecks = productReady ? clearChecks + 1 : 0;
    if (clearChecks < 2 || activeCollection) return;
    clearInterval(operatorWatchTimer);
    operatorWatchTimer = undefined;
    void runCollection(job).then((result) =>
      chrome.runtime.sendMessage({
        type: "REVIEWMOA_COLLECTION_RESULT",
        payload: result,
      })
    );
  }, 1_500);
}

function allowedNaverProductPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /\/(?:products|catalog)\/\d+/.test(url.pathname) &&
      (
        url.hostname === "smartstore.naver.com" ||
        url.hostname === "brand.naver.com" ||
        url.hostname.endsWith(".shopping.naver.com")
      );
  } catch {
    return false;
  }
}

async function collect(job) {
  const interruption = detectInterruption();
  if (interruption) {
    return { jobId: job.id, ...interruption, url: location.href };
  }

  const config = globalThis.REVIEWMOA_GET_SITE_CONFIG?.();
  const product = readProduct();
  if (isNaverPage()) return collectNaver(job, config, product);
  const hasReviewArea = await prepareReviewArea(config, job);
  if (!hasReviewArea) {
    return {
      jobId: job.id,
      status: "waiting_for_user",
      reason: "review_area_not_found",
      message: "상품 페이지에서 리뷰 탭을 직접 연 뒤 ‘다시 확인’을 눌러 주세요.",
      product,
      capability: probeReviews(config),
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }

  const newestApplied = await applyNewestSort(config);
  const supportsRatingFilter = RATINGS.every((rating) => Boolean(findRatingControl(rating, config)));
  const duplicateBodies = new Set();
  let reviews = [];

  if (supportsRatingFilter) {
    for (const rating of RATINGS) {
      const interrupted = detectInterruption();
      if (interrupted) return { jobId: job.id, ...interrupted, product, reviews };
      await notifyProgress(job, {
        status: "collecting",
        rating,
        message: `${rating}점 최신 리뷰를 확인하고 있습니다.`,
      });
      const filterApplied = await applyRatingFilter(rating, config);
      if (!filterApplied) {
        return {
          jobId: job.id,
          status: "waiting_for_user",
          reason: "rating_filter_failed",
          message: `${rating}점 필터를 직접 선택한 뒤 ‘다시 확인’을 눌러 주세요.`,
          product,
          reviews,
        };
      }
      const pageResult = await collectPages(config, {
        forcedRating: rating,
        maxScanned: MAX_SCANNED_PER_RATING,
        duplicateBodies,
        stopWhen: (items) => countIncluded(items) >= MAX_INCLUDED_PER_RATING,
        job,
      });
      if (pageResult.interruption) {
        return { jobId: job.id, ...pageResult.interruption, product, reviews: [...reviews, ...pageResult.reviews] };
      }
      reviews.push(...pageResult.reviews);
    }
  } else {
    await notifyProgress(job, {
      status: "collecting",
      message: "별점 필터가 없어 최신 리뷰를 모은 뒤 별점별로 분류하고 있습니다.",
    });
    const pageResult = await collectPages(config, {
      maxScanned: MAX_SCANNED_WITHOUT_FILTER,
      duplicateBodies,
      stopWhen: (items) => RATINGS.every((rating) =>
        countIncluded(items.filter((review) => review.rating === rating)) >= MAX_INCLUDED_PER_RATING
      ),
      job,
    });
    if (pageResult.interruption) {
      return { jobId: job.id, ...pageResult.interruption, product, reviews: pageResult.reviews };
    }
    reviews = pageResult.reviews;
  }

  reviews = selectLatestByRating(reviews);
  const capability = {
    ...probeReviews(config),
    status: "partial",
    hasReviewArea: true,
    supportsNewestSort: newestApplied,
    supportsRatingFilter,
  };
  const confirmedEmpty = reviews.length === 0 && isConfirmedEmptyReviewArea();
  if (reviews.length === 0 && !confirmedEmpty) {
    return {
      jobId: job.id,
      status: "waiting_for_user",
      reason: "reviews_not_extracted",
      message: "리뷰는 보이지만 별점과 본문을 안전하게 읽지 못했습니다. 리뷰 목록을 펼친 뒤 다시 확인해 주세요.",
      product,
      capability,
      reviews,
    };
  }
  const visibleReviewNodes = findReviewNodes(config);
  const summaryOnly =
    visibleReviewNodes.length > 0 &&
    visibleReviewNodes.every((node) =>
      node.getAttribute("data-shp-area") === "sprvsub.topreview"
    );
  return {
    jobId: job.id,
    status: summaryOnly ? "partial" : "completed",
    reason: confirmedEmpty ? "confirmed_zero_reviews" : "collection_completed",
    partialReason: summaryOnly ? "summary_only" : undefined,
    message: confirmedEmpty
      ? "정상적으로 확인한 결과 등록된 리뷰가 없습니다."
      : summaryOnly
        ? `상품 페이지에 공개된 대표 리뷰 ${reviews.length}개를 수집했습니다.`
        : `최신 리뷰 ${reviews.length}개를 수집했습니다.`,
    product,
    capability,
    collectorDiagnostics: fullReviewDiagnostics,
    reviews,
    collectedAt: new Date().toISOString(),
  };
}

async function collectNaver(job, config, product) {
  fullReviewDiagnostics = {
    adapter: "naver-mobile-v1",
    startPath: location.pathname,
    attempts: [],
  };
  const hasReviewArea = await ensureReviewArea(config);
  if (!hasReviewArea) {
    return {
      jobId: job.id,
      status: "waiting_for_user",
      reason: "review_area_not_found",
      message: "상품 페이지에서 리뷰 영역을 열지 못했습니다. 리뷰 탭을 연 뒤 다시 확인해 주세요.",
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }

  await notifyProgress(job, {
    status: "collecting",
    message: "네이버 전체 리뷰 목록을 열고 있어요.",
  });
  if (!(await openFullNaverReviewList(config))) {
    return {
      jobId: job.id,
      status: "failed",
      reason: "naver_full_review_list_not_verified",
      message: "네이버 전체 리뷰 목록이 열린 것을 확인하지 못해 잘못된 분석을 중단했습니다.",
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }

  await revealNaverRatingDistribution();
  const sourceDistribution = readNaverRatingDistribution();
  if (!sourceDistribution) {
    fullReviewDiagnostics.failure = "source_distribution_not_found";
    return {
      jobId: job.id,
      status: "failed",
      reason: "naver_source_distribution_not_found",
      message: "네이버 원본 별점 분포를 확인하지 못해 잘못된 분석을 중단했습니다.",
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }
  fullReviewDiagnostics.sourceDistribution = sourceDistribution;

  await notifyProgress(job, {
    status: "collecting",
    message: "전체 리뷰를 최신순으로 정렬하고 있어요.",
  });
  if (!(await applyNaverNewestSort())) {
    fullReviewDiagnostics.failure = "newest_sort_not_verified";
    return {
      jobId: job.id,
      status: "failed",
      reason: "naver_newest_sort_not_verified",
      message: "네이버 리뷰가 최신순으로 정렬된 것을 확인하지 못해 분석을 중단했습니다.",
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }

  const pageResult = await collectNaverPages(job, sourceDistribution);
  if (pageResult.interruption) {
    return { jobId: job.id, ...pageResult.interruption, product, reviews: pageResult.reviews };
  }
  const reviews = selectLatestByRating(pageResult.reviews);
  const validation = validateNaverCollection(pageResult.reviews, sourceDistribution);
  fullReviewDiagnostics.scanned = pageResult.scanned;
  fullReviewDiagnostics.ratingDistribution = countReviewsByRating(pageResult.reviews);
  fullReviewDiagnostics.validation = validation;
  if (!validation.ok) {
    fullReviewDiagnostics.failure = validation.reason;
    return {
      jobId: job.id,
      status: "failed",
      reason: validation.reason,
      message: validation.message,
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }

  const confirmedEmpty = reviews.length === 0 && isConfirmedEmptyReviewArea();
  if (!reviews.length && !confirmedEmpty) {
    return {
      jobId: job.id,
      status: "failed",
      reason: "naver_reviews_not_extracted",
      message: "전체 리뷰 목록은 열렸지만 리뷰 카드의 별점과 본문을 안전하게 읽지 못했습니다.",
      product,
      collectorDiagnostics: fullReviewDiagnostics,
    };
  }
  return {
    jobId: job.id,
    status: "completed",
    reason: confirmedEmpty ? "confirmed_zero_reviews" : "collection_completed",
    message: confirmedEmpty
      ? "정상적으로 확인한 결과 등록된 리뷰가 없습니다."
      : `검증된 최신 리뷰 ${reviews.length}개를 수집했습니다.`,
    product,
    capability: {
      status: "supported",
      hasReviewArea: true,
      supportsNewestSort: true,
      supportsRatingFilter: false,
    },
    collectorDiagnostics: fullReviewDiagnostics,
    reviews,
    collectedAt: new Date().toISOString(),
  };
}

function findNaverReviewBodies() {
  return [...document.querySelectorAll(NAVER_REVIEW_BODY_SELECTOR)]
    .filter((node) => isRenderedInActiveTree(node));
}

function findNaverReviewRoot() {
  const first = findNaverReviewBodies()[0];
  if (!first) return null;
  let current = first.parentElement;
  while (current && current !== document.body) {
    if (current.querySelector(NAVER_SORT_SELECTOR)) return current;
    current = current.parentElement;
  }
  return first.closest("[role='dialog']") || document.body;
}

function isNaverFullReviewListReady() {
  const bodies = findNaverReviewBodies();
  if (!bodies.length) return false;
  return bodies.some((body) => Boolean(body.closest("[role='dialog']"))) ||
    Boolean([...document.querySelectorAll(NAVER_SORT_SELECTOR)].find(isRenderedInActiveTree));
}

async function revealNaverRatingDistribution() {
  if (readNaverRatingDistribution()) return true;
  const control = [...document.querySelectorAll("button, [role='button']")].find((element) =>
    isRenderedInActiveTree(element) && /평점\s*비율\s*보기/.test(normalize(
      element.getAttribute("aria-label") || element.textContent || "",
    ))
  );
  if (!activateControl(control)) return false;
  await wait(400);
  return Boolean(readNaverRatingDistribution());
}

function readNaverRatingDistribution() {
  const root = findNaverReviewRoot() || document.body;
  const elements = [...root.querySelectorAll("button, [role='button'], li, div")]
    .filter(isRenderedInActiveTree);
  const distribution = {};
  for (const rating of RATINGS) {
    const pattern = new RegExp(`^${rating}점(?:\\s*\\([^)]*\\))?\\s*([\\d,]+)건$`);
    for (const element of elements) {
      const text = normalize(element.getAttribute("aria-label") || element.textContent || "");
      if (text.length > 80) continue;
      const match = text.match(pattern);
      if (!match) continue;
      distribution[rating] = Number(match[1].replaceAll(",", ""));
      break;
    }
  }
  if (!RATINGS.every((rating) => Number.isInteger(distribution[rating]))) return null;
  if (RATINGS.reduce((sum, rating) => sum + distribution[rating], 0) <= 0) return null;
  return distribution;
}

async function applyNaverNewestSort() {
  let control = findNaverNewestSortControl();
  if (!control) {
    const opener = [...document.querySelectorAll(
      "[data-shp-area='sprvarevlist_l.sortfilteropen']",
    )].find(isRenderedInActiveTree);
    if (activateControl(opener)) {
      await wait(300);
      control = findNaverNewestSortControl();
    }
  }
  if (!control) return visibleNaverReviewsAreNewestFirst();
  if (isSelectedControl(control)) return true;
  const before = naverReviewPageSignature();
  if (!activateControl(control)) return false;
  await wait(100);
  let current = findNaverNewestSortControl();
  if (isSelectedControl(current)) return true;
  const changed = await waitForNaverReviewChange(before, 3_500);
  current = findNaverNewestSortControl();
  return isSelectedControl(current) || changed || visibleNaverReviewsAreNewestFirst();
}

function findNaverNewestSortControl() {
  const root = findNaverReviewRoot() || document.body;
  return [...root.querySelectorAll(
    `${NAVER_SORT_SELECTOR}, button, [role='button'], a, label`,
  )].find((element) => {
    if (!isRenderedInActiveTree(element)) return false;
    const text = normalize(element.getAttribute("aria-label") || element.textContent || "");
    return /^최신순(?:\s*정렬하기)?$/.test(text);
  });
}

function visibleNaverReviewsAreNewestFirst() {
  const dates = findNaverReviewBodies()
    .map((body) => {
      const card = findNaverReviewCard(body);
      return card ? extractDate(card) : undefined;
    })
    .filter(Boolean);
  return dates.length >= 2 && dates.every((date, index) =>
    index === 0 || dates[index - 1].localeCompare(date) >= 0
  );
}

function isSelectedControl(control) {
  return Boolean(control) && (control.checked === true ||
    control.getAttribute("aria-checked") === "true" ||
    control.getAttribute("aria-selected") === "true" ||
    control.getAttribute("data-selected") === "true" ||
    /\b(active|checked|selected|on)\b/i.test(control.className || ""));
}

async function collectNaverPages(job, sourceDistribution) {
  const reviews = [];
  const seenKeys = new Set();
  const duplicateBodies = new Set();
  const targets = Object.fromEntries(RATINGS.map((rating) => [
    rating,
    Math.min(sourceDistribution[rating], 100),
  ]));
  let scanned = 0;
  let stalled = 0;

  for (let page = 1; page <= MAX_PAGE_ATTEMPTS && scanned < MAX_SCANNED_WITHOUT_FILTER; page += 1) {
    const interruption = detectInterruption();
    if (interruption) return { reviews, scanned, interruption };
    const visible = readVisibleNaverReviews({ seenKeys, duplicateBodies });
    scanned += visible.length;
    for (const review of visible) {
      const retained = reviews.filter((item) => item.rating === review.rating).length;
      const sourceCount = sourceDistribution[review.rating];
      const retainLimit = sourceCount <= 100 ? sourceCount + 1 : targets[review.rating];
      if (retained < retainLimit) reviews.push(review);
    }
    await notifyProgress(job, {
      status: "collecting",
      page,
      collected: reviews.length,
      scanned,
      message: `네이버 리뷰 ${scanned}개를 확인하고 별점별로 검증하고 있어요.`,
    });
    if (reachedNaverCollectionTarget(reviews, sourceDistribution)) break;

    const before = naverReviewPageSignature();
    const advanced = await advanceNaverReviews();
    const after = naverReviewPageSignature();
    stalled = !advanced || after === before ? stalled + 1 : 0;
    if (stalled >= 2) break;
  }
  return { reviews, scanned };
}

function readVisibleNaverReviews(options) {
  const results = [];
  for (const [index, body] of findNaverReviewBodies().entries()) {
    const content = normalize(body.textContent || "");
    if (content.length < 10 || content.length > 5000) continue;
    const card = findNaverReviewCard(body);
    const rating = card ? extractNaverCardRating(card) : null;
    if (!RATINGS.includes(rating)) continue;
    const createdAt = card ? extractDate(card) : undefined;
    const sourceId = findNaverReviewSourceId(body, card);
    const key = sourceId || `${rating}:${createdAt || ""}:${hashText(normalize(card?.textContent || content))}`;
    if (options.seenKeys.has(key)) continue;
    options.seenKeys.add(key);

    const bodyFingerprint = fingerprint(content);
    let classification = "included";
    const lower = content.toLowerCase();
    if (SPONSORED_WORDS.some((word) => lower.includes(word.toLowerCase()))) {
      classification = "sponsored";
    } else if (options.duplicateBodies.has(bodyFingerprint)) {
      classification = "duplicate";
    } else if (rating >= 4 && NEGATIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    } else if (rating <= 2 && POSITIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    }
    options.duplicateBodies.add(bodyFingerprint);
    results.push({
      id: sourceId || `${location.href}#naver-review-${hashText(`${content}:${index}`)}`,
      rating,
      content,
      createdAt,
      option: card ? extractOption(card) : undefined,
      classification,
    });
  }
  return results;
}

function findNaverReviewCard(body) {
  let current = body.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    if (current.querySelectorAll(NAVER_REVIEW_BODY_SELECTOR).length !== 1) continue;
    if (RATINGS.includes(extractNaverCardRating(current))) return current;
  }
  return null;
}

function extractNaverCardRating(card) {
  const clone = card.cloneNode(true);
  clone.querySelectorAll(NAVER_REVIEW_BODY_SELECTOR).forEach((node) => node.remove());
  return extractRating(clone);
}

function findNaverReviewSourceId(body, card) {
  for (const node of [body, card, body.parentElement]) {
    if (!node) continue;
    const value = node.getAttribute("data-review-id") ||
      node.getAttribute("data-review-no") ||
      node.getAttribute("data-shp-contents-id");
    if (value) return value;
  }
  return undefined;
}

function countReviewsByRating(reviews) {
  return Object.fromEntries(RATINGS.map((rating) => [
    rating,
    reviews.filter((review) => review.rating === rating).length,
  ]));
}

function reachedNaverCollectionTarget(reviews, sourceDistribution) {
  const counts = countReviewsByRating(reviews);
  return RATINGS.every((rating) => counts[rating] >= Math.min(sourceDistribution[rating], 100));
}

function validateNaverCollection(reviews, sourceDistribution) {
  const counts = countReviewsByRating(reviews);
  for (const rating of RATINGS) {
    if (counts[rating] > sourceDistribution[rating]) {
      return {
        ok: false,
        reason: "naver_rating_distribution_mismatch",
        message: `네이버 원본에는 ${rating}점 리뷰가 ${sourceDistribution[rating]}개인데 ${counts[rating]}개가 감지되어 분석을 중단했습니다.`,
      };
    }
    const target = Math.min(sourceDistribution[rating], 100);
    if (counts[rating] < target) {
      return {
        ok: false,
        reason: "naver_collection_incomplete",
        message: `네이버 ${rating}점 리뷰 ${target}개 중 ${counts[rating]}개만 확인되어 불완전한 분석을 중단했습니다.`,
      };
    }
  }
  return { ok: true };
}

function naverReviewPageSignature() {
  const bodies = findNaverReviewBodies();
  return `${bodies.length}:` + bodies.slice(-5)
    .map((node) => hashText(normalize(node.parentElement?.textContent || node.textContent || "")))
    .join(":");
}

async function waitForNaverReviewChange(before, timeout = 2_800) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await wait(200);
    const after = naverReviewPageSignature();
    if (after && after !== before) return true;
  }
  return false;
}

async function advanceNaverReviews() {
  const bodies = findNaverReviewBodies();
  const last = bodies.at(-1);
  if (!last) return false;
  const before = naverReviewPageSignature();
  const scrollContainer = findScrollableAncestor(last);
  last.scrollIntoView?.({ block: "end", behavior: "auto" });
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
  } else {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
  }
  return waitForNaverReviewChange(before);
}

function findScrollableAncestor(node) {
  let current = node.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 16) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isRenderedInActiveTree(element) {
  if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  let current = element;
  while (current && current !== document.documentElement) {
    if (current.hidden || current.getAttribute?.("aria-hidden") === "true") return false;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
    current = current.parentElement;
  }
  return true;
}

async function prepareReviewArea(config, job, waitTimeout = 5_000) {
  fullReviewDiagnostics = isNaverPage()
    ? {
        startPath: location.pathname,
        attempts: [],
      }
    : undefined;
  const hasReviewArea = await ensureReviewArea(config);
  if (fullReviewDiagnostics) {
    fullReviewDiagnostics.summaryDetected = hasOnlyNaverSummaryReviews(config);
  }
  if (!hasReviewArea) return false;
  if (fullReviewDiagnostics) {
    await notifyProgress(job, {
      status: "collecting",
      message: "전체 리뷰 목록을 확인하고 있어요.",
    });
    const fullListReady = await openFullNaverReviewList(config, waitTimeout);
    if (fullListReady) {
      await notifyProgress(job, {
        status: "collecting",
        message: "전체 리뷰 목록을 열었습니다. 최신순으로 정리하고 있어요.",
      });
    }
  }
  return true;
}

async function collectPages(config, options) {
  const reviews = [];
  const seenKeys = new Set();
  let stalled = 0;

  for (let page = 1; page <= MAX_PAGE_ATTEMPTS && reviews.length < options.maxScanned; page += 1) {
    const interruption = detectInterruption();
    if (interruption) return { reviews, interruption };

    const visible = readVisibleReviews(config, {
      forcedRating: options.forcedRating,
      duplicateBodies: options.duplicateBodies,
      seenKeys,
    });
    reviews.push(...visible.slice(0, Math.max(options.maxScanned - reviews.length, 0)));
    await notifyProgress(options.job, {
      status: "collecting",
      rating: options.forcedRating,
      page,
      collected: reviews.length,
      message: options.forcedRating
        ? `${options.forcedRating}점 후보 ${reviews.length}개를 검사했습니다.`
        : `전체 후보 ${reviews.length}개를 검사했습니다.`,
    });

    if (options.stopWhen(reviews) || reviews.length >= options.maxScanned) break;
    const before = reviewPageSignature(config);
    const advanced = await advanceReviews(config);
    if (!advanced) break;
    await waitForReviewChange(config, before);
    const after = reviewPageSignature(config);
    stalled = after === before && visible.length === 0 ? stalled + 1 : 0;
    if (stalled >= 2) break;
  }

  return { reviews };
}

function readVisibleReviews(config, options) {
  const results = [];
  for (const [index, node] of findReviewNodes(config).entries()) {
    const content = extractContent(node);
    if (content.length < 10) continue;
    const rating = options.forcedRating ?? extractRating(node);
    if (!RATINGS.includes(rating)) continue;
    const createdAt = extractDate(node);
    const sourceId =
      node.getAttribute("data-review-id") ||
      node.getAttribute("data-review-no") ||
      node.getAttribute("data-shp-contents-id") ||
      node.id;
    const key = sourceId || `${rating}:${createdAt || ""}:${hashText(content)}`;
    if (options.seenKeys.has(key)) continue;
    options.seenKeys.add(key);

    const bodyFingerprint = fingerprint(content);
    let classification = "included";
    const lower = content.toLowerCase();
    if (SPONSORED_WORDS.some((word) => lower.includes(word.toLowerCase()))) {
      classification = "sponsored";
    } else if (options.duplicateBodies.has(bodyFingerprint)) {
      classification = "duplicate";
    } else if (rating >= 4 && NEGATIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    } else if (rating <= 2 && POSITIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    }
    options.duplicateBodies.add(bodyFingerprint);
    results.push({
      id: sourceId || `${location.href}#review-${hashText(`${content}:${index}`)}`,
      rating,
      content,
      createdAt,
      option: extractOption(node),
      classification,
    });
  }
  return results;
}

function selectLatestByRating(reviews) {
  return RATINGS.flatMap((rating) => {
    const rows = reviews
      .filter((review) => review.rating === rating)
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const selected = [];
    for (const review of rows) {
      selected.push(review);
      if (countIncluded(selected) >= MAX_INCLUDED_PER_RATING) break;
    }
    return selected;
  });
}

function countIncluded(reviews) {
  return reviews.filter((review) => ["included", "uncertain"].includes(review.classification)).length;
}

function isNaverPage() {
  return location.hostname === "naver.com" || location.hostname.endsWith(".naver.com");
}

function hasOnlyNaverSummaryReviews(config) {
  const nodes = findReviewNodes(config);
  return nodes.length > 0 && nodes.every((node) =>
    node.getAttribute("data-shp-area") === "sprvsub.topreview"
  );
}

function findFullNaverReviewControls() {
  const controls = [
    firstUsable([
      "button[data-shp-area='sprvsub.topreviewmore']",
      "a[data-shp-area='sprvsub.topreviewmore']",
      "button[data-shp-area='sprvrpre.more']",
      "a[data-shp-area='sprvrpre.more']",
    ]),
    findControlByText(/^(?:리뷰|전체 리뷰)\s*(?:전체)?보기$/),
    firstUsable(["a[data-shp-area='sprvsub.rvmore']"]),
    findControlByText(/^(?:리뷰|쇼핑몰리뷰)\s*[\d,]+$/),
  ].filter(Boolean);
  return [...new Set(controls)];
}

function findFullNaverReviewControl() {
  return findFullNaverReviewControls()[0] ?? null;
}

function describeFullReviewControl(control) {
  let hrefPath;
  const href = control.getAttribute("href");
  if (href) {
    try {
      hrefPath = new URL(href, location.href).pathname;
    } catch {
      hrefPath = "invalid";
    }
  }
  return {
    tag: control.tagName,
    area: control.getAttribute("data-shp-area") || undefined,
    text: normalize(control.textContent || "").slice(0, 60) || undefined,
    hrefPath,
  };
}

async function waitForFullNaverReviewList(config, beforeSignature, beforeUrl, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (isNaverFullReviewListReady()) return true;
    await wait(Math.min(200, Math.max(deadline - Date.now(), 0)));
  }
  return isNaverFullReviewListReady();
}

function describeNaverFullReviewState() {
  return {
    bodyCount: findNaverReviewBodies().length,
    sortCount: [...document.querySelectorAll(NAVER_SORT_SELECTOR)]
      .filter(isRenderedInActiveTree).length,
    dialogCount: [...document.querySelectorAll("[role='dialog']")]
      .filter(isRenderedInActiveTree).length,
    summaryCount: document.querySelectorAll("[data-shp-area='sprvsub.topreview']").length,
    candidateCount: document.querySelectorAll(
      "[data-shp-area='sprvsub.topreviewmore'], [data-shp-area='sprvrpre.more'], [data-shp-area='sprvsub.rvmore']",
    ).length,
    scrollY: Math.round(window.scrollY),
    documentHeight: document.documentElement.scrollHeight,
  };
}

async function waitForFullNaverReviewControls(timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const controls = findFullNaverReviewControls();
    if (controls.length) return controls;

    const summaryNodes = [...document.querySelectorAll("[data-shp-area='sprvsub.topreview']")];
    const lazyLoadTarget =
      document.querySelector("[data-shp-area='sprvsub.topreviewmore']") ||
      document.querySelector("[data-shp-area='sprvrpre.more']") ||
      summaryNodes.at(-1);
    lazyLoadTarget?.scrollIntoView?.({ block: "center", behavior: "auto" });
    await wait(Math.min(300, Math.max(deadline - Date.now(), 0)));
  }
  return findFullNaverReviewControls();
}

async function openFullNaverReviewList(config, waitTimeout = 12_000) {
  if (isNaverFullReviewListReady()) {
    if (fullReviewDiagnostics) fullReviewDiagnostics.ready = true;
    return true;
  }
  const controls = await waitForFullNaverReviewControls(Math.min(waitTimeout, 10_000));
  if (!controls.length) {
    if (fullReviewDiagnostics) {
      fullReviewDiagnostics.failure = "control_not_found";
      fullReviewDiagnostics.controlSearch = describeNaverFullReviewState();
    }
    return false;
  }
  for (const [index, control] of controls.entries()) {
    const beforeSignature = reviewPageSignature(config);
    const beforeUrl = location.href;
    if (control.tagName === "A") control.removeAttribute("target");
    const attempt = {
      ...describeFullReviewControl(control),
      before: describeNaverFullReviewState(),
      activated: activateControl(control),
    };
    fullReviewDiagnostics?.attempts.push(attempt);
    if (!attempt.activated) continue;
    const firstWait = index === 0 && waitTimeout >= 1_000
      ? Math.min(Math.floor(waitTimeout / 2), 2_500)
      : waitTimeout;
    if (await waitForFullNaverReviewList(config, beforeSignature, beforeUrl, firstWait)) {
      attempt.transitioned = true;
      attempt.after = describeNaverFullReviewState();
      if (fullReviewDiagnostics) {
        fullReviewDiagnostics.ready = true;
        fullReviewDiagnostics.endPath = location.pathname;
      }
      return true;
    }
    attempt.after = describeNaverFullReviewState();

    // iPhone Safari can expose the button before Naver finishes hydrating its click handler.
    // Re-query the live DOM and retry once instead of keeping a stale pre-hydration element.
    if (index === 0 && waitTimeout > firstWait) {
      const area = control.getAttribute("data-shp-area");
      const freshControl = area
        ? [...document.querySelectorAll(`[data-shp-area='${area}']`)].find(isUsable)
        : findFullNaverReviewControls()[0];
      if (freshControl && !isNaverFullReviewListReady()) {
        const retry = {
          ...describeFullReviewControl(freshControl),
          retry: true,
          before: describeNaverFullReviewState(),
          activated: activateControl(freshControl),
        };
        fullReviewDiagnostics?.attempts.push(retry);
        if (
          retry.activated &&
          await waitForFullNaverReviewList(
            config,
            reviewPageSignature(config),
            location.href,
            waitTimeout - firstWait,
          )
        ) {
          retry.transitioned = true;
          retry.after = describeNaverFullReviewState();
          if (fullReviewDiagnostics) {
            fullReviewDiagnostics.ready = true;
            fullReviewDiagnostics.endPath = location.pathname;
          }
          return true;
        }
        retry.after = describeNaverFullReviewState();
      }
    }
  }
  if (fullReviewDiagnostics) {
    fullReviewDiagnostics.ready = false;
    fullReviewDiagnostics.failure = "list_did_not_open";
    fullReviewDiagnostics.endPath = location.pathname;
  }
  return false;
}

async function ensureReviewArea(config) {
  if (findReviewNodes(config).length) return true;
  const before = reviewPageSignature(config);
  const clicked =
    activateFirst(config?.reviewTabSelectors) ||
    activateControl(findControlByText(/^(리뷰|후기|상품평|구매평)(\s*\(?[\d,]+\)?)?$/));
  if (clicked) {
    await waitForReviewChange(config, before, 3500);
  }
  return findReviewNodes(config).length > 0 || /리뷰|후기|상품평|구매평/.test(document.body?.innerText || "");
}

async function applyNewestSort(config) {
  const control =
    firstUsable(config?.newestSelectors) ||
    findControlByText(/^(최신순|최근순|최신 등록순|최근 등록순)$/);
  const activated = activateControl(control);
  if (activated) await wait(800);
  return activated || /최신순|최근순/.test(document.body?.innerText || "");
}

function findRatingControl(rating, config) {
  const direct = document.querySelector(
    [
      `button[data-rating='${rating}']`,
      `a[data-rating='${rating}']`,
      `[role='button'][data-rating='${rating}']`,
      `button[data-score='${rating}']`,
      `a[data-score='${rating}']`,
      `input[name*='rating'][value='${rating}']`,
      `input[name*='star'][value='${rating}']`,
    ].join(","),
  );
  if (isUsable(direct)) return direct;
  const configured = config?.ratingSelectors?.[rating];
  const bySelector = firstUsable(configured);
  if (bySelector) return bySelector;
  const pattern = new RegExp(`^(별점\\s*)?${rating}\\s*점(?:\\s*\\([\\d,]+\\)|\\s+[\\d,]+개)?$`);
  return findControlByText(pattern);
}

async function applyRatingFilter(rating, config) {
  const activated = activateControl(findRatingControl(rating, config));
  if (activated) await wait(900);
  return activated;
}

async function advanceReviews(config) {
  const selected = firstUsable(config?.nextSelectors) || firstUsable(config?.loadMoreSelectors);
  if (activateControl(selected)) return true;
  const byText = findControlByText(/^(더보기|리뷰 더보기|후기 더보기|다음|다음 페이지|>)$/);
  if (activateControl(byText)) return true;

  const nodes = findReviewNodes(config);
  const last = nodes.at(-1);
  if (!last) return false;
  const beforeHeight = document.documentElement.scrollHeight;
  last.scrollIntoView({ block: "end", behavior: "auto" });
  window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
  await wait(900);
  return document.documentElement.scrollHeight > beforeHeight || reviewPageSignature(config) !== "";
}

function activateFirst(selectors) {
  return activateControl(firstUsable(selectors));
}

function firstUsable(selectors = []) {
  for (const selector of selectors || []) {
    for (const element of document.querySelectorAll(selector)) {
      if (isUsable(element)) return element;
    }
  }
  return null;
}

function findControlByText(pattern) {
  const controls = document.querySelectorAll(
    "button, a, [role='button'], label, select, option, input[type='radio'], input[type='checkbox']",
  );
  for (const control of controls) {
    if (!isUsable(control)) continue;
    const text = normalize(
      control.getAttribute("aria-label") ||
      control.getAttribute("title") ||
      control.textContent ||
      control.value ||
      "",
    );
    if (text.length <= 40 && pattern.test(text)) return control;
  }
  return null;
}

function activateControl(control) {
  if (!isUsable(control)) return false;
  if (control.tagName === "OPTION") {
    const select = control.closest("select");
    if (!select) return false;
    select.value = control.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (control.tagName === "SELECT") return false;
  control.scrollIntoView?.({ block: "center", behavior: "auto" });
  control.click();
  return true;
}

function isUsable(element) {
  if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
  if (/\b(disabled|is-disabled)\b/i.test(element.className || "")) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function findReviewNodes(config) {
  const selectors = [...(config?.itemSelectors || []), ...COMMON_REVIEW_SELECTORS];
  const nodes = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (seen.has(node)) continue;
      const text = normalize(node.textContent || "");
      if (text.length < 20 || text.length > 6000) continue;
      const hasReviewId = Boolean(
        node.getAttribute("data-review-id") ||
        node.getAttribute("data-review-no"),
      );
      const hasContent = Boolean(node.querySelector(
        "p, [data-review-content], [class*='content'], [class*='Content'], [class*='comment']",
      ));
      const hasReviewMeta = /20\d{2}[.\-/]\s*\d{1,2}|별점|평점/.test(text);
      if (!hasReviewId && !hasContent && !hasReviewMeta && text.length < 80) continue;
      seen.add(node);
      nodes.push(node);
    }
  }
  return nodes;
}

function reviewPageSignature(config) {
  return findReviewNodes(config)
    .slice(0, 5)
    .map((node) => hashText(normalize(node.textContent || "")))
    .join(":");
}

async function waitForReviewChange(config, before, timeout = 2600) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await wait(200);
    const after = reviewPageSignature(config);
    if (after && after !== before) return true;
  }
  return false;
}

function probeReviews(config) {
  const text = document.body?.innerText ?? "";
  const nodes = findReviewNodes(config);
  return {
    status: nodes.length ? "partial" : /리뷰|후기|상품평|구매평/.test(text) ? "partial" : "unsupported",
    hasReviewArea: nodes.length > 0 || /리뷰|후기|상품평|구매평/.test(text),
    supportsNewestSort: /최신순|최근순/.test(text),
    supportsRatingFilter: RATINGS.every((rating) => Boolean(findRatingControl(rating, config))),
    requiresLogin: /로그인 후|로그인이 필요/.test(text),
    visibleReviewCount: nodes.length,
  };
}

function detectInterruption() {
  const text = (document.body?.innerText || document.body?.textContent || "").slice(0, 12000);
  if (
    /captcha|자동입력|보안문자|로봇이 아닙니다|보안 확인을 완료|실제 사용자임을 확인|빈 칸을 채워주세요/i
      .test(text)
  ) {
    return { status: "waiting_for_user", reason: "captcha", message: "CAPTCHA를 직접 완료한 뒤 다시 확인해 주세요." };
  }
  if (/로그인 후|로그인이 필요|login required/i.test(text) && !findReviewNodes().length) {
    return { status: "waiting_for_login", reason: "login_required", message: "로그인한 뒤 다시 확인해 주세요." };
  }
  if (/접근이 제한|비정상적인 접근|access denied|temporarily blocked/i.test(text)) {
    return { status: "waiting_for_user", reason: "access_limited", message: "접근 제한이 해제된 뒤 다시 확인해 주세요." };
  }
  return null;
}

function readProduct() {
  const jsonLd = [...document.querySelectorAll("script[type='application/ld+json']")]
    .map((element) => {
      try { return JSON.parse(element.textContent || "null"); } catch { return null; }
    })
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .find((value) => value?.["@type"] === "Product");
  const title =
    jsonLd?.name ||
    document.querySelector("meta[property='og:title']")?.content ||
    document.querySelector("h1")?.textContent?.trim() ||
    document.title;
  return { name: title, url: location.href };
}

function extractContent(node) {
  const candidates = [
    "[data-review-content]",
    "[class*='content']",
    "[class*='Content']",
    "[class*='text']",
    "[class*='comment']",
    "[class*='review'] p",
    "p",
  ];
  for (const selector of candidates) {
    const texts = [...node.querySelectorAll(selector)]
      .map((element) => normalize(element.textContent || ""))
      .filter((text) => text.length >= 10 && text.length <= 5000);
    if (texts.length) return texts.sort((a, b) => b.length - a.length)[0];
  }
  return normalize(node.textContent || "");
}

function extractRating(node) {
  const dataRating = [
    node.getAttribute("data-rating"),
    node.getAttribute("data-score"),
    node.getAttribute("data-star"),
  ].map(Number).find((value) => RATINGS.includes(Math.round(value)));
  if (dataRating) return Math.round(dataRating);

  const text = [
    node.getAttribute("aria-label"),
    ...[...node.querySelectorAll(
      "[aria-label*='점'], [aria-label*='별'], [data-rating], [data-score], [class*='rating'], [class*='star']",
    )].map((element) =>
      [
        element.getAttribute("aria-label"),
        element.getAttribute("data-rating"),
        element.getAttribute("data-score"),
        element.textContent,
      ].filter(Boolean).join(" ")
    ),
    node.textContent,
  ].filter(Boolean).join(" ");
  const match = text.match(
    /(?:별점|평점|별)\s*([1-5](?:\.\d)?)(?:\s*점)?|[★⭐]\s*([1-5](?:\.\d)?)|([1-5](?:\.\d)?)\s*(?:점|\/\s*5|개)/,
  );
  if (match) {
    return Math.max(1, Math.min(5, Math.round(Number(match[1] ?? match[2] ?? match[3]))));
  }

  const filledStars = node.querySelectorAll(
    "[class*='star'][class*='fill'], [class*='star'][class*='active'], [aria-label='채운 별']",
  ).length;
  return RATINGS.includes(filledStars) ? filledStars : null;
}

function extractDate(node) {
  const text = node.textContent || "";
  const absolute = text.match(/20\d{2}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/);
  if (absolute) return absolute[0].replace(/[.\s]/g, "-").replace(/-+$/, "");
  const short = text.match(/(?:^|\s)(\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\.|\s|$)/);
  if (short) {
    return `20${short[1]}-${short[2].padStart(2, "0")}-${short[3].padStart(2, "0")}`;
  }
  const relative = text.match(/(\d+)\s*(일|시간|분)\s*전/);
  if (!relative) return undefined;
  const amount = Number(relative[1]);
  const unit = relative[2] === "일" ? 86_400_000 : relative[2] === "시간" ? 3_600_000 : 60_000;
  return new Date(Date.now() - amount * unit).toISOString();
}

function extractOption(node) {
  const option = node.querySelector("[class*='option'], [class*='Option'], [data-review-option]");
  return option ? normalize(option.textContent || "") : undefined;
}

function isConfirmedEmptyReviewArea() {
  return /(등록된|작성된|해당하는)?\s*(리뷰|후기|상품평).{0,12}(없습니다|없어요|0개)/.test(
    document.body?.innerText || "",
  );
}

async function notifyProgress(job, progress) {
  updateCollectionOverlay(progress.message);
  try {
    await chrome.runtime.sendMessage({
      type: "REVIEWMOA_COLLECTION_PROGRESS",
      payload: { jobId: job.id, ...progress, updatedAt: new Date().toISOString() },
    });
  } catch {
    // 탭 이동 중에는 새 문서의 content script가 작업을 이어받는다.
  }
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fingerprint(value) {
  return value.toLowerCase().replace(/[^0-9a-z가-힣]/g, "").slice(0, 1200);
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

globalThis.REVIEWMOA_COLLECTOR_TEST = Object.freeze({
  detectInterruption,
  applyNaverNewestSort,
  extractContent,
  extractRating,
  extractDate,
  findFullNaverReviewControl,
  findRatingControl,
  hasOnlyNaverSummaryReviews,
  hideCollectionOverlay,
  openFullNaverReviewList,
  prepareReviewArea,
  readNaverRatingDistribution,
  readVisibleNaverReviews,
  readVisibleReviews,
  selectLatestByRating,
  showCollectionOverlay,
  validateNaverCollection,
});
