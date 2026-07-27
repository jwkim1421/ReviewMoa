import type { ProductIdentity, RawReview, Report } from "./types";

const POSITIVE = [
  ["빠른 배송", /배송.{0,8}(빠르|빨랐|만족)|빨리.{0,5}(도착|왔)/],
  ["쉬운 사용법", /사용.{0,8}(편하|쉬|간단)|설치.{0,5}(쉽|간단)/],
  ["가격 대비 품질", /가성비|가격.{0,8}(만족|좋)|품질.{0,8}(좋|만족)/],
] as const;

const CAUTION = [
  ["내구성", /고장|내구성|부러|헐거|망가/],
  ["포장 상태", /포장.{0,8}(아쉽|훼손|파손|눌)|상자.{0,5}(눌|뜯)/],
  ["옵션 차이", /옵션.{0,8}(다르|잘못)|색상.{0,8}(다르|차이)|사이즈.{0,8}(다르|작|크)/],
] as const;

function aspects(reviews: RawReview[], definitions: ReadonlyArray<readonly [string, RegExp]>) {
  return definitions.map(([label, pattern]) => {
    const mentions = reviews.filter((review) => pattern.test(review.content)).length;
    return { label, mentions, ratio: mentions / Math.max(reviews.length, 1) };
  }).sort((a, b) => b.mentions - a.mentions);
}

export function createLocalReport(product: ProductIdentity, raw: RawReview[], productName: string): Report {
  const rows = raw
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 3000);
  const included = rows.filter((review) => ["included", "uncertain"].includes(review.classification));
  const strengths = aspects(included, POSITIVE);
  const cautions = aspects(included, CAUTION);
  const now = new Date();
  const expires = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const anomalyCounts = {
    sponsored: rows.filter((review) => review.classification === "sponsored").length,
    duplicate: rows.filter((review) => review.classification === "duplicate").length,
    rating_mismatch: rows.filter((review) => review.classification === "rating_mismatch").length,
    uncertain: rows.filter((review) => review.classification === "uncertain").length,
  };
  const excluded = anomalyCounts.sponsored + anomalyCounts.duplicate + anomalyCounts.rating_mismatch;
  const coverage = [1, 2, 3, 4, 5]
    .map((rating) => Math.min(included.filter((review) => review.rating === rating).length / 100, 1))
    .reduce((sum, score) => sum + score, 0) / 5;
  const confidence = Math.round(
    coverage * 35 +
    Math.min(included.length / 300, 1) * 25 +
    35 +
    (1 - excluded / Math.max(rows.length, 1)) * 5,
  );
  const strength = strengths.find((item) => item.mentions > 0)?.label;
  const caution = cautions.find((item) => item.mentions > 0)?.label;
  const positive = strength
    ? `${strength}에 대한 만족이 반복적으로 확인됐어요.`
    : "뚜렷하게 반복되는 좋은 점은 아직 확인되지 않았어요.";
  const negative = caution
    ? `${caution}에 대한 불만이 있어 구매 전에 확인이 필요해요.`
    : "반복적으로 나타나는 큰 불만은 아직 확인되지 않았어요.";
  const conclusion = strength && caution
    ? `${strength}을 중요하게 본다면 적합하지만 ${caution}이 걱정된다면 비교 후 선택하세요.`
    : strength
      ? `${strength}을 중요하게 보는 구매자에게 무난한 선택이에요.`
      : "표본이 충분하지 않아 대표 원문을 먼저 확인하는 편이 안전해요.";

  return {
    id: crypto.randomUUID(),
    product: { ...product, name: productName },
    collectedAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    rawExpiresAt: expires(7),
    reportExpiresAt: expires(30),
    verdict: strength && caution
      ? `${strength} 평가는 좋지만 ${caution} 불만이 있어 구매 전 확인이 필요해요.`
      : strength
        ? `${strength} 만족이 반복되지만 별점별 원문도 함께 확인하는 것이 좋아요.`
        : "충분한 반복 의견이 없어 별점별 대표 원문을 먼저 확인하는 편이 안전해요.",
    analysis: { positive, negative, conclusion },
    confidence,
    confidenceReasons: [`별점별 정상 리뷰 ${included.length}개 반영`, `의심 신호 ${excluded}개 제외`],
    strengths,
    cautions,
    anomalyCounts,
    ratings: ([5, 4, 3, 2, 1] as const).map((rating) => {
      const checked = rows.filter((review) => review.rating === rating);
      const accepted = checked.filter((review) => ["included", "uncertain"].includes(review.classification)).slice(0, 100);
      return {
        rating,
        checked: checked.length,
        included: accepted.length,
        excluded: checked.length - accepted.length,
        summary: accepted.length
          ? `${rating}점 최신 정상 리뷰 ${accepted.length}개를 확인했습니다.`
          : `최근 ${rating}점 리뷰가 확인되지 않았습니다.`,
        reviews: accepted.slice(0, 10),
      };
    }),
    limitations: [
      "현재 화면에 공개된 리뷰만 수집했습니다. 리뷰 탭의 추가 페이지는 사이트별 검증 후 순차 지원합니다.",
    ],
    cached: false,
  };
}
