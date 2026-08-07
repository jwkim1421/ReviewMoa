# 리뷰모아 개발 인수인계 문서

> 기준일: 2026-07-28  
> 저장소: <https://github.com/jwkim1421/ReviewMoa>  
> 운영 웹: <https://reviewmoa.kro.kr>  
> 운영 API: <https://reviewmoa-api.reviewmoa.workers.dev>  
> 기준 브랜치: `master`  
> 문서 작성 시점 최근 커밋: `1cbb77a` (`Fix Worker CORS preflight response`)

## 0. 가장 먼저 읽을 요약

리뷰모아는 네이버, 쿠팡, 컬리, 오늘의집, 11번가, SSG닷컴, G마켓 상품 URL을
입력받아 공개된 최신 리뷰를 별점별로 수집하고, 광고성·중복·평점 불일치 의심
리뷰를 주 분석에서 분리한 뒤 구매 인사이트를 보여 주는 비공개 베타 프로젝트다.

현재 웹, Cloudflare Worker, D1, OpenRouter 분석, 브라우저 확장 프로그램의 기본
골격은 구현되어 있다. 그러나 현재 수집 흐름은 **리뷰모아 웹사이트를 연 것과 같은
PC·브라우저에 확장 프로그램이 설치되어 있어야만 동작**한다. 회사 PC에서는
Waterwall이 로컬 확장 프로그램 로드를 막고 Fortinet이 일부 쇼핑몰 HTTPS 접속을
차단했다. 아이폰 Chrome/Safari에서는 현재의 Chrome 확장 프로그램을 실행할 수
없다.

따라서 앞으로의 핵심 방향은 다음과 같이 확정한다.

```text
아이폰 또는 일반 사용자
  → reviewmoa.kro.kr에 상품 URL 제출
  → Cloudflare Worker/D1에 수집 작업 생성
  → 운영자 집의 중앙 수집 PC가 작업을 가져감
  → 중앙 PC의 실제 Chrome 프로필에서 리뷰 수집
  → Worker에 리뷰 업로드 및 OpenRouter 분석
  → 아이폰/웹에서 진행 상태와 결과 보고서 확인
```

사용자별 PC와 아이폰을 페어링하는 구조가 아니다. **운영자 소유 PC 한 대가 모든
사용자의 중앙 수집 서버 역할**을 한다. Cloudflare Browser Run은 무료 플랜의
브라우저 실행 시간이 하루 10분이라 주 수집 수단으로 사용하지 않는다. Cloudflare는
작업 조정, 데이터 저장, API, AI 분석을 담당하고 실제 쇼핑몰 탐색은 중앙 PC가
담당한다.

현재 7개 쇼핑몰의 셀렉터는 모두 “자동 탐색 후보” 수준이다. 실제 상품별 검증이
끝나지 않았으므로 정식 지원 완료로 표시하면 안 된다.

---

## 1. 제품 목적

### 1.1 해결하려는 문제

- 쇼핑몰마다 흩어진 리뷰를 구매자가 일일이 읽어야 한다.
- 전체 평점만으로는 1점과 5점에서 반복되는 서로 다른 문제를 알기 어렵다.
- 협찬·체험단, 중복 문장, 본문 감성과 평점이 크게 어긋나는 리뷰가 분석을 왜곡할 수
  있다.
- 리뷰가 많아도 실제 구매 결론으로 정리하는 데 시간이 오래 걸린다.

### 1.2 목표 사용자 경험

1. 아이폰이나 PC에서 상품 URL 하나를 입력한다.
2. 캐시가 있으면 기존 보고서를 즉시 확인한다.
3. 캐시가 없으면 중앙 수집 PC로 작업이 전달된다.
4. 화면에는 `대기 중 → 접근 확인 → 수집 중 → 분석 중 → 완료` 상태가 표시된다.
5. 완료 후 좋은 점, 아쉬운 점, 최종 결론의 3문장 분석을 확인한다.
6. 별점 5점부터 1점까지 실제 선정 개수와 대표 원문 최대 10개를 확인한다.
7. 기존 결과가 오래되었으면 `다시 불러오기`로 재수집한다.

### 1.3 수집 원칙

- 별점 필터가 있으면 각 별점별 최신 정상 리뷰 최대 100개를 선정한다.
- 정상 리뷰 100개를 확보하기 위해 별점당 후보 최대 300개까지 검사한다.
- 별점 필터가 없으면 전체 최신 후보 최대 3,000개를 검사해 별점별로 나눈다.
- 실제 3점 리뷰가 없으면 `3점 리뷰 0개`로 표시한다.
- 리뷰 영역 탐색 실패를 리뷰 0개로 처리하지 않는다.
- 광고성, 중복, 평점 불일치 의심 리뷰는 주 분석에서 제외한다.
- 확신이 낮은 `uncertain` 리뷰는 포함하되 향후 낮은 가중치를 적용할 수 있다.
- 평점 불일치는 허위 리뷰라는 뜻이 아니므로 “의심 신호”로만 표현한다.
- CAPTCHA 자동 풀이, 접근통제 우회, 프록시·계정 순환은 구현하지 않는다.

### 1.4 보존 원칙

- 전체 수집 원문: 최대 7일
- 집계와 분석 보고서: 최대 30일
- 7일 이내 캐시: 보고서와 대표 원문 복원
- 8~30일 캐시: 보고서는 표시하되 대표 원문 만료 안내
- 30일 초과: 새 수집이 기본이며 기존 보고서 삭제

현재 구현은 읽을 때 대표 원문을 숨기지만 저장된 `report_json` 자체에는 대표 원문이
30일까지 남을 수 있다. 이는 미해결 보존 정책 버그이며 후속 작업에서 반드시
수정해야 한다.

---

## 2. 확정된 목표 아키텍처

## 2.1 구성 요소

### 웹 프런트엔드

- React 19 + TypeScript + Vite
- GitHub Pages 배포
- 사용자 URL 입력, 캐시 조회, 작업 생성, 진행률 폴링, 결과 표시
- 모바일 Safari를 포함한 일반 브라우저에서 별도 앱 없이 사용

### Cloudflare Worker API

- 외부 사용자 요청을 받는 유일한 공개 API
- URL과 작업 상태 관리
- 중앙 수집 PC가 가져갈 작업 대기열 제공
- 리뷰 배치 저장
- 규칙 기반 집계와 OpenRouter 분석
- 보고서 캐시와 보존 기간 관리

### Cloudflare D1

- 상품과 수집 작업
- 작업 임대(lease), 재시도 횟수, 진행 상태
- 수집한 리뷰와 분류 결과
- 보고서 캐시
- AI 일별 호출 수

### 중앙 수집 PC

- 운영자 집의 보안 제한 없는 Windows PC를 전제로 한다.
- Node.js + Playwright 기반의 별도 `collector` 프로세스를 권장한다.
- 사용자가 쓰는 브라우저 확장 프로그램이 아니라, 중앙 PC에서 계속 실행되는
  수집 데몬이다.
- Worker를 주기적으로 조회해 대기 작업 하나를 원자적으로 가져온다.
- 실제 Chrome 사용자 프로필을 재사용하여 필요한 로그인 세션을 중앙 PC에만 둔다.
- 쇼핑몰 로그인 쿠키와 비밀번호는 Worker로 보내지 않는다.
- CAPTCHA 또는 추가 로그인이 필요하면 운영자에게 알리고 작업을 일시 중지한다.

### OpenRouter

- Worker Secret `OPENROUTER_API_KEY`를 통해서만 호출한다.
- 기본 라우터는 `openrouter/free`다.
- AI 호출 실패 또는 일일 한도 초과 시 규칙 기반 결과를 유지한다.
- 브라우저나 중앙 수집 PC에 OpenRouter 키를 넣지 않는다.

## 2.2 목표 요청 흐름

