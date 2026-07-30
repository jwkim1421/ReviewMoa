import type { StoredReview } from "./types";

const POSITIVE_ASPECTS: Array<[string, RegExp]> = [
  ["빠른 배송", /배송.{0,8}(빠르|빨랐|만족)|빨리.{0,5}(도착|왔)/],
  ["쉬운 사용법", /사용.{0,8}(편하|쉬|간단)|설치.{0,5}(쉽|간단)/],
  ["가격 대비 품질", /가성비|가격.{0,8}(만족|좋)|품질.{0,8}(좋|만족)/],
];

const CAUTION_ASPECTS: Array<[string, RegExp]> = [
  ["내구성", /고장|내구성|부러|헐거|망가/],
  ["포장 상태", /포장.{0,8}(아쉽|훼손|파손|눌)|상자.{0,5}(눌|뜯)/],
  ["옵션 차이", /옵션.{0,8}(다르|잘못)|색상.{0,8}(다르|차이)|사이즈.{0,8}(다르|작|크)/],
];

function aspectCounts(reviews: StoredReview[], aspects: Array<[string, RegExp]>) {
  const total = Math.max(reviews.length, 1);
  return aspects
    .map(([label, pattern]) => {
      const mentions = reviews.filter((review) => pattern.test(review.content)).length;
      return { label, mentions, ratio: mentions / total };
    })
    .sort((a, b) => b.mentions - a.mentions);
}

function confidence(reviews: StoredReview[], excluded: number) {
  const counts = [1, 2, 3, 4, 5].map((rating) =>
    Math.min(reviews.filter((review) => review.rating === rating).length / 100, 1),
  );
  const completeness = counts.reduce((sum, value) => sum + value, 0) / 5;
  const evidence = Math.min(reviews.length / 300, 1);
  const health = reviews.length ? 1 - Math.min(excluded / (reviews.length + excluded), 1) : 0;
  const score = completeness * 35 + evidence * 25 + 15 + 15 + health * 10;
  return Math.round(Math.min(score, 100));
}

export function createReport(jobId: string, product: Record<string, unknown>, rows: StoredReview[]) {
  const included = rows.filter((review) => ["included", "uncertain"].includes(review.classification));
  const excluded = rows.length - included.length;
  const sampleNotice = included.length < 50
    ? included.length
      ? `정상 리뷰가 ${included.length}개로 충분하지 않습니다. 아래 내용은 확인된 리뷰만 기준으로 정리했으니 참고용으로 봐 주세요.`
      : "정상 리뷰가 확인되지 않아 충분한 판단 근거가 없습니다. 확인 가능한 정보만 정리했으니 참고용으로 봐 주세요."
    : undefined;
  const now = new Date();
  const rawExpiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const reportExpiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const strengths = aspectCounts(included, POSITIVE_ASPECTS);
  const cautions = aspectCounts(included, CAUTION_ASPECTS);
  const topStrength = strengths.find((item) => item.mentions > 0)?.label;
  const topCaution = cautions.find((item) => item.mentions > 0)?.label;
  const verdict = topStrength && topCaution
    ? `${topStrength} 평가는 좋지만 ${topCaution} 불만이 있어 구매 전 확인이 필요해요.`
    : topStrength
      ? `${topStrength} 만족이 반복되지만 리뷰 수와 별점별 차이를 함께 확인하세요.`
      : "아직 충분한 정상 리뷰가 모이지 않아 원문을 먼저 확인하는 편이 안전해요.";
  const analysis = {
    positive: topStrength
      ? `${topStrength}에 대한 만족이 반복적으로 확인됐어요.`
      : "뚜렷하게 반복되는 좋은 점은 아직 확인되지 않았어요.",
    negative: topCaution
      ? `${topCaution}에 대한 불만이 있어 구매 전에 확인이 필요해요.`
      : "반복적으로 나타나는 큰 불만은 아직 확인되지 않았어요.",
    conclusion: topStrength && topCaution
      ? `${topStrength}을 중요하게 본다면 적합하지만 ${topCaution}이 걱정된다면 비교 후 선택하세요.`
      : topStrength
        ? `${topStrength}을 중요하게 보는 구매자에게 무난한 선택이에요.`
        : "표본이 충분하지 않아 대표 원문을 먼저 확인하는 편이 안전해요.",
  };

  const anomalyCounts = {
    sponsored: rows.filter((review) => review.classification === "sponsored").length,
    duplicate: rows.filter((review) => review.classification === "duplicate").length,
    rating_mismatch: rows.filter((review) => review.classification === "rating_mismatch").length,
    uncertain: rows.filter((review) => review.classification === "uncertain").length,
  };

  return {
    id: jobId,
    product,
    collectedAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    rawExpiresAt,
    reportExpiresAt,
    verdict,
    analysis,
    analysisProvider: "rules",
    confidence: confidence(included, excluded),
    confidenceReasons: [
      `별점별 정상 리뷰 ${included.length}개 반영`,
      `의심 신호 ${excluded}개를 주 분석에서 제외`,
    ],
    sampleNotice,
    strengths,
    cautions,
    anomalyCounts,
    ratings: ([5, 4, 3, 2, 1] as const).map((rating) => {
      const ratingRows = rows.filter((review) => review.rating === rating);
      const accepted = ratingRows.filter((review) => ["included", "uncertain"].includes(review.classification));
      return {
        rating,
        checked: ratingRows.length,
        included: accepted.length,
        excluded: ratingRows.length - accepted.length,
        summary: accepted.length
          ? `${rating}점 최신 정상 리뷰 ${accepted.length}개에서 반복 의견을 확인했습니다.`
          : `최근 ${rating}점 리뷰가 확인되지 않았습니다.`,
        reviews: accepted.slice(0, 10).map((review) => ({
          id: review.review_id,
          rating,
          content: review.content,
          createdAt: review.created_at,
          option: review.option_name,
          classification: review.classification,
        })),
      };
    }),
    limitations: [
      "쇼핑몰별 리뷰 탭과 필터 자동화는 비공개 베타 검증 중이어서 일부 리뷰가 누락될 수 있습니다.",
      ...(included.length > 0 && included.every((review) => !review.created_at)
        ? ["작성일을 확인할 수 없어 사이트 제공 순서 기준으로 정리했습니다."]
        : included.some((review) => !review.created_at)
          ? ["일부 리뷰의 작성일을 확인할 수 없어 사이트 제공 순서를 함께 사용했습니다."]
          : []),
    ],
    cached: false,
    collectionVerified: true,
  };
}

