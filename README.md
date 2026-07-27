# 리뷰모아

여러 쇼핑몰의 상품 URL을 받아 공개된 최신 리뷰를 별점별로 정리하고, 의심 리뷰를
주 분석에서 분리한 뒤 구매 인사이트를 보여 주는 비공개 베타 프로젝트다.

## 현재 구현

- 네이버, 쿠팡, 컬리, 오늘의집, 11번가, SSG닷컴, G마켓 URL 정규화
- 미지원 사이트의 시험적 URL 처리
- 리뷰 접근 가능성 확인 화면과 로그인·CAPTCHA 중단 상태
- Chrome/Edge Manifest V3 수집 도우미
- 화면에 공개된 리뷰의 별점·날짜·본문·옵션 추출
- 광고성, 중복, 평점 불일치 의심 분류
- 별점별 최대 100개 분석과 대표 원문 5개
- 한 줄 결론, 신뢰도 산식, 장점·주의점, 제외 신호 보고서
- Cloudflare Worker API, D1 마이그레이션, 7일/30일 만료 캐시
- OpenAI API 키가 있을 때 `gpt-5-mini`로 한 줄 결론 보강
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

현재 수집기는 보이는 리뷰 DOM을 안전하게 읽는 공통 기반까지 구현되어 있다. 사이트별
페이지 이동과 별점 필터 자동화는 [접근성 검증 매트릭스](docs/access-matrix.md)의
실상품 검증을 통과한 뒤 활성화해야 한다. 검증되지 않은 사이트를 `완전 지원`으로
표시하지 않는다.

## Cloudflare API 배포

1. D1 데이터베이스를 만든다.

```bash
npx wrangler d1 create reviewmoa
```

2. 반환된 ID를 `worker/wrangler.toml`의 `database_id`에 넣는다.
3. 필요한 비밀값을 등록한다.

```bash
npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.toml
```

4. 마이그레이션과 Worker를 배포한다.

```bash
npx wrangler d1 migrations apply reviewmoa --remote --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

5. 배포 URL을 GitHub 저장소 변수 `VITE_API_BASE`로 등록한다.

GitHub Actions를 쓸 때는 `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`를 저장소 Secrets로 등록한다.

## GitHub Pages와 도메인

- 저장소의 Pages 소스를 `GitHub Actions`로 설정한다.
- `main` 브랜치에 push하면 테스트와 빌드 후 Pages에 배포된다.
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