```text
[사용자/아이폰]
  POST /v1/jobs
        │
        ▼
[Worker + D1]
  queued 상태 저장
        │
        ▼
[중앙 수집 PC]
  POST /v1/collector/claim
  작업 임대 후 브라우저 탐색
        │
        ├─ 진행률/heartbeat 전송
        ├─ 로그인/CAPTCHA → waiting_for_operator
        └─ 리뷰 배치 업로드
        │
        ▼
[Worker]
  필터 통계 검증 → OpenRouter 분석 → 보고서 저장
        │
        ▼
[사용자/아이폰]
  GET /v1/jobs/{id} 폴링 → 보고서 표시
```

## 2.3 중앙 수집 PC를 선택한 이유

- 모바일 사용자가 확장 프로그램을 설치할 필요가 없다.
- 중앙 PC 한 대에만 쇼핑몰 로그인을 유지하면 된다.
- Cloudflare Browser Run의 짧은 무료 실행 시간에 의존하지 않는다.
- 중앙 PC가 외부로 Worker API를 호출하므로 공유기 포트 개방이 필요 없다.
- 중앙 PC의 실제 가정용 네트워크와 브라우저 세션을 사용할 수 있다.

## 2.4 중앙 수집 PC의 제약

- PC가 꺼져 있거나 인터넷이 끊기면 모든 신규 작업이 대기한다.
- 한 대의 PC가 단일 장애 지점이다.
- 여러 사용자가 동시에 요청하면 순차 처리와 대기열이 필요하다.
- 로그인 만료, CAPTCHA, 쇼핑몰 차단은 완전 무인 처리가 불가능하다.
- 회사 보안 PC는 중앙 수집기로 사용하지 않는다.
- 공개 서비스가 커지면 쇼핑몰 약관, 리뷰 재게시, 개인정보 처리 검토가 선행되어야
  한다.

---

## 3. 현재 저장소 구조

```text
ReviewMoa/
├─ .github/workflows/
│  ├─ pages.yml             # master/main push 시 웹 자동 배포
│  └─ worker.yml            # 수동 Worker 배포
├─ docs/
│  └─ access-matrix.md      # 쇼핑몰별 실상품 검증 현황
├─ extension/
│  ├─ manifest.json         # Manifest V3
│  ├─ bridge.js             # 웹 ↔ 확장 프로그램 메시지 브리지
│  ├─ background.js         # 탭 생성, 작업/결과 로컬 저장
│  ├─ content.js            # 리뷰 탐색·추출·분류
│  ├─ site-configs.js       # 7개 사이트 후보 셀렉터
│  └─ popup.*               # 로그인/CAPTCHA 후 수동 재개
├─ src/
│  ├─ App.tsx               # 홈, 접근 확인, 보고서, 아이디어 기여 UI
│  ├─ domain/
│  │  ├─ url.ts             # URL 추출·정규화·상품 ID 판별
│  │  ├─ analyze.ts         # 로컬 규칙 기반 분석
│  │  └─ types.ts           # 공용 프런트 타입
│  └─ lib/
│     ├─ api.ts             # Worker API 클라이언트
│     └─ extension.ts       # 같은 브라우저의 확장 프로그램 호출
├─ worker/
│  ├─ migrations/
│  │  ├─ 0001_initial.sql
│  │  └─ 0002_ai_daily_usage.sql
│  ├─ src/
│  │  ├─ index.ts           # Worker 라우팅과 D1 처리
│  │  ├─ analyze.ts         # 서버 집계·신뢰도·OpenRouter 보강
│  │  └─ types.ts
│  └─ wrangler.toml
├─ public/CNAME             # reviewmoa.kro.kr
├─ README.md
└─ HANDOFF.md               # 이 문서
```

중앙 수집 서버 전환 시 다음 폴더를 추가하는 것을 권장한다.

```text
collector/
├─ src/
│  ├─ index.ts              # 폴링, claim, heartbeat, 종료 처리
│  ├─ api.ts                # 인증된 collector API
│  ├─ browser.ts            # Playwright persistent context
│  ├─ collect.ts            # 공통 수집 오케스트레이션
│  ├─ classify.ts           # 광고성·중복·불일치 분류
│  └─ adapters/
│     └─ naver.ts           # 첫 실검증 어댑터
├─ tests/fixtures/
├─ package.json             # 필요 시 루트 package.json을 먼저 재사용
└─ README.md
```

처음부터 7개 사이트를 위한 과도한 공통 프레임워크를 만들지 않는다. 네이버 실제
상품 10개로 계약을 검증한 후 두 번째 사이트를 추가하면서 공통 인터페이스를
추출한다.

---

## 4. 현재 구현된 기능

| 영역 | 현재 상태 | 비고 |
|---|---|---|
| 랜딩 페이지 | 구현 | 모바일 반응형 UI 포함 |
| URL 정규화 | 구현 | 문장 속 URL, 프로토콜 누락, 추적 파라미터 일부 제거 |
| 7개 쇼핑몰 식별 | 구현 | 상품 ID 패턴이 불완전할 수 있음 |
| 기타 사이트 식별 | 프런트만 부분 구현 | 확장 프로그램 host 권한이 없어 실제 수집 불가 |
| 접근 확인 화면 | 구현 | 실제 Worker probe는 아직 정적 `partial` 응답 |
| 같은 브라우저 확장 연결 | 구현 | `PING`, `START`, `GET_STATE` |
| 리뷰 탭 탐색 | 후보 구현 | 실상품 검증 필요 |
| 최신순 정렬 | 후보 구현 | 사이트별 검증 필요 |
| 별점 5→1 필터 | 후보 구현 | 필터가 모두 확인될 때 별점별 수집 |
| 페이지/더보기/스크롤 | 후보 구현 | 최대 40회 탐색 |
| 별점별 최대 100개 | 구현 | 별점당 최대 후보 300개 |
| 필터 없는 사이트 | 구현 골격 | 전체 후보 최대 3,000개 |
| 광고성 분류 | 간단 규칙 구현 | 체험단·협찬·무료 제공 등의 키워드 |
| 중복 분류 | 간단 구현 | 정규화된 본문 지문 기반, 근접 중복은 부족 |
| 평점 불일치 | 간단 규칙 구현 | 긍정/부정 키워드 개수 기반 |
| 로그인/CAPTCHA 감지 | 부분 구현 | 운영자 중앙 처리 흐름은 미구현 |
| 대표 원문 | 구현 | 별점별 최대 10개 |
| AI 3문장 분석 | 구현 | 좋은 점·아쉬운 점·결론 |
| OpenRouter 연동 | 구현 및 원격 확인 | 실패 시 규칙 기반 폴백 |
| AI 일일 제한 | 구현 | 전체 서비스 기준 40회 |
| D1 작업/리뷰/보고서 | 구현 | 중앙 수집용 claim/lease는 없음 |
| 7일/30일 캐시 응답 | 부분 구현 | 저장 시 원문 완전 제거는 미구현 |
| 다시 불러오기 | UI 구현 | 별도 refresh API 대신 같은 브라우저 재수집 |
| 아이디어 기여 | 구현 | GitHub Issue 작성 화면으로 이동 |
| GitHub Pages 배포 | 구현·운영 중 | `master` push 시 자동 |
| Worker 배포 | 구현 | 로컬 Wrangler 또는 수동 Actions |
| HTTPS/CORS | 구현·검증 | 운영 Origin 기준 실제 확인 완료 |

---

## 5. 현재 API와 데이터 모델

## 5.1 현재 공개 API

| 메서드 | 경로 | 현재 동작 |
|---|---|---|
| `GET` | `/health` | Worker 상태 확인 |
| `POST` | `/v1/products/resolve` | 전달받은 `product`를 그대로 반환; 실질 정규화 안 함 |
| `POST` | `/v1/jobs/probe` | 캐시 조회 후 정적 `partial` capability 반환 |
| `POST` | `/v1/jobs` | `probing` 작업 생성 |
| `POST` | `/v1/jobs/{id}/reviews` | 리뷰 후보 최대 500개 저장 |
| `POST` | `/v1/jobs/{id}/complete` | 보고서 생성 및 AI 분석 |
| `POST` | `/v1/jobs/{id}/resume` | 작업을 `probing`으로 변경 |
| `POST` | `/v1/jobs/{id}/refresh` | 같은 상품의 새 작업 생성 |
| `GET` | `/v1/jobs/{id}` | 작업과 보고서 조회 |
| `DELETE` | `/v1/jobs/{id}` | 작업·리뷰·보고서 삭제 |

