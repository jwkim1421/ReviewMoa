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

  it("finds child engagement themes without treating a large book as an option mismatch", () => {
    const rows: StoredReview[] = [
      {
        review_id: "toy-1",
        rating: 5,
        content: "아기가 혼자 눌러보고 그림보며 재미있게 잘 놀아요. 구성도 좋고 퀄리티가 좋아요.",
        created_at: undefined,
        option_name: undefined,
        classification: "included",
      },
      {
        review_id: "toy-2",
        rating: 4,
        content: "책이 생각보다 크고 무거워서 놀랐고 윗부분이 살짝 찢겨 있었어요.",
        created_at: undefined,
        option_name: undefined,
        classification: "included",
      },
    ];
    const report = createReport("job-toy", { name: "명화 사운드북" }, rows);

    expect(report.strengths).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "아이의 관심과 만족", mentions: 1 }),
      expect.objectContaining({ label: "콘텐츠와 구성", mentions: 1 }),
      expect.objectContaining({ label: "품질과 마감", mentions: 1 }),
    ]));
    expect(report.cautions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "제품 손상", mentions: 1 }),
      expect.objectContaining({ label: "크기와 무게", mentions: 1 }),
      expect.objectContaining({ label: "옵션 차이", mentions: 0 }),
    ]));
    expect(report.analysis.negative).not.toContain("옵션 차이");
  });

  it("scores completeness against the verified source distribution", () => {
    const sourceDistribution = { 1: 1, 2: 2, 3: 9, 4: 33, 5: 398 } as const;
    const rows: StoredReview[] = ([5, 4, 3, 2, 1] as const).flatMap((rating) =>
      Array.from(
        { length: Math.min(sourceDistribution[rating], 100) },
        (_, index): StoredReview => ({
          review_id: `${rating}-${index}`,
          rating,
          content: "아이가 좋아하고 관심을 보이며 잘 놀아서 만족합니다.",
          created_at: new Date().toISOString(),
          option_name: undefined,
          classification: "included",
        }),
      ),
    );

    const report = createReport("job-verified", { name: "검증 상품" }, rows, {
      sourceDistribution,
    });

    expect(report.confidence).toBe(87);
    expect(report.confidenceReasons).toContain("자동 규칙에서 제외 신호가 발견되지 않음");
    expect(report.ratings.find(({ rating }) => rating === 5)).toMatchObject({
      sourceCount: 398,
      checked: 100,
      included: 100,
      excluded: 0,
    });
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

describe("confidence explanations (P1-1)", () => {
  it("records a confidence version and per-component explanations", () => {
    const rows: StoredReview[] = [
      { review_id: "a", rating: 5, content: "잘 쓰고 있어요 만족합니다", classification: "included", created_at: "2020-01-01T00:00:00.000Z" },
      { review_id: "b", rating: 1, content: "배송이 느려서 별로였어요", classification: "included", created_at: "2020-01-02T00:00:00.000Z" },
    ];
    const report = createReport("job-1", { source: "naver", productId: "1", name: "x" }, rows) as unknown as {
      confidenceVersion: string;
      confidenceExplanations: Record<string, string>;
    };

    expect(report.confidenceVersion).toBe("2026-08");
    expect(Object.keys(report.confidenceExplanations).sort()).toEqual(
      ["completeness", "consistency", "evidence", "freshness", "health"],
    );
    expect(report.confidenceExplanations.health).toContain("제외 신호가 없어요");
    expect(report.confidenceExplanations.freshness).toContain("1년 이상");
  });
});
