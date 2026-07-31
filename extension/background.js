import { REVIEWMOA_API_BASE } from "./runtime-config.js";

const ACTIVE_KEY = "reviewmoa.activeJob";
const RESULT_KEY = "reviewmoa.lastResult";
const OPERATOR_REASONS = new Set(["captcha", "login_required", "access_limited"]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "REVIEWMOA_PING") {
    sendResponse({ installed: true, version: chrome.runtime.getManifest().version });
    return;
  }

  if (message?.type === "REVIEWMOA_START") {
    startJob(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REVIEWMOA_MOBILE_HANDOFF") {
    startMobileHandoff(message.payload, sender.tab?.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REVIEWMOA_GET_STATE") {
    chrome.storage.local.get([ACTIVE_KEY, RESULT_KEY]).then((state) => {
      sendResponse({
        activeJob: state[ACTIVE_KEY] ?? null,
        result: state[RESULT_KEY] ?? null,
      });
    });
    return true;
  }

  if (message?.type === "REVIEWMOA_PRODUCT_READY") {
    chrome.storage.local.get(ACTIVE_KEY).then(async (state) => {
      const job = state[ACTIVE_KEY];
      const senderTabId = sender.tab?.id;
      const matchesTab =
        Number.isInteger(senderTabId) &&
        (!Number.isInteger(job?.tabId) || job.tabId === senderTabId);
      if (
        job?.mode !== "mobile-handoff" ||
        !matchesTab ||
        !allowedProductUrl(message.url) ||
        !sameProductUrl(job.url, message.url)
      ) {
        sendResponse({ job: null });
        return;
      }
      if (!Number.isInteger(job.tabId)) {
        await chrome.storage.local.set({
          [ACTIVE_KEY]: { ...job, tabId: senderTabId },
        });
      }
      sendResponse({
        job: {
          id: job.id,
          url: job.url,
          mode: job.mode,
        },
      });
    }).catch(() => sendResponse({ job: null }));
    return true;
  }

  if (message?.type === "REVIEWMOA_COLLECTION_PROGRESS") {
    chrome.storage.local.get(ACTIVE_KEY).then((state) => {
      const activeJob = state[ACTIVE_KEY];
      if (!activeJob || activeJob.id !== message.payload?.jobId) return;
      return chrome.storage.local.set({
        [ACTIVE_KEY]: { ...activeJob, ...message.payload },
      });
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "REVIEWMOA_COLLECTION_RESULT") {
    const result = { ...message.payload, receivedAt: new Date().toISOString() };
    chrome.storage.local.get(ACTIVE_KEY).then((state) => {
      if (state[ACTIVE_KEY]?.mode === "mobile-handoff") {
        return handleMobileCollectionResult(state[ACTIVE_KEY], result);
      }
      const waiting = ["waiting_for_login", "waiting_for_user"].includes(result.status);
      const activeJob = waiting && state[ACTIVE_KEY]
        ? { ...state[ACTIVE_KEY], status: result.status, reason: result.reason }
        : null;
      return chrome.storage.local.set({ [RESULT_KEY]: result, [ACTIVE_KEY]: activeJob });
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
});

function compactResult(result) {
  const { reviews, ...summary } = result;
  return {
    ...summary,
    reviewCount: Array.isArray(reviews) ? reviews.length : 0,
  };
}

function allowedProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      [
        "smartstore.naver.com",
        "brand.naver.com",
        "shopping.naver.com",
      ].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function sameProductUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const leftId = leftUrl.pathname.match(/\/(?:products|catalog)\/(\d+)/)?.[1];
    const rightId = rightUrl.pathname.match(/\/(?:products|catalog)\/(\d+)/)?.[1];
    return Boolean(leftId && leftId === rightId);
  } catch {
    return false;
  }
}

async function startMobileHandoff(payload, returnTabId) {
  if (
    typeof payload?.jobId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(payload.jobId) ||
    typeof payload?.operatorToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.operatorToken) ||
    !allowedProductUrl(payload.url)
  ) {
    throw new Error("모바일 보안 확인 정보가 올바르지 않습니다.");
  }
  const job = {
    id: payload.jobId,
    operatorToken: payload.operatorToken,
    url: payload.url,
    mode: "mobile-handoff",
    status: "opening",
    createdAt: new Date().toISOString(),
    returnTabId,
  };
  await chrome.storage.local.remove(RESULT_KEY);
  await chrome.storage.local.set({ [ACTIVE_KEY]: job });
  try {
    const tab = await chrome.tabs.create({ url: payload.url, active: true });
    const state = await chrome.storage.local.get(ACTIVE_KEY);
    if (state[ACTIVE_KEY]?.id === job.id && !Number.isInteger(state[ACTIVE_KEY].tabId)) {
      await chrome.storage.local.set({
        [ACTIVE_KEY]: { ...state[ACTIVE_KEY], tabId: tab.id },
      });
    }
  } catch (error) {
    await chrome.storage.local.set({ [ACTIVE_KEY]: null });
    throw error;
  }
  return { ok: true };
}

async function returnToReviewMoa(job) {
  if (Number.isInteger(job.returnTabId)) {
    await chrome.tabs.update(job.returnTabId, { active: true }).catch(() => undefined);
  }
  if (Number.isInteger(job.tabId) && job.tabId !== job.returnTabId) {
    await chrome.tabs.remove(job.tabId).catch(() => undefined);
  }
}

async function handleMobileCollectionResult(job, result) {
  const storedResult = compactResult(result);
  if (!["completed", "partial"].includes(result.status)) {
    const needsOperator = OPERATOR_REASONS.has(result.reason);
    await chrome.storage.local.set({
      [ACTIVE_KEY]: needsOperator
        ? {
            ...job,
            status: result.status,
            reason: result.reason,
            message: result.message,
          }
        : null,
      [RESULT_KEY]: storedResult,
    });
    if (!needsOperator) await returnToReviewMoa(job);
    return;
  }

  const response = await fetch(
    `${REVIEWMOA_API_BASE}/v1/jobs/${encodeURIComponent(job.id)}/mobile-complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operatorToken: job.operatorToken,
        reviews: result.reviews ?? [],
        confirmedEmpty: result.reason === "confirmed_zero_reviews",
        partialReason: result.partialReason,
      }),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failedResult = {
      ...storedResult,
      status: "failed",
      reason: payload.error ?? "mobile_upload_failed",
      message: "리뷰 전송에 실패했습니다. 다시 시도해 주세요.",
    };
    await chrome.storage.local.set({
      [ACTIVE_KEY]: null,
      [RESULT_KEY]: failedResult,
    });
    await returnToReviewMoa(job);
    return;
  }
  await chrome.storage.local.set({
    [ACTIVE_KEY]: null,
    [RESULT_KEY]: {
      ...storedResult,
      status: payload.status,
      uploadedAt: new Date().toISOString(),
    },
  });
  await returnToReviewMoa(job);
}

async function startJob(payload) {
  if (!payload?.url) throw new Error("상품 URL이 필요합니다.");
  const job = {
    id: crypto.randomUUID(),
    url: payload.url,
    status: "probing",
    createdAt: new Date().toISOString(),
    rating: 5,
    page: 1,
  };
  const tab = await chrome.tabs.create({ url: payload.url, active: true });
  job.tabId = tab.id;
  await chrome.storage.local.set({ [ACTIVE_KEY]: job, [RESULT_KEY]: null });
  return { ok: true, job };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const state = await chrome.storage.local.get(ACTIVE_KEY);
  const job = state[ACTIVE_KEY];
  if (!job || job.tabId !== tabId) return;
  if (job.mode === "mobile-handoff") return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "REVIEWMOA_PROBE_AND_COLLECT",
      job: { id: job.id, url: job.url, mode: job.mode },
    });
  } catch {
    if (job.mode === "mobile-handoff") {
      await handleMobileCollectionResult(job, {
        jobId: job.id,
        status: "failed",
        reason: "collector_unavailable",
        message: "상품 페이지에서 리뷰모아 확장을 실행하지 못했습니다.",
      });
      return;
    }
    await chrome.storage.local.set({
      [ACTIVE_KEY]: { ...job, status: "waiting_for_user", reason: "collector_unavailable" },
    });
  }
});