현재 `/reviews`와 `/complete`는 인증 없이 외부에서 호출할 수 있다. 중앙 수집 서버
도입 전에 반드시 collector 전용 인증 경로로 옮기거나 인증을 추가해야 한다.

## 5.2 현재 D1 테이블

### `jobs`

- `id`
- `cache_key`
- `product_json`
- `status`
- `capability_json`
- `error_code`
- `created_at`
- `updated_at`

### `reviews`

- `job_id`, `review_id` 복합 기본키
- `rating`
- `content`
- `created_at`
- `option_name`
- `classification`
- `raw_expires_at`

### `reports`

- `cache_key` 기본키
- `job_id`
- `report_json`
- `collected_at`
- `raw_expires_at`
- `report_expires_at`

### `ai_daily_usage`

- UTC 날짜별 OpenRouter/OpenAI 요청 예약 개수

## 5.3 중앙 수집 전환에 필요한 D1 변경안

다음 마이그레이션은 `0003_collector_queue.sql`처럼 새 파일로 추가한다. 기존
마이그레이션을 수정하지 않는다.

`jobs`에 최소 다음 필드가 필요하다.

- `requested_at`: 사용자가 요청한 시각
- `started_at`: 중앙 PC가 작업을 가져간 시각
- `finished_at`: 완료 또는 실패 시각
- `claimed_by`: 중앙 수집기 식별자
- `lease_expires_at`: 중앙 PC 장애 시 다른 실행이 재수집할 수 있는 임대 만료
- `heartbeat_at`: 중앙 수집기 마지막 생존 신호
- `attempt_count`: 재시도 횟수
- `progress_json`: 별점, 페이지, 후보/정상 개수 등
- `interruption_reason`: 로그인, CAPTCHA, 접근 제한 등

초기에는 중앙 PC가 한 대이므로 별도 `collectors` 테이블 없이 Worker Secret
`COLLECTOR_TOKEN` 하나로 시작해도 된다. 여러 수집기로 늘릴 때만 기기 테이블과 토큰
회전을 추가한다.

---

## 6. 중앙 수집 서버 전환 구현 계획

## 단계 0. 기준선 고정

### 작업

- 집 PC에서 저장소를 새로 clone 또는 최신 `master`로 pull한다.
- Node.js 22와 npm을 설치한다.
- `npm ci`, `npm run check`가 통과하는지 확인한다.
- 운영 도메인과 Worker `/health`를 확인한다.
- 현재 D1을 백업하거나 최소한 스키마를 export한다.
- 중앙 PC 전용 Chrome 프로필 경로를 정한다. 개인 일상용 프로필과 분리한다.

### 완료 기준

- 기존 테스트 19개 이상 통과
- 프런트 빌드 성공
- Worker 타입 검사 성공
- 운영 웹과 API 모두 HTTPS 200

## 단계 1. 공개 작업 생성과 폴링 API로 웹 전환

### 작업

- `POST /v1/jobs`가 즉시 `queued` 작업을 생성하도록 변경한다.
- 같은 상품의 유효한 30일 캐시가 있으면 새 작업 대신 캐시를 반환한다.
- 같은 `cache_key`의 활성 작업이 있으면 중복 생성하지 않고 기존 작업 ID를 반환한다.
- `GET /v1/jobs/{id}`는 사용자에게 필요한 상태, 진행률, 보고서만 반환한다.
- 프런트의 `collectWithExtension()` 직접 호출을 제거하거나 개발용 fallback으로만
  남긴다.
- 프런트는 작업 생성 후 1~2초 간격으로 상태를 폴링한다.
- `queued`, `collecting`, `waiting_for_operator`, `analyzing`, `completed`,
  `partial`, `failed` UI를 구분한다.
- 브라우저 탭을 닫았다가 다시 열어도 작업 ID로 결과를 찾도록 URL 또는
  `localStorage`에 작업 ID를 보관한다.

### 완료 기준

- 아이폰 Safari에서 URL 제출 시 확장 프로그램 안내가 나오지 않는다.
- 중앙 수집기가 없어도 작업이 `queued`로 안전하게 대기한다.
- 새로고침 후 같은 작업 상태를 복원한다.

## 단계 2. Collector 전용 인증과 작업 임대

### 권장 API

| 메서드 | 경로 | 용도 |
|---|---|---|
| `POST` | `/v1/collector/claim` | 대기 작업 하나를 원자적으로 임대 |
| `POST` | `/v1/collector/jobs/{id}/heartbeat` | 임대 연장과 진행률 |
| `POST` | `/v1/collector/jobs/{id}/reviews` | 리뷰 배치 업로드 |
| `POST` | `/v1/collector/jobs/{id}/interrupt` | 로그인/CAPTCHA/차단 상태 |
| `POST` | `/v1/collector/jobs/{id}/complete` | 수집 완료 후 분석 요청 |
| `POST` | `/v1/collector/jobs/{id}/fail` | 실패 코드와 안전한 메시지 |

### 보안

- `Authorization: Bearer <COLLECTOR_TOKEN>`을 요구한다.
- 토큰은 Worker Secret과 중앙 PC의 로컬 환경변수에만 둔다.
- 토큰을 GitHub, 로그, 프런트 번들, D1에 평문으로 저장하지 않는다.
- 사용자 API는 리뷰 업로드나 작업 완료를 호출할 수 없게 한다.
- claim은 `UPDATE ... WHERE status='queued' ... RETURNING` 방식으로 원자화한다.
- heartbeat가 끊겨 lease가 만료된 작업만 제한 횟수 내에서 재대기시킨다.
- 임의 URL을 열지 않도록 서버와 collector 양쪽에서 허용 호스트를 검사한다.

### 완료 기준

- 토큰 없는 collector 요청은 401
- 잘못된 토큰도 401이며 작업 존재 여부를 노출하지 않음
- 동시에 두 번 claim해도 같은 작업을 두 수집기가 가져가지 않음
- 중앙 프로세스 강제 종료 후 lease 만료 시 작업 복구

## 단계 3. 중앙 PC Collector 최소 구현

### 권장 기술

- Node.js 22
- TypeScript
- Playwright
- `launchPersistentContext()`로 전용 Chrome 사용자 데이터 디렉터리 사용
- 초기에는 화면이 보이는 headful 모드

### 로컬 환경변수 예시

```text
REVIEWMOA_API_BASE=https://reviewmoa-api.reviewmoa.workers.dev
REVIEWMOA_COLLECTOR_TOKEN=<로컬에서만 보관>
REVIEWMOA_COLLECTOR_ID=home-pc-01
REVIEWMOA_PROFILE_DIR=D:\ReviewMoaData\chrome-profile
REVIEWMOA_POLL_INTERVAL_MS=5000
```

실제 값이 들어간 `.env`, `.env.local`, Chrome 프로필 폴더는 절대 커밋하지 않는다.

### 실행 루프

1. `/health` 확인
2. `/v1/collector/claim` 호출
3. 작업이 없으면 지정 간격 대기
4. 작업이 있으면 heartbeat 시작
5. 허용된 상품 URL인지 다시 검사
6. 브라우저에서 상품 페이지 열기
7. 접근 가능성 probe
8. 최신순/별점별 수집
9. 리뷰 배치 업로드
10. complete 호출
11. 브라우저 탭 정리 후 다음 작업

### 운영 방식

- 개발 중에는 콘솔에서 수동 실행한다.
- 안정화 후 Windows 작업 스케줄러의 사용자 로그인 시 실행 작업으로 등록한다.
- 자동 재시작은 collector 자체의 무한 오류 재시도보다 작업 스케줄러 재시작 정책을
  우선한다.
- 프로세스가 살아 있어도 브라우저가 멈출 수 있으므로 heartbeat와 작업별 timeout을
  둔다.

### 완료 기준

