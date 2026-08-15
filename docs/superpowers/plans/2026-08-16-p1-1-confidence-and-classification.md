# P1-1 분석 정확도·신뢰도 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 신뢰도 점수에 산식 버전·요소별 차감 사유·"만족도 아님" 상시 안내를 더하고,
확장의 리뷰 분류를 근접 중복 + 한국어 부정 표현까지 잡도록 보수적으로 강화한다.

**Architecture:** Part A는 Worker(`analyze.ts`)가 신뢰도 사유·버전을 계산해 보고서에
담고 프런트(`App.tsx`)가 렌더한다(웹/Worker 배포). Part B는 확장(`content.js`)의 두
분류 지점을 공유 헬퍼 `classifyReview`로 통합하고 근접 중복 키·부정 표현 카운트를
도입한다(TestFlight 빌드).

**Tech Stack:** TypeScript(Worker), React+Vite(웹), 순수 JS 확장(content script), Vitest.

## Global Constraints

- 분류는 **보수적**: 잘못 제외(false exclude)보다 포함이 낫다. 평점 불일치는 허위가
  아니라 "의심 신호"로만 다룬다.
- 신뢰도 **산식 가중치(35/25/20/10/10)는 변경 금지** — 설명·버전·표시만 추가한다.
- 새 보고서 필드는 **선택(옵셔널)** 으로 두어 구형 캐시 보고서에서 없으면 대체 표시.
- 신뢰도 산식 버전 문자열: `"2026-08"` (상수 `CONFIDENCE_VERSION`).
- 검증: `npm run worker:check`, `npm test`, `npm run build`가 모두 통과해야 한다.

---

## File Structure

- `worker/src/analyze.ts` — `confidence()`가 `explanations` 반환, `createReport`가
  `confidenceVersion`·`confidenceExplanations` 추가 (Task A1)
- `worker/src/analyze.test.ts` — A1 회귀 테스트
- `src/domain/types.ts` — `Report`에 `confidenceVersion?`·`confidenceExplanations?` (Task A2)
- `src/App.tsx`, `src/styles.css` — 신뢰도 카드 라벨/상시 문구/버전/사유 2열 렌더 (Task A2)
- `extension/content.js` — `nearDuplicateKey`·`countUnnegated`·`classifyReview` 추가,
  두 분류 지점을 헬퍼로 교체, 테스트 훅 노출 (Task B1)
- `extension/content.test.ts` — B1 회귀 테스트

---

## Task A1: Worker — 신뢰도 사유·산식 버전

**Files:**
- Modify: `worker/src/analyze.ts` (confidence() ~37-78, createReport confidence 사용부)
- Test: `worker/src/analyze.test.ts`

**Interfaces:**
- Produces: `confidence()` returns `{ score: number; breakdown: {...}; explanations: { completeness: string; evidence: string; consistency: string; freshness: string; health: string } }`.
  `createReport(...)` 결과에 `confidenceVersion: string`, `confidenceExplanations: {완성도 5키}` 추가.

- [ ] **Step 1: Write the failing test**

`worker/src/analyze.test.ts` 끝에 추가:

```ts
import { createReport } from "./analyze";
import type { StoredReview } from "./types";

it("records a confidence version and per-component explanations (P1-1)", () => {
  const rows: StoredReview[] = [
    { review_id: "a", rating: 5, content: "잘 쓰고 있어요 만족합니다", classification: "included", created_at: "2020-01-01T00:00:00.000Z" },
    { review_id: "b", rating: 1, content: "배송이 느려서 별로였어요", classification: "included", created_at: "2020-01-02T00:00:00.000Z" },
  ];
  const report = createReport("job-1", { source: "naver", productId: "1", name: "x" }, rows) as {
    confidenceVersion: string;
    confidenceExplanations: Record<string, string>;
    confidenceBreakdown: Record<string, number>;
  };

  expect(report.confidenceVersion).toBe("2026-08");
  expect(Object.keys(report.confidenceExplanations).sort()).toEqual(
    ["completeness", "consistency", "evidence", "freshness", "health"],
  );
  // 제외 0개 → 건전성 사유는 "제외 신호가 없어요"
  expect(report.confidenceExplanations.health).toContain("제외 신호가 없어요");
  // 2020년 리뷰만 → 최신성 사유는 "1년 이상"
  expect(report.confidenceExplanations.freshness).toContain("1년 이상");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run worker/src/analyze.test.ts -t "confidence version"`
Expected: FAIL — `report.confidenceVersion` is undefined.

- [ ] **Step 3: Add CONFIDENCE_VERSION and explanations in confidence()**

