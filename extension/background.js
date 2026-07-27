const ACTIVE_KEY = "reviewmoa.activeJob";
const RESULT_KEY = "reviewmoa.lastResult";

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

  if (message?.type === "REVIEWMOA_GET_STATE") {
    chrome.storage.local.get([ACTIVE_KEY, RESULT_KEY]).then((state) => {
      sendResponse({
        activeJob: state[ACTIVE_KEY] ?? null,
        result: state[RESULT_KEY] ?? null,
      });
    });
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
      const waiting = ["waiting_for_login", "waiting_for_user"].includes(result.status);
      const activeJob = waiting && state[ACTIVE_KEY]
        ? { ...state[ACTIVE_KEY], status: result.status, reason: result.reason }
        : null;
      return chrome.storage.local.set({ [RESULT_KEY]: result, [ACTIVE_KEY]: activeJob });
    }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

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
  try {
    await chrome.tabs.sendMessage(tabId, { type: "REVIEWMOA_PROBE_AND_COLLECT", job });
  } catch {
    await chrome.storage.local.set({
      [ACTIVE_KEY]: { ...job, status: "waiting_for_user", reason: "collector_unavailable" },
    });
  }
});