- 가짜 fixture 작업을 중앙 PC가 claim하고 완료
- 중앙 PC를 재시작해도 Chrome 로그인 프로필 유지
- 작업마다 탭과 리소스 정리
- collector 토큰과 쿠키가 로그에 출력되지 않음

## 단계 4. 네이버 어댑터 실검증

7개 사이트를 동시에 작업하지 않는다. 네이버로 수집 계약을 먼저 확정한다.

### 테스트 상품

- 리뷰 100개 이상 상품 3개
- 리뷰 1~99개 상품 3개
- 리뷰 0개 상품 3개
- 가능하면 옵션이 여러 개인 상품 포함
- SmartStore, Brand, Shopping URL 유형을 각각 포함

### 검증 항목

- 모바일/공유/추적 파라미터 URL 정규화
- 상품명과 상품 ID
- 리뷰 탭 확인
- 최신순 적용 여부
- 1~5점 필터가 실제로 바뀌었는지
- 필터 클릭 후 이전 별점 리뷰가 섞이지 않는지
- 페이지네이션/더보기/무한 스크롤
- 작성일, 별점, 본문, 옵션
- 실제 0개와 접근 실패 구분
- 광고성·중복·불일치 분류
- 별점별 최대 100개 선정
- 대표 원문 10개가 실제 DOM과 일치

### 완료 기준

- 최소 10개 실제 상품에서 수동 대조
- 잘못된 별점이나 본문을 저장하는 오수집 0건
- 실패 시 0개 대신 명확한 `partial` 또는 `failed`
- `docs/access-matrix.md`의 네이버만 `verified`로 변경

## 단계 5. 분석·보고서 정합성 수정

### 필수 수정

- collector가 추출한 상품명을 `product.name`에 확실히 저장한다.
- 현재 실흐름에서는 `ProductIdentity`에 이름이 없어 Worker 보고서 제목이 비어 있을
  수 있다.
- 서버가 collector의 `classification` 값을 그대로 신뢰하지 않도록 값과 범위를
  검증한다.
- 별점은 정수 1~5, 본문 최대 길이, 허용 classification을 API 경계에서 검사한다.
- 신뢰도 UI에서 설명하는 35/25/20/10/10 산식과 실제 코드를 일치시킨다.
- 현재 코드는 의견 일관성과 최신성에 각각 고정 15점을 주므로 실제 데이터 품질
  지표가 아니다.
- `uncertain`에 낮은 가중치를 적용한다.
- AI 입력에 별점별 표본이 균형 있게 포함되는지 검증한다.
- AI 결과가 실패하면 `analysisProvider: rules`가 정확히 표시되는지 확인한다.

### 완료 기준

- 같은 fixture에 대해 로컬/Worker 분석 결과의 핵심 집계 일치
- 신뢰도 각 구성요소를 보고서에서 설명 가능
- 상품명이 모든 보고서에 표시
- OpenRouter 실패 테스트와 규칙 기반 폴백 테스트 통과

## 단계 6. 로그인·CAPTCHA 운영자 처리

중앙 서버 구조에서는 최종 사용자가 아니라 운영자가 처리한다. 상태 이름도
`waiting_for_user`보다 `waiting_for_operator`가 정확하다.

### 작업

- collector PC에 Windows 알림 또는 눈에 띄는 콘솔/로컬 관리 화면 제공
- 어떤 쇼핑몰·작업이 중단됐는지 표시
- 운영자가 로그인/CAPTCHA를 완료한 후 재개 버튼 제공
- 같은 Chrome persistent profile에서 이어서 수집
- 일정 시간 내 처리하지 않으면 `partial` 또는 `failed`
- 비밀번호 입력 자동화 및 서버 저장 금지

### 완료 기준

- 로그인 전 중단 → 운영자 로그인 → 동일 작업 재개
- CAPTCHA 감지 시 자동 풀이 없이 중단
- 작업이 영구적으로 `collecting`에 고착되지 않음

## 단계 7. 보안, 비용, 보존 정책

### 공개 API 보호

- 현재 API에는 사용자 인증과 강한 rate limit이 없다.
- 최소한 IP/세션별 작업 생성 제한과 전체 일일 작업 제한을 둔다.
- 공개 베타 전 Turnstile을 작업 생성에 적용하는 것을 검토한다.
- 한 사용자가 대량 URL을 제출해 중앙 PC와 OpenRouter를 점유하지 못하게 한다.
- CORS는 인증이 아니다. 허용 Origin 헤더만으로 API를 보호하지 않는다.

### SSRF와 URL 안전성

- 허용된 `https` 쇼핑몰 호스트만 중앙 PC가 연다.
- localhost, 사설 IP, `file:`, `data:`, 리디렉션 후 사설망 URL을 차단한다.
- 단축 URL을 허용한다면 최종 리디렉션 호스트를 다시 검증한다.
- 다운로드, 팝업, 외부 프로토콜 실행을 제한한다.

### 보존 정책 수정

- 대표 원문을 30일 보고서 JSON과 분리한다.
- 권장 방식은 집계 보고서와 대표 원문 테이블을 분리하는 것이다.
- 7일 후 원문 테이블을 실제 삭제하고 보고서에는 개수와 요약만 유지한다.
- 현재 cleanup은 API 요청이 들어올 때만 실행된다. Cron Trigger 또는 별도 정리
  작업을 추가한다.
- 만료된 jobs와 고아 레코드도 삭제한다.
- `GET /v1/jobs/{id}`에서도 만료 원문을 반환하지 않도록 공통 직렬화 함수를 쓴다.

### 완료 기준

- 8일로 시간을 이동한 테스트에서 D1 원문이 실제로 삭제
- 30일 이후 보고서와 관련 작업 데이터 삭제
- 악성 URL과 인증 없는 collector 요청 차단
- AI 일일 한도 도달 시 비용 없이 규칙 기반 결과

## 단계 8. 나머지 쇼핑몰 확장

권장 순서는 실제 접근성 검증 난이도에 따라 조정하되 한 번에 한 사이트만 추가한다.

1. 네이버
2. 11번가
3. SSG닷컴
4. 컬리
5. 오늘의집
6. G마켓
7. 쿠팡

쿠팡은 접근 제한과 페이지 변경 가능성이 높을 수 있으므로 초기 계약 검증용으로
잡지 않는 편이 안전하다.

각 사이트마다 `docs/access-matrix.md` 승인 절차와 실제 상품 최소 10개 검증을
반복한다.

## 단계 9. 모바일 UX와 비공개 베타

- 아이폰에서 URL 입력과 진행 상태 확인
- 화면을 닫아도 작업 복원
- 중앙 PC 오프라인이면 `수집 서버 연결 대기 중` 표시
- 예상 대기 순번 또는 현재 처리 상태 표시
- 운영자 개입 필요 시 사용자에게 과도한 내부 정보를 노출하지 않음
- 완료 보고서 공유 URL은 공개 여부와 만료 정책을 결정한 후 구현
- 홈 화면 추가가 가능하도록 PWA manifest를 선택적으로 추가

---

## 7. 기존 문제와 해결 내용

## 7.1 Cloudflare 계정 이메일 미인증

### 증상

Worker 최초 배포 시 Cloudflare API 오류 `10034`와 이메일 인증 필요 메시지가
발생했다.

### 해결

Cloudflare 가입 이메일을 인증한 뒤 `wrangler deploy`를 다시 실행해 정상 배포했다.

## 7.2 workers.dev 서브도메인 등록

### 증상

Worker 최초 배포 시 workers.dev 서브도메인이 없어 배포가 중단됐다.

### 해결

계정 서브도메인 `reviewmoa.workers.dev`를 등록했고 API는
`reviewmoa-api.reviewmoa.workers.dev`에 배포했다.

## 7.3 D1 초기 마이그레이션

### 해결

- `0001_initial.sql`: jobs, reviews, reports 생성
- `0002_ai_daily_usage.sql`: AI 일별 사용량 생성

원격 D1 `reviewmoa`에 두 마이그레이션이 적용되어 있다.

## 7.4 GitHub Pages 커스텀 도메인과 HTTPS

### 증상

