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
    confidence: confidence(included, excluded),
    confidenceReasons: [
      `별점별 정상 리뷰 ${included.length}개 반영`,
      `의심 신호 ${excluded}개를 주 분석에서 제외`,
    ],
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
    limitations: included.length < 50 ? ["표본이 적어 신뢰도가 낮을 수 있습니다."] : [],
    cached: false,
  };
}

export async function enhanceVerdictWithAi<T extends Record<string, unknown>>(
  report: T,
  reviews: StoredReview[],
  apiKey: string | undefined,
  model = "gpt-5-mini",
): Promise<T> {
  if (!apiKey || reviews.length === 0) return report;
  const input = reviews.slice(0, 500).map((review) => ({
    rating: review.rating,
    content: review.content.slice(0, 700),
  }));
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: "system",
          content: "한국어 상품 리뷰만 근거로 좋은 점, 나쁜 점, 최종 결론을 각각 한 문장으로 작성한다. 근거 없는 사실을 만들지 않는다.",
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
              conclusion: { type: "string" }
            },
            required: ["positive", "negative", "conclusion"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) return report;
  const payload = await response.json() as { output_text?: string };
  try {
    const parsed = JSON.parse(payload.output_text ?? "{}") as {
      positive?: string;
      negative?: string;
      conclusion?: string;
    };
    return parsed.positive && parsed.negative && parsed.conclusion
      ? { ...report, verdict: parsed.conclusion, analysis: parsed } as T
      : report;
  } catch {
    return report;
  }
}
