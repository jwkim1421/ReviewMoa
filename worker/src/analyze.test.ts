import { describe, expect, it, vi } from "vitest";
import { createReport, enhanceVerdictWithAi, parseAiPayload } from "./analyze";
import type { StoredReview } from "./types";

describe("parseAiPayload", () => {
  it("parses the Responses API output_text shortcut", () => {
    expect(parseAiPayload({
      output_text: JSON.stringify({
        positive: "배송이 빨라요.",
        negative: "내구성은 아쉬워요.",
        conclusion: "단기 사용에 적합해요.",
      }),
    })).toEqual({
      positive: "배송이 빨라요.",
      negative: "내구성은 아쉬워요.",
      conclusion: "단기 사용에 적합해요.",
    });
  });

  it("parses nested OpenRouter Responses API output", () => {
    expect(parseAiPayload({
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({
            positive: "사용이 편해요.",
            negative: "포장이 약해요.",
            conclusion: "포장 상태를 확인하세요.",
          }),
        }],
      }],
    })?.conclusion).toBe("포장 상태를 확인하세요.");
  });

  it("rejects incomplete or malformed analysis", () => {
    expect(parseAiPayload({ output_text: "not-json" })).toBeNull();
    expect(parseAiPayload({
      output_text: JSON.stringify({ positive: "좋아요." }),
    })).toBeNull();
  });
});

describe("createReport sample notice", () => {
  it("warns about a small sample while preserving the organized reviews", () => {
    const rows: StoredReview[] = [{
      review_id: "review-1",
      rating: 5,
      content: "배송이 빠르고 사용하기 편해서 만족합니다.",
      created_at: "2026-07-29",
      option_name: "화이트",
      classification: "included",
    }];
    const report = createReport("job-1", { name: "테스트 상품" }, rows);

    expect(report.sampleNotice).toContain("정상 리뷰가 1개로 충분하지 않습니다.");
    expect(report.ratings.find(({ rating }) => rating === 5)?.reviews).toHaveLength(1);
  });
});

describe("AI fallback", () => {
  it("sets a request timeout and preserves the rule-based report when AI fails", async () => {
    const rows: StoredReview[] = [{
      review_id: "review-1",
      rating: 5,
      content: "배송이 빠르고 만족합니다.",
      created_at: "2026-07-29",
      option_name: undefined,
      classification: "included",
    }];
    const report = createReport("job-1", { name: "테스트 상품" }, rows);
    const aiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("Timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", aiFetch);

    try {
      await expect(enhanceVerdictWithAi(report, rows, {
        provider: "openrouter",
        apiKey: "test-key",
        model: "openrouter/free",
      })).resolves.toBe(report);
      expect(aiFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