- `reviewmoa.kro.kr` CNAME 연결 후 인증서 발급 대기
- 인증서 준비 중에는 HTTPS 강제 옵션을 사용할 수 없음
- 한때 인증서 이름 불일치가 확인됨

### 해결

- 무료 도메인 DNS에서 `reviewmoa.kro.kr`을 `jwkim1421.github.io`로 CNAME 연결
- GitHub Pages Custom domain에 `reviewmoa.kro.kr` 등록
- TLS 발급 완료 후 `Enforce HTTPS` 활성화
- 현재 운영 주소 HTTPS 200 확인

## 7.5 `VITE_API_BASE` 설정

### 해결

GitHub Repository variable `VITE_API_BASE`에 Worker URL을 등록했다. 이 값은 API
키가 아니라 공개 Worker 기본 주소다.

## 7.6 CORS preflight 204 오류

### 증상

Worker가 `OPTIONS`에 상태 204를 반환하면서 JSON 본문을 붙여 런타임 오류가
발생했다. 실제 브라우저의 JSON POST 요청이 CORS 사전 요청 단계에서 막힐 수 있었다.

### 해결

`worker/src/index.ts`의 응답 함수가 204일 때 본문을 `null`로 반환하도록 수정했다.
회귀 테스트 `worker/src/index.test.ts`를 추가했다. 운영 환경에서 다음 흐름을
검증했다.

- HTTPS 웹 200
- CORS preflight 204, 본문 길이 0
- 허용 Origin `https://reviewmoa.kro.kr`
- probe 200
- 작업 생성·조회·삭제 성공

관련 커밋은 `1cbb77a`다.

## 7.7 빈 리뷰를 실제 보고서처럼 보여 주던 문제

### 문제

초기 골격은 수집 확장 프로그램이 없어도 빈 리뷰로 완료된 샘플 보고서를 만들 수
있었다.

### 해결

- 실제 수집 데이터가 없으면 운영 보고서를 생성하지 않도록 변경
- 과거 가짜 캐시는 `collectionVerified !== true`이면 무시
- 확장 프로그램이 없으면 명확한 설치 안내 표시
- 개발 샘플과 운영 결과를 구분

## 7.8 별점 추출 실패 시 5점으로 간주할 위험

### 문제

별점을 읽지 못한 리뷰가 5점으로 잘못 분류되면 분석 전체가 왜곡될 수 있었다.

### 해결

명시적인 별점 속성, 접근성 레이블, 별 아이콘 상태를 확인하고 별점을 확정하지
못하면 해당 후보를 건너뛰도록 변경했다. 관련 jsdom 테스트가 있다.

## 7.9 OpenRouter 연동과 무료 비용 방어

### 해결

- API 키를 Wrangler Secret `OPENROUTER_API_KEY`로 등록
- `openrouter/free`를 기본 모델 라우터로 설정
- JSON schema 형식의 좋은 점·아쉬운 점·결론 요청
- 응답 파싱 실패나 네트워크 오류 시 규칙 기반 결과 유지
- D1의 `ai_daily_usage`로 하루 최대 40회 예약

원격 테스트에서 `analysisProvider: openrouter` 응답을 확인했다. 무료 라우터는
일시적으로 실패할 수 있으므로 폴백은 정상 동작으로 간주한다.

## 7.10 회사 PC 보안 프로그램

### 증상

- Fortinet이 일부 쇼핑몰 HTTPS 인증서를 신뢰하지 못해
  `NET::ERR_CERT_AUTHORITY_INVALID` 발생
- Waterwall이 `압축해제된 확장 프로그램 로드`를 파일 첨부 행위로 보고 차단

### 결론

코드 문제가 아니라 회사 보안 정책이다. 보안 프로그램 우회나 비활성화를 하지
않는다. 회사 PC는 중앙 수집 서버로 사용하지 않고 집의 개인 PC에서 개발·운영한다.

## 7.11 모바일 확장 프로그램 제약

모바일 Chrome은 현재 데스크톱 Manifest V3 확장 프로그램을 실행하지 않는다.
아이폰 Safari 확장으로 다시 만들려면 별도 iOS 앱 패키징과 배포가 필요하다.
이에 따라 모바일 직접 수집 대신 중앙 PC 수집 구조를 선택했다.

---

## 8. 미구현 및 해결해야 할 문제

중요도 순서로 정리한다.

### P0: 중앙 수집 작업 대기열 미구현

- 현재 웹은 같은 브라우저의 확장 프로그램을 직접 호출한다.
- 아이폰에서 작업만 제출하고 중앙 PC가 처리하는 흐름이 없다.
- collector claim, lease, heartbeat, 재시도 API가 없다.

### P0: 공개 API 인증과 남용 방지 부족

- 외부에서 리뷰 업로드와 complete 호출이 가능하다.
- CORS는 브라우저 제약일 뿐 API 인증이 아니다.
- 일일 AI 40회 제한은 비용 상한 일부만 막고 D1/중앙 PC 작업 남용은 못 막는다.

### P0: 7일 원문 보존 정책 불일치

- `reviews` 테이블 원문은 7일 만료지만 대표 리뷰가 `reports.report_json`에 들어간다.
- 읽을 때 숨길 뿐 저장 데이터가 실제 삭제되는 것은 아니다.
- `GET /v1/jobs/{id}`는 probe와 다른 경로라 원문 만료 scrub이 적용되지 않는다.

### P0: 실상품 수집 검증 없음

- 7개 사이트 모두 후보 셀렉터만 있다.
- 최소 10개 실상품 수동 대조 전에는 `verified`가 아니다.
- 현재 수집 성공률이나 정확도를 수치로 말할 근거가 없다.

### P1: 상품명 누락 가능성

- 확장 프로그램은 상품명을 추출하지만 운영 API 호출은 `ProductIdentity`만 전달한다.
- 타입상 보고서의 `product.name`은 필수지만 실제 URL 정규화 결과에는 없다.
- 중앙 collector가 상품명과 최종 URL을 작업 product에 갱신해야 한다.

### P1: 접근성 probe가 실검증이 아님

- `/v1/jobs/probe`는 캐시 확인 외에는 항상 정적인 `partial` capability를 반환한다.
- 중앙 collector의 실제 probe 결과를 `capability_json`에 저장하고 UI에 반영해야 한다.

### P1: 신뢰도 산식 설명과 코드 불일치

- UI는 완성도 35%, 근거 25%, 일관성 20%, 최신성 10%, 건전성 10%라고 설명한다.
- 서버 코드는 일관성과 최신성에 실제 계산 없이 각각 고정 15점에 해당하는 값을
  더한다.
- 최신성, 상충 의견, 별점별 분포를 실제로 계산해야 한다.

### P1: 분류 정확도 부족

- 광고성은 키워드 중심이다.
- 중복은 사실상 정규화된 동일 문장 위주이며 근접 중복 탐지가 약하다.
- 평점 불일치는 소수 긍정/부정 단어로 결정된다.
- 한국어 부정 표현, 반어, 옵션별 다른 경험을 처리하지 못한다.
- 자동 분류 표본을 사람이 라벨링해 정밀도/재현율을 측정해야 한다.

### P1: 입력 검증 부족

- Worker는 rating, classification, 본문 형식을 TypeScript 타입으로만 가정한다.
- 런타임 schema 검증이 필요하다.
- 한 작업에 업로드할 수 있는 전체 리뷰 수와 배치 수 제한도 서버에서 강제해야 한다.

### P1: 만료 정리가 요청 의존적

- cleanup은 일반 API 요청이 들어올 때만 실행된다.
- 오래된 jobs 자체는 삭제하지 않는다.
- Cron Trigger와 고아 레코드 정리가 필요하다.

### P1: 작업 상태 전이 검증 없음

- 아무 상태에서나 reviews/complete/resume 호출이 가능하다.
- 허용된 상태 전이 표와 서버 검증이 필요하다.
- 완료 작업의 중복 complete와 AI 중복 호출을 막아야 한다.

### P2: 범용 사이트 지원 불일치

