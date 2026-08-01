import type { ProductIdentity, RawReview } from "../domain/types";

type ExtensionResult = {
  jobId?: string;
  status: string;
  reason?: string;
  message?: string;
  product?: { name?: string; url?: string };
  reviews?: RawReview[];
};

export type MobileHandoffState = {
  activeJob?: ExtensionResult & { id?: string };
  result?: ExtensionResult;
};

function extensionRequest<T>(type: string, payload?: unknown, timeout = 1500): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", listener);
      reject(new Error("EXTENSION_NOT_AVAILABLE"));
    }, timeout);
    function listener(event: MessageEvent) {
      if (event.source !== window || event.data?.type !== `${type}_RESULT` || event.data?.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.payload as T);
    }
    window.addEventListener("message", listener);
    window.postMessage({ type, payload, requestId }, window.location.origin);
  });
}

export async function hasCollectorExtension() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await extensionRequest<{ installed: boolean }>(
        "REVIEWMOA_PING",
        undefined,
        2_500,
      );
      if (result.installed) return true;
    } catch {
      // Safari may need a moment to reconnect the extension after an app update.
    }
    if (attempt < 2) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
  }
  return false;
}

export async function startMobileHandoff(payload: {
  jobId: string;
  operatorToken: string;
  url: string;
}) {
  const result = await extensionRequest<{ ok?: boolean; error?: string }>(
    "REVIEWMOA_MOBILE_HANDOFF",
    payload,
    5_000,
  );
  if (!result?.ok) {
    throw new Error(result?.error ?? "Safari 확장에서 상품 페이지를 열지 못했습니다.");
  }
  return result;
}

export function getMobileHandoffState() {
  return extensionRequest<MobileHandoffState>("REVIEWMOA_GET_STATE");
}

export async function collectWithExtension(
  product: ProductIdentity,
  onStatus: (status: ExtensionResult) => void,
) {
  await extensionRequest("REVIEWMOA_START", { url: product.canonicalUrl }, 5000);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    const state = await extensionRequest<{
      activeJob?: { status: string; reason?: string };
      result?: ExtensionResult;
    }>("REVIEWMOA_GET_STATE");
    const current = state.result ?? state.activeJob;
    if (current) onStatus(current);
    if (
      state.result?.reviews &&
      ["completed", "partial"].includes(state.result.status)
    ) return state.result;
    if (state.result?.status === "failed") throw new Error(state.result.reason || "리뷰 수집에 실패했습니다.");
  }
  throw new Error("리뷰 수집 대기 시간이 초과되었습니다. 상품 탭에서 다시 확인을 눌러 주세요.");
}