`worker/src/analyze.ts`에서 파일 상단(POSITIVE_ASPECTS 위)에 상수 추가:

```ts
const CONFIDENCE_VERSION = "2026-08";
```

`confidence()`의 `const health = ...` 다음 줄부터 `const breakdown = {` 앞에 삽입:

```ts
  const fullyCollected = counts.filter((value) => value >= 0.999).length;
  const explanations = {
    completeness: fullyCollected >= 5
      ? "모든 별점을 원본 수준으로 수집했어요."
      : `일부 별점(${5 - fullyCollected}개)이 원본 대비 덜 수집됐어요.`,
    evidence: reviews.length >= 100
      ? `분석 리뷰 ${reviews.length}개로 근거가 충분해요.`
      : `분석 리뷰가 ${reviews.length}개로 다소 적어요.`,
    consistency: consistency >= 0.6
      ? "같은 의견이 뚜렷하게 반복돼요."
      : consistency > 0
        ? "반복되는 의견이 다소 있어요."
        : "반복되는 의견이 뚜렷하지 않아요.",
    freshness: reviews.length === 0
      ? "작성일을 확인할 수 있는 리뷰가 없어요."
      : freshness >= 0.7
        ? "최근에 작성된 리뷰가 많아요."
        : freshness >= 0.4
          ? "최근·오래된 리뷰가 섞여 있어요."
          : "리뷰 대부분이 1년 이상 전에 작성됐어요.",
    health: excluded === 0
      ? "제외 신호가 없어요 (0개가 진위를 보증한다는 뜻은 아니에요)."
      : `의심 신호 ${excluded}개를 분석에서 제외했어요.`,
  };
```

같은 함수의 `return { score: ..., breakdown };`를 다음으로 교체:

```ts
  return {
    score: Math.min(Object.values(breakdown).reduce((sum, value) => sum + value, 0), 100),
    breakdown,
    explanations,
  };
```

- [ ] **Step 4: Add fields in createReport**

`createReport`의 반환 객체에서 `confidenceBreakdown: confidenceResult.breakdown,` 다음 줄에 추가:

```ts
    confidenceVersion: CONFIDENCE_VERSION,
    confidenceExplanations: confidenceResult.explanations,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run worker/src/analyze.test.ts` then `npm run worker:check`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add worker/src/analyze.ts worker/src/analyze.test.ts
git commit -m "feat(worker): confidence version and per-component explanations (P1-1)"
```

---

## Task A2: Frontend — 신뢰도 카드/상세 렌더

**Files:**
- Modify: `src/domain/types.ts` (Report ~113-121), `src/App.tsx` (ReportView confidence ~952-968), `src/styles.css`

**Interfaces:**
- Consumes: `report.confidenceVersion?`, `report.confidenceExplanations?` (Task A1). 없으면 대체 표시.

- [ ] **Step 1: Extend Report type**

`src/domain/types.ts`에서 `confidenceReasons: string[];` 앞에 추가:

```ts
  confidenceVersion?: string;
  confidenceExplanations?: {
    completeness: string;
    evidence: string;
    consistency: string;
    freshness: string;
    health: string;
  };
