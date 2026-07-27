const REVIEW_SELECTORS = [
  "[data-review-id]",
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "REVIEWMOA_PROBE_AND_COLLECT") return;
  collect(message.job)
    .then(async (result) => {
      await chrome.runtime.sendMessage({ type: "REVIEWMOA_COLLECTION_RESULT", payload: result });
      sendResponse(result);
    })
    .catch((error) => {
      const result = { jobId: message.job.id, status: "failed", reason: error.message };
      chrome.runtime.sendMessage({ type: "REVIEWMOA_COLLECTION_RESULT", payload: result });
      sendResponse(result);
    });
  return true;
});

async function collect(job) {
  const interruption = detectInterruption();
  if (interruption) {
    return { jobId: job.id, status: interruption.status, reason: interruption.reason, url: location.href };
  }

  const product = readProduct();
  const capability = probeReviews();
  if (!capability.hasReviewArea) {
    return {
      jobId: job.id,
      status: "waiting_for_user",
      reason: "review_area_not_found",
      product,
      capability,
    };
  }

  const reviews = readVisibleReviews();
  return {
    jobId: job.id,
    status: reviews.length ? "partial" : "waiting_for_user",
    reason: reviews.length ? "visible_reviews_collected" : "open_review_tab",
    product,
    capability,
    reviews,
    collectedAt: new Date().toISOString(),
  };
}

function detectInterruption() {
  const text = document.body?.innerText?.slice(0, 12000) ?? "";
  if (/captcha|자동입력|보안문자|로봇이 아닙니다/i.test(text)) {
    return { status: "waiting_for_user", reason: "captcha" };
  }
  if (/로그인 후|로그인이 필요|login required/i.test(text) && !findReviewNodes().length) {
    return { status: "waiting_for_login", reason: "login_required" };
  }
  if (/접근이 제한|비정상적인 접근|access denied|temporarily blocked/i.test(text)) {
    return { status: "waiting_for_user", reason: "access_limited" };
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

function probeReviews() {
  const text = document.body?.innerText ?? "";
  const hasReviewWord = /리뷰|후기|상품평/.test(text);
  const nodes = findReviewNodes();
  return {
    status: nodes.length ? "partial" : hasReviewWord ? "partial" : "unsupported",
    hasReviewArea: hasReviewWord || nodes.length > 0,
    supportsNewestSort: /최신순|최근순/.test(text),
    supportsRatingFilter: /1점/.test(text) && /5점/.test(text),
    requiresLogin: /로그인 후|로그인이 필요/.test(text),
    visibleReviewCount: nodes.length,
  };
}

function findReviewNodes() {
  const seen = new Set();
  return REVIEW_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter((node) => {
      const text = normalize(node.textContent || "");
      if (text.length < 20 || text.length > 6000 || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
}

function readVisibleReviews() {
  const duplicates = new Set();
  return findReviewNodes().slice(0, 300).map((node, index) => {
    const content = extractContent(node);
    const rating = extractRating(node);
    const normalized = normalize(content).toLowerCase();
    let classification = "included";
    if (SPONSORED_WORDS.some((word) => normalized.includes(word.toLowerCase()))) classification = "sponsored";
    else if (duplicates.has(normalized)) classification = "duplicate";
    else if (rating >= 4 && NEGATIVE_WORDS.filter((word) => normalized.includes(word)).length >= 2) classification = "rating_mismatch";
    else if (rating <= 2 && POSITIVE_WORDS.filter((word) => normalized.includes(word)).length >= 2) classification = "rating_mismatch";
    duplicates.add(normalized);
    return {
      id: node.getAttribute("data-review-id") || `${location.href}#${index}`,
      rating,
      content,
      createdAt: extractDate(node),
      option: extractOption(node),
      classification,
    };
  }).filter((review) => review.content.length >= 10);
}

function extractContent(node) {
  const candidates = [
    "[class*='content']", "[class*='Content']", "[class*='text']", "[class*='comment']", "p",
  ];
  for (const selector of candidates) {
    const texts = [...node.querySelectorAll(selector)]
      .map((element) => normalize(element.textContent || ""))
      .filter((text) => text.length >= 10);
    if (texts.length) return texts.sort((a, b) => b.length - a.length)[0];
  }
  return normalize(node.textContent || "");
}

function extractRating(node) {
  const text = [
    node.getAttribute("aria-label"),
    ...[...node.querySelectorAll("[aria-label*='점'], [class*='rating'], [class*='star']")]
      .map((element) => `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`),
  ].join(" ");
  const match = text.match(/(?:별점|평점)?\s*([1-5](?:\.\d)?)\s*(?:점|\/\s*5)/);
  return Math.max(1, Math.min(5, Math.round(Number(match?.[1] || 5))));
}

function extractDate(node) {
  const text = node.textContent || "";
  const match = text.match(/20\d{2}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/);
  return match?.[0]?.replace(/[.\s]/g, "-").replace(/-+$/, "");
}

function extractOption(node) {
  const option = node.querySelector("[class*='option'], [class*='Option']");
  return option ? normalize(option.textContent || "") : undefined;
}

function normalize(value) {
  return value.replace(/\s+/g, " ").trim();
}
