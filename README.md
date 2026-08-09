# 리뷰모아

여러 쇼핑몰의 상품 URL을 받아 공개된 최신 리뷰를 별점별로 정리하고, 의심 리뷰를
주 분석에서 분리한 뒤 구매 인사이트를 보여 주는 비공개 베타 프로젝트다.

## 현재 구현

- 네이버, 쿠팡, 컬리, 오늘의집, 11번가, SSG닷컴, G마켓 URL 정규화
- 미지원 사이트의 시험적 URL 처리
- 리뷰 접근 가능성 확인 화면과 로그인·CAPTCHA 중단 상태
- Chrome/Edge Manifest V3 수집 도우미
- 리뷰 탭·최신순·별점 필터·페이지/더보기 탐색과 공개 리뷰 추출
- 광고성, 중복, 평점 불일치 의심 분류
- 별점별 최대 100개 분석과 대표 원문 10개
- OpenRouter 또는 규칙 기반의 좋은 점·아쉬운 점·결론 3문장 분석
- Cloudflare Worker API, D1 마이그레이션, 7일/30일 만료 캐시
- 인증된 중앙 collector 작업 대기열, lease, heartbeat와 상태 전이
- macOS Chrome persistent profile을 사용하는 중앙 collector 최소 프로세스
- 웹 작업 생성, 상태 폴링, 작업 ID 복원과 상태별 진행 화면
- 정상 리뷰 50개 미만일 때 표본 부족 안내를 표시하면서 확인된 리뷰는 계속 정리
- iPhone Safari에서 보안 확인 후 같은 세션으로 리뷰 수집을 이어받는 모바일 인계
- OpenRouter 키가 있을 때 무료 모델 라우터로 AI 분석 보강
- GitHub Pages 및 Cloudflare Worker 배포 워크플로

## 로컬 실행

```bash
npm install
npm run dev
```

웹은 기본적으로 `http://127.0.0.1:5173`에서 열린다. `VITE_API_BASE`가 없고 확장
프로그램도 설치되지 않은 경우에는 UI 검증용 샘플 보고서임을 명확히 표시한다.

### 확장 프로그램

1. Chrome/Edge 확장 관리 화면에서 개발자 모드를 켠다.
2. `압축해제된 확장 프로그램을 로드`를 선택한다.
3. 이 저장소의 `extension` 폴더를 선택한다.
4. 리뷰모아에 상품 URL을 입력한다.
5. 로그인이 필요하면 쇼핑몰 화면에서 직접 로그인하고 확장 팝업의
   `현재 페이지에서 다시 확인`을 누른다.

수집기는 리뷰 탭, 최신순, 별점 필터, 페이지/더보기를 공통 방식과 사이트별 후보
선택자로 탐색한다. 다만 쇼핑몰 DOM은 계속 바뀌므로 [접근성 검증
매트릭스](docs/access-matrix.md)의 실상품 검증을 통과하기 전에는 `완전 지원`으로
표시하지 않는다. 자동 탐색이 실패하면 사용자가 리뷰 탭이나 필터를 직접 연 뒤
확장 프로그램의 `현재 페이지에서 다시 확인`으로 재개한다.

### 중앙 collector

중앙 collector는 최종 사용자의 확장 프로그램 대신 집의 macOS PC에서 Worker
대기열을 처리한다. 환경변수와 현재 구현 범위는
[`collector/README.md`](collector/README.md)를 참고한다.

```bash
npm run collector:start
```

현재 네이버 adapter와 fixture 검증까지 구현했다. 브랜드 상품에서 전체 리뷰 목록을
열지 못해도 공개된 대표 리뷰는 `partial` 보고서로 정리하며, 실제 상품 최소 10개
수동 대조 전까지는 비공개 개발 상태로 유지한다.

iPhone Safari Web Extension 원본과 모바일 인계 API도 구현되어 있다. Xcode 프로젝트
생성과 시뮬레이터 빌드까지 검증했으며, 무료 Personal Team으로 개인 iPhone 설치
테스트를 진행할 수 있다. TestFlight와 App Store 배포에는 Apple Developer Program이
필요하다. 자세한 절차는 [`safari/README.md`](safari/README.md)에 있다.

