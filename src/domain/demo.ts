import type { ProductIdentity, Report, ReviewClassification } from "./types";

const sampleTexts: Record<number, string[]> = {
  5: [
    "배송이 빨랐고 포장이 꼼꼼했어요. 가격 대비 품질도 기대 이상이라 만족합니다.",
    "한 달 정도 사용했는데 사용법이 간단하고 마감도 깔끔해요. 재구매 의향 있습니다.",
    "설명과 같은 제품이 왔고 옵션 색상도 화면과 거의 같았습니다.",
    "가볍지만 필요한 기능은 충분하고 일상에서 자주 쓰기 좋아요.",
    "선물용으로 주문했는데 포장이 깔끔하고 받는 분도 만족했습니다.",
  ],
  4: [
    "전체적으로 만족하지만 포장 상자 모서리가 조금 눌려서 왔어요.",
    "성능은 괜찮고 사용하기 편합니다. 다만 가격이 조금만 낮으면 좋겠어요.",
    "기대한 기능은 잘 되지만 색상이 사진보다 약간 어두운 편입니다.",
    "배송과 품질은 만족스럽고 설명서가 조금 더 자세했으면 합니다.",
    "크기가 예상보다 작지만 실제 사용에는 큰 불편이 없습니다.",
  ],
  3: [
    "기본 기능은 무난하지만 특별히 뛰어난 점은 잘 모르겠어요.",
    "배송은 빨랐지만 마감이 기대했던 것보다는 평범합니다.",
    "가격을 생각하면 나쁘지 않지만 장기간 사용해 봐야 알 것 같아요.",
    "사이즈를 꼼꼼히 확인하고 구매하는 것이 좋겠습니다.",
    "사용은 가능하지만 설명 이미지와 작은 차이가 있었습니다.",
  ],
  2: [
    "처음에는 괜찮았는데 며칠 사용하니 연결 부위가 헐거워졌어요.",
    "포장이 충분하지 않아 제품에 작은 흠집이 있었습니다.",
    "옵션을 잘못 받은 뒤 교환 과정이 오래 걸렸어요.",
    "크기와 색상이 상세 설명에서 기대한 것과 차이가 큽니다.",
    "기능은 하지만 가격 대비 마감 품질이 아쉽습니다.",
  ],
  1: [
    "받자마자 확인했는데 일부 부품이 빠져 있어 바로 교환을 요청했습니다.",
    "한 번 사용한 뒤 작동하지 않아 내구성이 많이 아쉽습니다.",
    "상세 페이지와 다른 옵션이 배송되어 반품했습니다.",
    "포장이 훼손된 상태로 도착했고 제품에도 사용 흔적이 있었습니다.",
    "고객 응답이 늦고 문제 해결까지 시간이 오래 걸렸습니다.",
  ],
};

export function createDemoReport(product: ProductIdentity): Report {
  const now = new Date();
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const ratings = ([5, 4, 3, 2, 1] as const).map((rating) => ({
    rating,
    checked: rating === 3 ? 0 : 118 - rating * 3,
    included: rating === 3 ? 0 : 100,
    excluded: rating === 3 ? 0 : 18 - rating,
    summary:
      rating >= 4
        ? "배송과 사용 편의성에 대한 만족이 많고 가격 대비 품질이 좋다는 의견이 반복됩니다."
        : rating === 3
          ? "최근 3점 리뷰가 확인되지 않았습니다."
          : "내구성과 포장 상태, 교환 응답 속도에 대한 아쉬움이 주로 언급됩니다.",
    reviews: (sampleTexts[rating] ?? []).map((content, index) => ({
      id: `${rating}-${index}`,
      rating,
      content,
      createdAt: new Date(now.getTime() - index * 86_400_000).toISOString(),
      classification: "included" as ReviewClassification,
    })),
  }));

  return {
    id: `demo-${product.source}-${product.productId}`,
    product: { ...product, name: "URL 확인 후 생성된 샘플 분석 보고서" },
    collectedAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    rawExpiresAt: inDays(7),
    reportExpiresAt: inDays(30),
    verdict: "배송·사용성 평가는 좋지만 내구성 불만이 반복돼 장기 사용은 신중한 선택이 필요해요.",
    confidence: 82,
    confidenceReasons: ["별점별 목표 리뷰의 80% 이상 확보", "핵심 장단점이 여러 리뷰에서 반복됨"],
    strengths: [
      { label: "빠른 배송", mentions: 74, ratio: 0.31 },
      { label: "쉬운 사용법", mentions: 61, ratio: 0.26 },
      { label: "가격 대비 품질", mentions: 43, ratio: 0.18 },
    ],
    cautions: [
      { label: "내구성", mentions: 29, ratio: 0.12 },
      { label: "포장 상태", mentions: 18, ratio: 0.08 },
      { label: "옵션 차이", mentions: 12, ratio: 0.05 },
    ],
    anomalyCounts: { sponsored: 11, duplicate: 8, rating_mismatch: 6, uncertain: 4 },
    ratings,
    limitations: ["현재 로컬 개발 모드이므로 실제 리뷰 대신 화면 검증용 샘플 데이터가 표시됩니다."],
    cached: false,
    demo: true,
  };
}
