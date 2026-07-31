import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MessageListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

let messageListener: MessageListener;
let updatedListener: (tabId: number, changeInfo: { status?: string }) => Promise<void>;
let storage: Record<string, unknown>;
const createTab = vi.fn(async () => ({ id: 17 }));
const sendTabMessage = vi.fn(async () => undefined);
const updateTab = vi.fn(async () => undefined);
const removeTab = vi.fn(async () => undefined);

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.1.0" }),
      onMessage: {
        addListener(listener: MessageListener) {
          messageListener = listener;
        },
      },
    },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((name) => [name, storage[name]]));
        },
        async set(values: Record<string, unknown>) {
          Object.assign(storage, values);
        },
        async remove(keys: string | string[]) {
          const names = Array.isArray(keys) ? keys : [keys];
          names.forEach((name) => delete storage[name]);
        },
      },
    },
    tabs: {
      create: createTab,
      sendMessage: sendTabMessage,
      update: updateTab,
      remove: removeTab,
      onUpdated: {
        addListener(listener: typeof updatedListener) {
          updatedListener = listener;
        },
      },
    },
  });
  await import("./background.js");
});

beforeEach(() => {
  storage = {};
  createTab.mockClear();
  sendTabMessage.mockClear();
  updateTab.mockClear();
  removeTab.mockClear();
  vi.restoreAllMocks();
});

function sendMessage(message: Record<string, unknown>, sender: unknown = {}) {
  return new Promise<unknown>((resolve) => {
    messageListener(message, sender, resolve);
  });
}

describe("mobile Safari handoff background flow", () => {
  it("keeps the operator token in extension storage and omits it from the content script", async () => {
    const operatorToken = "a".repeat(64);
    storage["reviewmoa.lastResult"] = {
      status: "failed",
      reviews: [{ content: "이전 수집 결과" }],
    };
    await expect(sendMessage(
      {
        type: "REVIEWMOA_MOBILE_HANDOFF",
        payload: {
          jobId: "11111111-1111-4111-8111-111111111111",
          operatorToken,
          url: "https://smartstore.naver.com/hiwell/products/5038692181",
        },
      },
      { tab: { id: 9 } },
    )).resolves.toEqual({ ok: true });

    expect(createTab).toHaveBeenCalledWith({
      url: "https://smartstore.naver.com/hiwell/products/5038692181",
      active: true,
    });
    expect(updateTab).not.toHaveBeenCalledWith(
      17,
      expect.objectContaining({ url: expect.any(String) }),
    );
    expect(storage["reviewmoa.activeJob"]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      operatorToken,
      mode: "mobile-handoff",
      tabId: 17,
      returnTabId: 9,
    });
    expect(storage).not.toHaveProperty("reviewmoa.lastResult");

    await updatedListener(17, { status: "complete" });
    expect(sendTabMessage).not.toHaveBeenCalled();

    await expect(sendMessage(
      {
        type: "REVIEWMOA_PRODUCT_READY",
        url: "https://smartstore.naver.com/hiwell/products/5038692181",
      },
      { tab: { id: 17 } },
    )).resolves.toEqual({
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        url: "https://smartstore.naver.com/hiwell/products/5038692181",
        mode: "mobile-handoff",
      },
    });
  });

  it("uploads reviews with the one-time token after collection completes", async () => {
    const operatorToken = "b".repeat(64);
    storage["reviewmoa.activeJob"] = {
      id: "22222222-2222-4222-8222-222222222222",
      operatorToken,
      url: "https://brand.naver.com/store/products/123",
      mode: "mobile-handoff",
      tabId: 18,
      returnTabId: 8,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendMessage({
      type: "REVIEWMOA_COLLECTION_RESULT",
      payload: {
        jobId: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        reviews: [{
          id: "review-1",
          rating: 5,
          content: "휴대폰에서 확인한 공개 리뷰입니다.",
          classification: "included",
        }],
      },
    })).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operatorToken,
      reviews: [{ id: "review-1", rating: 5 }],
    });
    expect(storage["reviewmoa.activeJob"]).toBeNull();
    expect(storage["reviewmoa.lastResult"]).toMatchObject({
      status: "completed",
      reviewCount: 1,
    });
    expect(storage["reviewmoa.lastResult"]).not.toHaveProperty("reviews");
    expect(updateTab).toHaveBeenCalledWith(8, { active: true });
    expect(removeTab).toHaveBeenCalledWith(18);
  });

  it("keeps the Naver tab open only when the user must complete security verification", async () => {
    storage["reviewmoa.activeJob"] = {
      id: "33333333-3333-4333-8333-333333333333",
      operatorToken: "c".repeat(64),
      url: "https://brand.naver.com/store/products/123",
      mode: "mobile-handoff",
      tabId: 19,
      returnTabId: 7,
    };

    await expect(sendMessage({
      type: "REVIEWMOA_COLLECTION_RESULT",
      payload: {
        jobId: "33333333-3333-4333-8333-333333333333",
        status: "waiting_for_user",
        reason: "captcha",
        message: "CAPTCHA를 직접 완료해 주세요.",
      },
    })).resolves.toEqual({ ok: true });

    expect(storage["reviewmoa.activeJob"]).toMatchObject({ reason: "captcha" });
    expect(updateTab).not.toHaveBeenCalled();
    expect(removeTab).not.toHaveBeenCalled();
  });

  it("binds a quickly loaded product page to a pending handoff without a tab id", async () => {
    storage["reviewmoa.activeJob"] = {
      id: "55555555-5555-4555-8555-555555555555",
      operatorToken: "e".repeat(64),
      url: "https://smartstore.naver.com/store/products/5038692181",
      mode: "mobile-handoff",
      returnTabId: 5,
    };

    await expect(sendMessage(
      {
        type: "REVIEWMOA_PRODUCT_READY",
        url: "https://smartstore.naver.com/store/products/5038692181?from=mobile",
      },
      { tab: { id: 21 } },
    )).resolves.toEqual({
      job: {
        id: "55555555-5555-4555-8555-555555555555",
        url: "https://smartstore.naver.com/store/products/5038692181",
        mode: "mobile-handoff",
      },
    });

    expect(storage["reviewmoa.activeJob"]).toMatchObject({ tabId: 21 });
  });

  it("returns to ReviewMoa and records a readable error for non-security failures", async () => {
    storage["reviewmoa.activeJob"] = {
      id: "44444444-4444-4444-8444-444444444444",
      operatorToken: "d".repeat(64),
      url: "https://brand.naver.com/store/products/123",
      mode: "mobile-handoff",
      tabId: 20,
      returnTabId: 6,
    };

    await expect(sendMessage({
      type: "REVIEWMOA_COLLECTION_RESULT",
      payload: {
        jobId: "44444444-4444-4444-8444-444444444444",
        status: "waiting_for_user",
        reason: "reviews_not_extracted",
        message: "리뷰 본문을 읽지 못했습니다.",
        reviews: [{ content: "저장하면 안 되는 본문" }],
      },
    })).resolves.toEqual({ ok: true });

    expect(storage["reviewmoa.activeJob"]).toBeNull();
    expect(storage["reviewmoa.lastResult"]).toMatchObject({
      reason: "reviews_not_extracted",
      message: "리뷰 본문을 읽지 못했습니다.",
      reviewCount: 1,
    });
    expect(storage["reviewmoa.lastResult"]).not.toHaveProperty("reviews");
    expect(updateTab).toHaveBeenCalledWith(6, { active: true });
    expect(removeTab).toHaveBeenCalledWith(20);
  });
});