type AiProvider = "openrouter" | "openai";

interface AiConfig {
  provider: AiProvider;
  apiKey?: string;
  model: string;
}

interface AiPayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

export function parseAiPayload(payload: AiPayload) {
  const outputText = payload.output_text ?? payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")
    ?.text;
  if (!outputText) return null;
  try {
    const parsed = JSON.parse(outputText) as {
      positive?: unknown;
      negative?: unknown;
      conclusion?: unknown;
    };
    return typeof parsed.positive === "string" &&
      typeof parsed.negative === "string" &&
      typeof parsed.conclusion === "string"
      ? {
          positive: parsed.positive.trim(),
          negative: parsed.negative.trim(),
          conclusion: parsed.conclusion.trim(),
        }
      : null;
  } catch {
    return null;
  }
}

export async function enhanceVerdictWithAi<T extends Record<string, unknown>>(
  report: T,
  reviews: StoredReview[],
  config: AiConfig,
): Promise<T> {
  if (!config.apiKey || reviews.length === 0) return report;
  const input = [5, 4, 3, 2, 1].flatMap((rating) =>
    reviews
      .filter((review) =>
        review.rating === rating &&
        ["included", "uncertain"].includes(review.classification)
      )
      .slice(0, 40)
      .map((review) => ({
        rating: review.rating,
        content: review.content.slice(0, 500),
      }))
  );
  if (input.length === 0) return report;

  const endpoint = config.provider === "openrouter"
    ? "https://openrouter.ai/api/v1/responses"
    : "https://api.openai.com/v1/responses";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://reviewmoa.kro.kr";
    headers["X-OpenRouter-Title"] = "리뷰모아";
  }
  const requestBody: Record<string, unknown> = {
    model: config.model,
    input: [
      {
        role: "system",
        content: "제공된 한국어 상품 리뷰만 근거로 좋은 점, 아쉬운 점, 최종 결론을 각각 한 문장으로 작성한다. 광고성·중복·평점 불일치로 제외된 리뷰는 입력에 포함되지 않는다. 근거 없는 사실을 만들지 않는다.",
      },
      { role: "user", content: JSON.stringify(input) },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "review_analysis",
        strict: true,
        schema: {
          type: "object",
          properties: {
            positive: { type: "string" },
            negative: { type: "string" },
            conclusion: { type: "string" },
          },
          required: ["positive", "negative", "conclusion"],
          additionalProperties: false,
        },
      },
    },
  };
  if (config.provider === "openai") requestBody.store = false;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      console.error(JSON.stringify({
        message: "AI analysis request failed",
        provider: config.provider,
        status: response.status,
      }));
      return report;
    }
    const parsed = parseAiPayload(await response.json() as AiPayload);
    return parsed
      ? {
          ...report,
          verdict: parsed.conclusion,
          analysis: parsed,
          analysisProvider: config.provider,
        } as T
      : report;
  } catch (error) {
    console.error(JSON.stringify({
      message: "AI analysis unavailable; using rule-based fallback",
      provider: config.provider,
      error: error instanceof Error ? error.message : "unknown",
    }));
    return report;
  }
}
