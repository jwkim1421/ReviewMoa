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
      },
    },
    tabs: {
      create: createTab,
      sendMessage: sendTabMessage,
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
  vi.restoreAllMocks();
});

function sendMessage(message: Record<string, unknown>) {
  return new Promise<unknown>((resolve) => {
    messageListener(message, {}, resolve);
  });
}

describe("mobile Safari handoff background flow", () => {
  it("keeps the operator token in extension storage and omits it from the content script", async () => {
    const operatorToken = "a".repeat(64);
    await expect(sendMessage({
      type: "REVIEWMOA_MOBILE_HANDOFF",
      payload: {
        jobId: "11111111-1111-4111-8111-111111111111",
        operatorToken,
        url: "https://smartstore.naver.com/hiwell/products/5038692181",
      },
    })).resolves.toEqual({ ok: true });

    expect(createTab).toHaveBeenCalledWith({
      url: "https://smartstore.naver.com/hiwell/products/5038692181",
      active: true,
    });
    expect(storage["reviewmoa.activeJob"]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      operatorToken,
      mode: "mobile-handoff",
      tabId: 17,
    });

    await updatedListener(17, { status: "complete" });
    expect(sendTabMessage).toHaveBeenCalledWith(17, {
      type: "REVIEWMOA_PROBE_AND_COLLECT",
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
  });
});