- 프런트 URL 정규화는 `generic`을 반환할 수 있다.
- 확장 manifest는 7개 쇼핑몰에만 content script 권한이 있다.
- CSV/엑셀 업로드 fallback도 아직 없다.
- 공개 베타 전에는 기타 사이트 지원 문구를 제거하거나 실제 fallback을 구현한다.

### P2: `products/resolve` API가 실질적으로 비어 있음

- 현재는 받은 product를 그대로 돌려준다.
- 서버 정규화를 구현하거나 사용하지 않는 endpoint를 제거해야 한다.

### P2: refresh API와 실제 UI 흐름 불일치

- `/v1/jobs/{id}/refresh`가 있지만 프런트는 사용하지 않는다.
- 중앙 작업 구조에서는 기존 보고서를 보존한 채 새 queued 작업을 만들고 성공 시
  교체하도록 하나의 흐름으로 통합한다.

### P2: 대표 리뷰 선정 기준 부족

- 현재는 최신순 배열의 앞 10개다.
- 핵심 주제 대표성, 서로 다른 의견, 반복 문장 회피를 반영하지 않는다.

### P2: 관측성과 운영 화면 부족

- 작업 대기 수, 평균 처리 시간, 실패 사이트, CAPTCHA 비율을 볼 수 없다.
- 비밀정보를 제외한 구조화 로그와 운영자용 상태 화면이 필요하다.

---

## 9. 테스트 전략

## 9.1 현재 자동 테스트

```bash
npm test
npm run build
npm run worker:check
npm run check
```

문서 작성 시점 기준 테스트 파일:

- `src/domain/url.test.ts`
- `src/domain/analyze.test.ts`
- `extension/content.test.ts`
- `worker/src/analyze.test.ts`
- `worker/src/index.test.ts`

## 9.2 중앙 수집 전환 후 추가할 테스트

### Worker 계약 테스트

- queued 작업 생성
- 유효 캐시 반환
- 중복 활성 작업 합치기
- collector 인증 성공/실패
- 원자적 claim
- lease 만료와 재시도
- 잘못된 상태 전이 거절
- 리뷰 런타임 schema 검증
- 완료 idempotency
- 원문 7일, 보고서 30일 실제 삭제

### Collector 단위 테스트

- fixture DOM에서 상품명, 별점, 날짜, 본문, 옵션 추출
- 별점 미확정 후보 제외
- 광고성·중복·불일치 분류
- 별점별 최신 100개 제한
- 리뷰 없음과 DOM 실패 구분
- 허용되지 않은 호스트 차단

### 통합 테스트

- 로컬 Worker + 가짜 collector의 전체 작업 수명주기
- collector 종료 후 lease 복구
- Worker 재시도 중 리뷰 중복 저장 방지
- OpenRouter 실패 시 규칙 기반 보고서
- 아이폰 크기 viewport에서 작업 폴링과 보고서 표시

### 실상품 canary

- 사이트별 고정 테스트 URL을 문서에 기록하되 상품 삭제 가능성 고려
- 자동 테스트로 쇼핑몰에 과도한 요청을 보내지 않는다.
- 배포 전 수동 canary 1~2개, 정기 검증은 낮은 빈도로 실행
- DOM 변경 감지 시 잘못된 데이터를 저장하지 않고 해당 사이트 지원을 `partial`로
  낮춘다.

---

## 10. 집 PC 개발 환경 복구 절차

## 10.1 저장소 준비

```powershell
git clone https://github.com/jwkim1421/ReviewMoa.git
Set-Location ReviewMoa
npm ci
npm run check
```

이미 clone되어 있다면:

```powershell
git status
git pull --ff-only origin master
npm ci
npm run check
```

작업 트리에 기존 변경이 있으면 임의로 reset하지 말고 먼저 변경 내용을 확인한다.

## 10.2 프런트 로컬 실행

```powershell
npm run dev
```

기본 주소는 `http://127.0.0.1:5173`이다.

운영 Worker를 로컬 프런트에서 사용하려면 개인용 `.env.local`에 다음을 둔다.

```text
VITE_API_BASE=https://reviewmoa-api.reviewmoa.workers.dev
```

`.env.local`은 커밋하지 않는다.

## 10.3 Worker 로컬 검사와 배포