## Cloudflare API 배포

1. D1 데이터베이스를 만든다.

```bash
npx wrangler d1 create reviewmoa
```

2. 반환된 ID를 `worker/wrangler.toml`의 `database_id`에 넣는다.
3. 필요한 비밀값을 등록한다.

```bash
npx wrangler secret put OPENROUTER_API_KEY --config worker/wrangler.toml
npx wrangler secret put COLLECTOR_TOKEN --config worker/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml
```

기본 모델은 무료 모델 중 요청 기능을 지원하는 모델을 고르는 `openrouter/free`다.
OpenRouter 호출이 실패하거나 한도에 도달하면 규칙 기반 분석 결과를 유지한다.
`COLLECTOR_TOKEN`은 중앙 수집기의 claim과 heartbeat 요청을 인증하며, 프런트 번들이나
저장소 파일에는 넣지 않는다. `ADMIN_TOKEN`은 `/#admin` 운영 진단 화면 전용이며 URL,
프런트 환경 변수, 저장소 파일에 넣지 않는다. 운영 화면은 토큰을 현재 브라우저 탭의
세션 저장소에만 보관한다.

4. 마이그레이션과 Worker를 배포한다.

```bash
npx wrangler d1 migrations apply reviewmoa --remote --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

5. 배포가 끝나면 Wrangler가 다음과 같은 Worker URL을 출력한다.

```text
https://reviewmoa-api.<내-workers.dev-서브도메인>.workers.dev
```

이 주소가 `VITE_API_BASE`다. 별도로 발급받는 키가 아니라, 리뷰모아 API Worker의
공개 기본 URL이다. Cloudflare 대시보드의 `Workers & Pages → reviewmoa-api →
Settings → Domains & Routes`에서도 확인할 수 있다.

## 운영 진단 화면

배포된 웹 주소 뒤에 `/#admin`을 붙여 접속한다. 예: `https://reviewmoa.kro.kr/#admin`.
Worker에 secret으로 등록한 `ADMIN_TOKEN`을 입력하면 최근 작업 50건의 성공률, 사이트와
확장 버전별 결과, 오류 유형, 재시도 가능 여부와 정제된 수집 진단을 확인할 수 있다.

운영 응답에는 상품 URL, 상품명, 리뷰 원문, 쿠키, 작업 인계 토큰과 DOM 제어 원문을
포함하지 않는다. 공개 작업 조회 API에서도 내부 `collectorDiagnostics`는 제거된다.

6. GitHub 저장소의 `Settings → Secrets and variables → Actions → Variables`에서
`VITE_API_BASE`라는 Repository variable을 만들고 위 URL을 값으로 등록한다.

GitHub Actions를 쓸 때는 `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`를 저장소 Secrets로 등록한다.

## GitHub Pages와 도메인

- 저장소의 Pages 소스를 `GitHub Actions`로 설정한다.
- `main` 또는 `master` 브랜치에 push하면 테스트와 빌드 후 Pages에 배포된다.
- `public/CNAME`은 `reviewmoa.kro.kr`로 설정되어 있다.
- 무료 도메인 DNS에 GitHub Pages가 안내하는 `CNAME` 또는 `A` 레코드를 추가한다.

## 검증

```bash
npm test
npm run build
npm run worker:check
node --check extension/background.js
node --check extension/content.js
```

## 보안과 한계

- 로그인 비밀번호나 쿠키를 API로 전송하지 않는다.
- CAPTCHA와 접근통제를 자동으로 무력화하지 않는다.
- 리뷰 작성자 식별자와 프로필 이미지를 저장하지 않는다.
- 원문은 7일, 집계·보고서는 30일 후 삭제한다.
- 각 쇼핑몰의 약관과 원문 재게시 허용 범위는 공개 출시 전에 별도로 검토해야 한다.