```

- [ ] **Step 2: Add component metadata in App.tsx**

`function ReportView(` 위(모듈 스코프)에 추가:

```tsx
const CONFIDENCE_COMPONENTS = [
  { key: "completeness", label: "별점별 수집 완성도", max: 35 },
  { key: "evidence", label: "분석 리뷰의 충분성", max: 25 },
  { key: "consistency", label: "반복 의견의 강도", max: 20 },
  { key: "freshness", label: "리뷰 최신성", max: 10 },
  { key: "health", label: "의심 신호를 제외한 데이터 건전성", max: 10 },
] as const;
```

- [ ] **Step 3: Replace the confidence card block**

`src/App.tsx`의 confidence `<div className="confidence"> ... </div>` 블록에서
`<div><span>신뢰도 {confidenceLabel}</span><small>{report.confidenceReasons[0]}</small></div>`
를 다음으로 교체:

```tsx
          <div className="confidence-copy">
            <span>데이터 신뢰도 · {confidenceLabel} <em className="confidence-tag">데이터 충분성</em></span>
            <small>{report.confidenceReasons[0]}</small>
            <p className="confidence-note">상품이 좋고 나쁨이 아니라, 이 결론을 뒷받침할 리뷰 데이터가 얼마나 충분하고 일관적인지를 나타냅니다.</p>
          </div>
```

- [ ] **Step 4: Replace the confidence-explain details body**

`<details className="confidence-explain">` 내부의 `<summary>...</summary>`와 그 다음 `<div>...5 spans...</div>`를 다음으로 교체(마지막 `<p>`는 유지):

```tsx
        <summary>
          신뢰도 점수는 어떻게 계산하나요?
          {report.confidenceVersion && <span className="confidence-ver">산식 v{report.confidenceVersion}</span>}
        </summary>
        <div className="confidence-rows">
          {CONFIDENCE_COMPONENTS.map(({ key, label, max }) => (
            <div className="confidence-row" key={key}>
              <span className="confidence-score">
                {report.confidenceBreakdown ? report.confidenceBreakdown[key] : "–"}<small>/{max}</small>
              </span>
              <span className="confidence-why">
                <strong>{label}</strong>{report.confidenceExplanations ? ` — ${report.confidenceExplanations[key]}` : ""}
              </span>
            </div>
          ))}
        </div>
```

- [ ] **Step 5: Add styles**

`src/styles.css`의 `.confidence-explain` 관련 규칙 근처에 추가:

```css
.confidence-copy { display: grid; gap: 4px; }
.confidence-tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: rgba(255,255,255,.16); color: #fff; font-size: 9px; font-weight: 800; letter-spacing: .05em; font-style: normal; vertical-align: 2px; }
.confidence-note { margin: 4px 0 0; color: rgba(255,255,255,.72); font-size: 12px; line-height: 1.55; }
.confidence-ver { margin-left: 8px; color: #9a9488; font-size: 11px; font-weight: 700; }
.confidence-rows { margin-top: 12px; display: grid; grid-template-columns: 1fr; gap: 10px; }
.confidence-row { display: grid; grid-template-columns: max-content 1fr; column-gap: 32px; align-items: baseline; }
.confidence-score { font-size: 13px; font-weight: 800; color: var(--green); white-space: nowrap; }
.confidence-score small { color: #a7a196; font-weight: 700; }
.confidence-why { color: #6c675e; font-size: 13px; line-height: 1.5; }
```

- [ ] **Step 6: Build and verify**

Run: `npm run build`
Expected: 빌드 성공(타입 오류 없음). App.tsx는 단위 테스트가 없으므로 빌드 통과로 확인.
`report.confidenceBreakdown[key]`의 `key` 타입이 안 맞으면 `CONFIDENCE_COMPONENTS`의
`key`를 `keyof NonNullable<Report["confidenceBreakdown"]>`로 캐스팅한다.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/App.tsx src/styles.css
git commit -m "feat(web): confidence explanations, version, and data-vs-quality note (P1-1)"
```

---

## Task B1: 확장 — 공유 분류 헬퍼(근접 중복 + 부정 표현)

**Files:**
- Modify: `extension/content.js` (분류 지점 2곳: readVisibleNaverReviews ~936-947, readVisibleReviews ~1214-1225; 테스트 훅)
- Test: `extension/content.test.ts`

**Interfaces:**
- Produces: `nearDuplicateKey(content: string): string`, `countUnnegated(content: string, words: string[]): number`, `classifyReview(content: string, rating: number, nearKeys: Set<string>): "included"|"sponsored"|"duplicate"|"rating_mismatch"`.

- [ ] **Step 1: Write the failing test**

`extension/content.test.ts`의 `CollectorHooks` 타입에 추가:

```ts
  classifyReview(content: string, rating: number, nearKeys: Set<string>): string;
  nearDuplicateKey(content: string): string;
```

그리고 `describe("review collector", ...)` 안에 테스트 추가:

```ts
  it("classifies near-duplicates and respects Korean negation (P1-1)", () => {
    const keys = new Set<string>();
    expect(collector.classifyReview("정말 좋아요, 잘 쓰고 있어요!", 5, keys)).toBe("included");
    // 문장부호만 다른 근접 중복 → duplicate
    expect(collector.classifyReview("정말 좋아요 잘 쓰고 있어요..", 5, keys)).toBe("duplicate");
    // 낮은 별점 + '부정된 긍정어'는 불일치로 보지 않는다(보수적)
    expect(collector.classifyReview("만족하지 않아요. 추천하지 않아요.", 1, new Set())).toBe("included");
    // 진짜 긍정인데 낮은 별점이면 불일치 신호
    expect(collector.classifyReview("만족스럽고 추천해요.", 1, new Set())).toBe("rating_mismatch");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run extension/content.test.ts -t "near-duplicates"`
Expected: FAIL — `collector.classifyReview is not a function`.

- [ ] **Step 3: Add helpers in content.js**

`function fingerprint(` 정의 근처(모듈 스코프)에 추가:

```js
// 문장부호·공백 차이를 무시한 "근접 중복 키". 앞부분 40자 + 정렬된 대표 토큰으로
// 살짝 다른 복붙 리뷰까지 같은 키로 묶는다. 모바일 성능 위해 O(n) 버킷팅만 쓴다.
function nearDuplicateKey(content) {
  const cleaned = content.toLowerCase().replace(/[^0-9a-z가-힣\s]/g, " ").replace(/\s+/g, " ").trim();
  const head = cleaned.replace(/\s/g, "").slice(0, 40);
  const tokens = [...new Set(cleaned.split(" ").filter((token) => token.length >= 2))].sort().slice(0, 8).join("|");
  return `${head}#${tokens}`;
}

// 부정 표현("좋지 않다/만족하지 못했다" 등)으로 뒤집힌 단어는 세지 않는다.
function countUnnegated(content, words) {
  const lower = content.toLowerCase();
  return words.filter((word) => {
    const idx = lower.indexOf(word.toLowerCase());
    if (idx === -1) return false;
    const after = content.slice(idx, idx + word.length + 6);
    return !/(지\s*(않|못)|진\s*않|지도\s*않)/.test(after);
  }).length;
}

// 광고성 > 근접중복 > 평점불일치 > 포함 순으로 판정한다. 근접 키는 분류와 무관하게
// 항상 등록해 이후 동일 리뷰를 중복으로 잡는다. 불일치는 부정 표현을 반영해 보수적으로.
function classifyReview(content, rating, nearKeys) {
  const lower = content.toLowerCase();
  const key = nearDuplicateKey(content);
  const isDuplicate = nearKeys.has(key);
  nearKeys.add(key);
  if (SPONSORED_WORDS.some((word) => lower.includes(word.toLowerCase()))) return "sponsored";
  if (isDuplicate) return "duplicate";
  if (rating >= 4 && countUnnegated(content, NEGATIVE_WORDS) >= 2) return "rating_mismatch";
  if (rating <= 2 && countUnnegated(content, POSITIVE_WORDS) >= 2) return "rating_mismatch";
  return "included";
}
```

- [ ] **Step 4: Replace the Naver classification site**

`readVisibleNaverReviews` 안의 아래 블록:

```js
    const bodyFingerprint = fingerprint(content);
    let classification = "included";
    const lower = content.toLowerCase();
    if (SPONSORED_WORDS.some((word) => lower.includes(word.toLowerCase()))) {
      classification = "sponsored";
    } else if (options.duplicateBodies.has(bodyFingerprint)) {
      classification = "duplicate";
    } else if (rating >= 4 && NEGATIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    } else if (rating <= 2 && POSITIVE_WORDS.filter((word) => lower.includes(word)).length >= 2) {
      classification = "rating_mismatch";
    }
    options.duplicateBodies.add(bodyFingerprint);
```

을 다음 한 줄로 교체:

```js
    const classification = classifyReview(content, rating, options.duplicateBodies);
```

- [ ] **Step 5: Replace the generic classification site**

`readVisibleReviews`(≈1214-1225)의 동일한 분류 블록도 Step 4와 똑같이
`const classification = classifyReview(content, rating, options.duplicateBodies);`
한 줄로 교체한다(해당 블록의 `bodyFingerprint`/`fingerprint(content)`/`duplicateBodies.add` 포함 삭제).

- [ ] **Step 6: Expose helpers for tests**

`globalThis.REVIEWMOA_COLLECTOR_TEST = Object.freeze({` 목록에 알파벳 순서에 맞춰 추가:

```js
  classifyReview,
  nearDuplicateKey,
```

- [ ] **Step 7: Run tests + syntax check**

Run: `node --check extension/content.js` then `npx vitest run extension/content.test.ts`
Expected: 문법 OK, 신규·기존 테스트 모두 PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/content.js extension/content.test.ts
git commit -m "feat(extension): shared near-duplicate + negation-aware review classifier (P1-1)"
```

---

## 배포 (구현 완료 후, 사용자 확인 하)

- Part A(A1·A2): master push → GitHub Pages 자동 + `npx wrangler deploy --config worker/wrangler.toml`. 마이그레이션 없음.
- Part B(B1): `npm run safari:release:prepare` → `safari:archive`/`safari:export` → Organizer 업로드(빌드 135). 운영자 실기기 테스트.

## Self-Review 결과

- **Spec 커버리지**: A1(버전·사유)·A2(카드/상세/만족도 구분)·B1(근접 중복·부정 표현) 모두 태스크로 매핑됨.
- **Placeholder**: 없음(모든 스텝에 실제 코드/명령).
- **타입 일관성**: `confidenceExplanations` 5키(completeness/evidence/consistency/freshness/health)가 Worker·타입·프런트에서 동일. `classifyReview` 시그니처 Task 전반 일치.