```powershell
npx wrangler login
npm run worker:check
npx wrangler deploy --dry-run --config worker/wrangler.toml
npx wrangler d1 migrations apply reviewmoa --remote --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

새 마이그레이션이 없으면 원격 migration 명령은 적용할 항목이 없다고 표시한다.

OpenRouter Secret 확인 시 값 자체는 출력하거나 문서에 적지 않는다. 새로 등록할
때만 다음 명령을 사용하고 프롬프트에 키를 입력한다.

```powershell
npx wrangler secret put OPENROUTER_API_KEY --config worker/wrangler.toml
```

중앙 collector용 Secret은 후속 구현 시 같은 방식으로 등록한다.

```powershell
npx wrangler secret put COLLECTOR_TOKEN --config worker/wrangler.toml
```

## 10.4 GitHub Pages

- `master` 또는 `main` push 시 `.github/workflows/pages.yml`이 실행된다.
- `npm test`와 `npm run build` 성공 후 Pages를 배포한다.
- Repository variable `VITE_API_BASE`가 필요하다.
- `public/CNAME`을 삭제하거나 변경하면 커스텀 도메인 배포에 영향을 준다.

## 10.5 Worker GitHub Actions

`.github/workflows/worker.yml`은 현재 수동 실행이다. 다음 Secrets가 필요하다.

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API 토큰, OpenRouter 키, collector 토큰은 저장소 파일에 직접 넣지 않는다.

---

## 11. 운영 점검표

## 매일 또는 개발 시작 시

- 중앙 PC 인터넷 연결
- collector 프로세스 실행 여부
- Chrome persistent profile 로그인 상태
- Worker `/health`
- queued 작업이 장시간 정체되지 않았는지
- AI 일일 제한 도달 여부

## 배포 전

- `git diff --check`
- `npm run check`
- collector 단위/통합 테스트
- Worker dry-run
- 원격 D1 마이그레이션
- 네이버 canary URL 수동 검증
- 비밀키 문자열이 git diff에 없는지 확인

## 장애 시

### 작업이 계속 queued

- collector 프로세스와 토큰 확인
- `/claim` 응답 확인
- 중앙 PC 시간 동기화와 lease 만료 확인

### 작업이 collecting에 고착

- heartbeat 확인
- 브라우저 탭/프로세스 확인
- lease 만료 후 재시도 여부 확인
- CAPTCHA/로그인 상태 확인

### 보고서만 실패

- reviews 저장 개수 확인
- AI 실패인지 규칙 기반 분석도 실패했는지 구분
- OpenRouter 실패는 서비스 전체 실패로 처리하지 않음

### 특정 쇼핑몰만 실패

- DOM 변경, 로그인 요구, CAPTCHA, 실제 0개를 구분
- 해당 사이트 상태를 임시 `partial`로 낮춤
- 잘못된 리뷰를 저장하는 것보다 실패가 안전함

---

## 12. 개인정보·약관·보안 원칙

- 쇼핑몰 비밀번호와 로그인 쿠키를 Worker/D1에 업로드하지 않는다.
- 중앙 PC의 Chrome profile 디렉터리를 백업 저장소나 Git에 넣지 않는다.
- 리뷰 작성자 이름은 저장 전에 마스킹하거나 저장하지 않는다.
- 프로필 이미지와 개인 식별자는 저장하지 않는다.
- 원문 재게시가 허용되지 않는 사이트는 짧은 발췌와 원본 링크만 제공한다.
- 공개 전 각 쇼핑몰 약관과 리뷰 원문 재게시 범위를 별도로 검토한다.
- CAPTCHA 자동 풀이 서비스, 탐지 회피, 차단 우회는 구현하지 않는다.
- 중앙 PC collector는 허용된 쇼핑몰 외 URL을 열지 않는다.
- 사용자 입력 URL과 작업 상태는 운영자에게 노출될 수 있으므로 개인정보처리방침에
  명시한다.
- “AI 분석 결과”는 구매 보장이나 사실 판정이 아니라 수집 리뷰의 요약임을 유지한다.

---

## 13. 바로 다음 개발 작업

다음 작업은 UI 개선이나 두 번째 쇼핑몰 어댑터가 아니다. 아래 순서로 진행한다.

1. `0003_collector_queue.sql` 설계 및 테스트
2. collector 인증과 원자적 claim API
3. 웹을 확장 프로그램 직접 호출에서 queued 작업 생성·폴링 방식으로 변경
4. `collector/` 최소 프로세스 구현
5. fixture 기반 전체 수명주기 테스트
6. 네이버 실상품 10개 검증
7. 보존 정책과 신뢰도 산식 수정

첫 번째 마일스톤의 성공 조건은 다음 한 문장으로 정의한다.

> 아이폰 Safari에서 네이버 상품 URL을 제출하면 집의 중앙 PC가 작업을 가져가 실제
> 리뷰를 수집하고, 아이폰에서 진행 상태와 결과 보고서를 확인할 수 있다.

이 성공 조건을 달성하기 전에는 7개 사이트 동시 지원, iOS 앱, Cloudflare Browser
Run, 다중 collector, 고급 AI 분류를 추가하지 않는다.

---

## 14. 아직 결정이 필요한 제품 질문

개발 중 임의로 결정하지 말고 운영 범위가 정해질 때 확인한다.

- 비공개 개인 서비스인지, 링크를 아는 누구나 쓰는 공개 베타인지
- 하루 최대 작업 수와 사용자별 제한
- 중앙 PC가 꺼져 있을 때 작업을 몇 시간 보관할지
- 운영자 개입이 필요한 작업을 사용자에게 어떻게 안내할지
- 보고서 공유 URL을 공개할지
- 리뷰 원문 10개를 실제로 재게시해도 되는 사이트 범위
- 유료 운영으로 전환할 가능성과 비용 상한
- 여러 옵션이 있는 상품을 옵션별로 나눌지, 상품 전체로 합칠지

현재 기본 가정은 **운영자 한 명, 중앙 수집 PC 한 대, 비공개 베타, 순차 처리,
월 최소 비용**이다.

---

## 15. 2026-07-28 이후 개발 결정과 진행 현황

이 절은 위 인수인계 문서 작성 이후 확정하거나 구현한 내용을 기록한다. 앞 절과
충돌하면 이 절의 최신 결정을 우선한다.

## 15.1 현재까지 추가 완료된 Worker 작업

- `0003_collector_queue.sql` 추가
- 새 작업을 `queued` 상태로 생성
- collector Bearer Token 인증
- 원자적 `POST /v1/collector/claim`
- lease와 heartbeat, 최대 재시도 횟수
- 인증된 `reviews`, `interrupt`, `complete`, `fail` API
- 별점, 본문, classification, 배치 및 작업별 리뷰 수 런타임 검증
- 작업을 소유한 collector만 변경할 수 있도록 `claimed_by`와 lease 검증
- 완료 요청 멱등 처리
- 완료 처리 오류 시 `analyzing` 고착 방지
- 기존 공개 `/v1/jobs/{id}/reviews`, `/complete` 경로 차단
- macOS 중앙 `collector/` 최소 프로세스와 Chrome persistent profile
- collector claim, heartbeat, 리뷰 업로드, 중단, 완료, 실패 API 클라이언트
- 허용 상품 URL과 메인 문서 리디렉션 사전 차단
- 웹을 확장 프로그램 직접 수집에서 queued 작업·1.5초 폴링 방식으로 전환
- 작업 ID URL·localStorage 저장과 새로고침 복원
- queued, collecting, waiting_for_operator, analyzing, failed 상태 UI
- 유효 캐시 즉시 반환과 동일 상품 활성 작업 중복 방지
- 실제 SQLite에 마이그레이션을 적용하고 고정 리뷰 fixture로
  `queued → claim → reviews → complete → report 조회`를 연결하는 전체 수명주기
  통합 테스트
- 네이버 리뷰 영역 열기, 최신순 적용, 페이지 이동과 별점·본문·작성일·옵션 추출
- 네이버 리뷰 중 광고성·중복·평점 불일치 신호 분류와 별점별 최대 100개 선정
- 네이버 DOM fixture 기반 추출 및 collector 완료 결과 테스트

로컬 D1과 Worker 통합 테스트까지 통과했지만 운영 D1 마이그레이션과 Worker 배포는
아직 하지 않았다. 네이버 adapter는 구현했지만 실제 상품 최소 10개 수동 대조 전이므로
이 변경을 운영 배포하지 않는다.

## 15.2 확정된 개발 순서

1. macOS 중앙 `collector/` 최소 프로세스 구현
2. 웹을 확장 프로그램 직접 수집에서 queued 작업 생성·상태 폴링 방식으로 전환
3. fixture 기반 전체 작업 수명주기 테스트
4. 네이버 실제 상품 최소 10개 검증
5. CAPTCHA·로그인 운영자 중단 및 재개 UX
6. 동일 상품 대체 출처 기능
7. 원문 보존 정책과 신뢰도 산식 수정
8. iPhone Safari Web Extension
9. Android Firefox 확장은 선택적으로 검토하되 생략할 수 있음
10. 전용 모바일 앱 개발 검토
11. 나머지 쇼핑몰을 한 번에 한 곳씩 검증·확장

2026-07-29 기준 1~3번과 네이버 리뷰 추출 adapter 구현은 완료했다. 다음 개발 단위는
네이버 실제 상품을 최소 10개 수동 대조하는 4번 검증이다.

같은 날 첫 실상품 canary 2개를 확인했다. `brand.naver.com` 상품은 collector Chrome
접속과 상단 대표 리뷰 12개 추출에 성공했다. 전체 리뷰 목록은 열지 못했으므로
`summary_only`와 `partial` 상태로 명시하고, 확인된 대표 리뷰는 그대로 정리한다.
보고서에는 전체 목록을 열지 못한 제한과 정상 리뷰 50개 미만이라는 표본 부족 안내를
함께 표시한다. `search.shopping.naver.com/catalog` 상품은 collector Chrome에서 즉시
`access_blocked`가 감지되어 재시도하지 않았다. 세부 URL과 결과는
`docs/access-matrix.md`에 기록했다.

같은 날 추가 URL을 확인해 네이버 실상품 검증은 6/10까지 진행했다. 추가 브랜드
상품은 대표 리뷰 12개를 `summary_only`로 추출했고, 추가 가격비교 카탈로그는
`access_blocked`였다. 스마트스토어 2개는 CAPTCHA가 아니라 네이버 시스템 오류
페이지를 반환했으며, 현재 `review_area_not_found`로 분류되는 오류를 별도 안전 오류
코드로 구분하는 것이 다음 adapter 수정 과제다. 제시믹스 카테고리 URL은 네이버
검증 수에 포함하지 않는다.

이후 사용자 스크린샷으로 두 스마트스토어 상품에 각각 리뷰 4,994개와 3,813개가
존재함을 확인했다. 별도 자동화 브라우저에서는 네이버 영수증형 보안 확인 화면이
재현됐다. 보안 문구는 `captcha`, 네이버 시스템 오류 페이지는
`operator_required`로 중단하도록 수정했으며 하이웰 canary에서 해당 상태를
재확인했다.

작업별 7일짜리 일회성 인계 토큰과 인증된 `mobile-start`, `mobile-heartbeat`,
`mobile-interrupt`, `mobile-complete` API, iPhone Safari WebExtension 수집 흐름을
추가했다. iPhone Safari에서 URL을 제출하면 작업 생성과 동시에 모바일 확장이
소유권을 얻고 새 상품 탭을 연다. CAPTCHA가 없으면 즉시 수집하고, 실제 CAPTCHA나
로그인이 있을 때만 사용자가 처리한 뒤 자동 재개한다. 완료 시 리뷰모아 탭으로
복귀하고 상품 탭을 닫는다. iPhone의
보안 쿠키는 Mac collector와 공유하지 않는다. Xcode 26.6에서 iOS 앱과 Safari 확장
프로젝트 생성을 완료했고 시뮬레이터용 전체 빌드도 통과했다. Safari가 지원하지 않는
Manifest V3 백그라운드 `type` 키는 패키징할 때만 제거하고 런타임 설정을 일반
스크립트에 삽입한다. 부모 앱과 확장의 Bundle ID도
`kr.reviewmoa.ReviewMoa` / `kr.reviewmoa.ReviewMoa.Extension`으로 정합성을 맞췄다.
무료 Personal Team을 두 타깃에 지정해 실제 iPhone 15 Pro 설치와 개발자 신뢰,
Safari 확장 활성화, 네이버 상품 페이지의 확장 팝업 실행까지 확인했다. 확장 저장
용량 오류를 피하도록 새 작업 시작 시 확장 로컬 저장소를 비우며 리뷰 본문은 서버
전송 후 로컬에 남기지 않는다. 0.1.5 앱을 실제 iPhone에 설치해 검증을 이어갔다.

실제 iPhone 전체 흐름에서 CAPTCHA 없이 네이버 리뷰 수집, Worker 전송, 규칙 기반
분석, 리뷰모아 보고서 표시까지 성공했다. 후속 0.1.6은 상품 페이지 수집 중 전체
오버레이와 진행 원을 표시해 뒤쪽 조작을 막고, 실제 CAPTCHA·로그인·접근 제한
감지 시에만 오버레이를 제거한다. 보고서의 별점 행은 `n점 리뷰: m개`로 단순화하고,
원문 보기 버튼은 실제 표시 가능한 리뷰 수와 일치시키며 0개면 숨긴다.

모바일 로드맵은 기본적으로 `중앙 맥북 → iPhone Safari Web Extension → Android
Firefox(선택) → 전용 모바일 앱`이다. Android Firefox 단계를 건너뛰고 Safari 확장
다음에 전용 모바일 앱으로 바로 진행할 수 있다.

후속 0.1.7은 모바일 수집 결과의 상품명을 Worker에 전달하고, 보고서의 `다시
불러오기`도 iPhone Safari 수집 흐름을 유지한다. 0건인 의견 항목은 보고서에서
숨긴다. 유아용 상품에서 반복되는 아이의 관심, 콘텐츠·구성, 품질·마감, 사운드
의견을 분석 규칙에 추가했고 단순히 제품이 크다는 표현을 `옵션 차이`로 오인하던
패턴을 제거했다. 모바일 보고서도 AI 분석 설정을 우선 사용하고, 사용할 수 없을
때만 규칙 기반 결과와 그 사유를 표시한다.

D1 쓰기 타임아웃 뒤 작업은 생성됐지만 웹이 오류로 돌아가고 중앙 collector가 이를
가져간 사례를 확인했다. 작업 생성은 동일 ID의 `INSERT OR IGNORE`로 한 번 안전하게
재시도한다. iPhone Safari에서는 확장 감지를 세 번 확인하며, 감지 실패 시 중앙
collector로 조용히 전환하지 않고 기존 보고서와 명확한 오류 안내를 유지한다.

0.1.8은 네이버 상품 본문의 대표 리뷰(`sprvsub.topreview`)만 보이면 수집을 끝내지
않고 `리뷰 전체보기` 또는 리뷰 개수 링크를 같은 탭에서 연다. 전체 리뷰 경로로
이동해 content script가 다시 로드돼도 저장된 모바일 작업 ID를 이어받고, 전체 목록
확인 후 최신순·별점 필터·페이지 이동 수집을 진행한다. 전체 목록을 열 수 없는
경우에만 기존처럼 `summary_only` 결과를 반환한다.

0.1.8 실상품 검증에서 첫 번째 `rvmore` 링크가 대표 리뷰 영역으로만 이동한 뒤 다른
전체보기 후보를 시도하지 않아 다시 12개 `summary_only`로 끝나는 결함을 확인했다.
0.1.9는 리뷰 개수 링크, `topreviewmore` 버튼, 전체보기 텍스트 후보를 순차적으로
시도한다. 완료 API에는 확장 버전과 본문을 제외한 컨트롤 시도 결과를 함께 보내 D1
`progress_json`에서 실상품 실패 단계를 확인할 수 있게 했다.

최종 모바일 목표는 사용자가 아이폰에서 URL 제출, 로그인·CAPTCHA 처리, 리뷰 수집,
결과 확인을 모두 수행할 수 있게 하는 것이다. 중앙 맥북 collector는 가장 먼저
서비스를 동작시키기 위한 공통 기본 경로이며, Worker의 대기열·저장·분석 API는 이후
Safari 확장과 모바일 앱에서도 재사용한다.

## 15.3 CAPTCHA 처리 원칙

- 현재 CAPTCHA가 실제로 발생하거나 반드시 표시된다고 확인된 바는 없다.
- 현재 코드는 CAPTCHA 문구 감지만 구현했고 사이트별 실제 검증은 모두 대기 상태다.
- 네이버 실제 상품 검증에서 발생 위치, 로그인 상태, 빈도, 재현 조건을 측정한다.
- CAPTCHA 자동 풀이, 브라우저 지문 위장, 프록시·IP·계정 순환, 접근통제 우회는
  구현하지 않는다.
- CAPTCHA 발생 시 `waiting_for_operator`로 중단하고 사용자가 직접 처리한 뒤 재개한다.
- 캐시 사용, 제한된 지연 재시도, 공식 API, 정상적으로 공개된 동일 상품의 다른
  출처는 허용되는 fallback으로 본다.

## 15.4 동일 상품 대체 출처 기능

요청 URL A의 리뷰에 접근할 수 없을 때 정상적으로 공개된 동일 상품 URL B를 찾아
B의 리뷰로 대체할 수 있다. 이는 A의 접근통제를 우회하는 기능이 아니라 독립적으로
접근 가능한 다른 출처를 사용하는 기능이어야 한다.

- 상품명만으로 자동 대체하지 않는다.
- 모델 번호, GTIN/바코드, 제조사, 브랜드, 용량, 수량, 색상, 세대, 옵션과 카테고리를
  함께 비교한다.
- `exact`만 자동 대체하고 `probable`은 사용자 확인, `uncertain`은 대체하지 않는다.
- 요청 출처, 실제 리뷰 출처, 대체 사유, 일치 근거와 신뢰도를 보고서에 표시한다.
- 판매자 배송·포장·응대 평가는 원래 판매처와 다를 수 있음을 알린다.
- A와 B의 리뷰를 출처 표시 없이 섞지 않는다.

네이버 개발자센터의 쇼핑 검색 API는 2026-07-31 종료 예정이고 별도 대체 API가
제공되지 않으므로 새 기능이 이에 의존해서는 안 된다. 후보 검색은 공급자 독립
인터페이스로 만들고 사용 가능한 공식 API, 모델 번호 검색, 기존 캐시, 사용자 선택
등을 조합한다.

## 15.5 오류 관측성과 자동 복구

이번 collector 구현부터 다음 구조화 오류 정보를 Worker에 전달할 수 있게 한다.

- 사이트와 작업 ID
- 수집 단계와 안전한 오류 코드
- adapter 버전
- 시도한 selector와 후보 개수
- 로그인·CAPTCHA 감지 결과
- 개인정보, 쿠키, 토큰을 제거한 진단 정보

일시적인 네트워크 오류와 브라우저 정지는 제한된 자동 재시도 대상으로 삼고,
CAPTCHA와 접근 제한은 자동 우회하지 않는다.

### 추가 개발 아이디어: AI 자동 오류 검토·수정

수집 오류를 AI가 분석하고 selector 또는 adapter 수정안과 회귀 테스트를 만든 뒤,
별도 브랜치나 PR로 제안하는 루프를 향후 검토할 수 있다.

이 기능의 구현과 자동 배포는 현재 **보류**한다. AI가 실행 중인 운영 코드를 직접
수정하거나 검증 없이 배포하게 하지 않는다. 재검토할 경우에도 `오류 수집 → 민감정보
제거 → AI 수정안 → fixture 테스트 → 실제 canary → 운영자 승인 → 배포` 순서를
기본 안전 경계로 사용한다.
