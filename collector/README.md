# 리뷰모아 중앙 Collector

집의 macOS PC에서 Worker 대기열의 작업을 하나씩 가져와 전용 Chrome 프로필로 상품
페이지를 여는 프로세스다. 최종 사용자의 브라우저 확장 프로그램을 사용하지 않는다.

## 현재 범위

- collector token 인증
- 원자적 작업 claim
- heartbeat와 진행률
- 허용 쇼핑몰 URL 및 리디렉션 검증
- 전용 Chrome persistent profile
- 로그인, CAPTCHA, 접근 제한 감지
- 리뷰 업로드, 완료, 중단, 실패 API 연결
- 한 번에 작업 하나 처리 및 정상 종료
- 네이버 리뷰 영역 열기, 최신순 적용, 페이지 이동
- 네이버 별점, 본문, 작성일, 옵션 추출과 의심 신호 분류

네이버 adapter와 DOM fixture 검증까지 구현했다. 다만 실제 상품 페이지는 아직 최소
10개 수동 대조 전이므로 비공개 개발 상태다. 네이버 이외 사이트는
`adapter_not_implemented`로 안전하게 실패한다.

전체 리뷰 목록을 자동으로 열지 못했지만 상품 페이지에 대표 리뷰가 공개된 경우에는
해당 리뷰를 버리지 않고 `summary_only` 결과로 전달한다. Worker는 이를 `partial`
상태로 저장하고, 보고서에 전체 목록 미확인 제한과 리뷰 수 부족 안내를 표시한다.

네이버 보안 확인 문구는 `captcha`, 시스템 오류 페이지는 `operator_required`로
중단한다. iPhone Safari 인계가 완료되면 휴대폰 확장이 같은 Safari 세션에서 직접
리뷰를 수집하므로 Mac의 보안 쿠키나 로그인 정보를 휴대폰과 공유하지 않는다.

## 네이버 실제 canary

실제 공개 상품은 한 번만 열고 CAPTCHA, 로그인 요구, 접근 제한이 감지되면 우회나
자동 재시도 없이 즉시 종료한다.

```bash
REVIEWMOA_HEADLESS=true \
REVIEWMOA_PROFILE_DIR=/tmp/reviewmoa-canary-profile \
npm run collector:canary -- https://m.brand.naver.com/store/products/123
```

기본 품질 기준은 전체 리뷰 목록, 리뷰 10개 이상, 별점 1~5 존재, 작성일 확인 비율
50% 이상, 별점별 최신순, 중복 ID 없음, `더보기 이미지 펼치기` 문구 제거다. 정상은
종료 코드 `0`, 수집 품질 미달은 `1`, CAPTCHA·로그인·접근 제한처럼 사람 확인이
필요한 중단은 `2`를 반환한다. 실제 canary는 GitHub Actions에서 주 1회 한 상품만
실행하며 배포 때마다 네이버에 접속하지 않는다.

실제 Chrome canary는 사이트 구조 변경을 조기에 찾기 위한 보조 장치이며 iPhone
Safari 실기기 검증을 대체하지 않는다. 배포 차단의 결정적 기준은 두 어댑터가 함께
통과하는 로컬 fixture 회귀 테스트다.

## 설정

`collector/.env.example`을 참고해 저장소 루트에 `.env.collector`를 만든다. 실제
token이 든 파일과 Chrome profile은 커밋하지 않는다.

```bash
npm run collector:start
```

기본값은 화면이 보이는 Chrome을 실행한다. 최초 실행 시 열린 전용 프로필에서 필요한
쇼핑몰 로그인을 사용자가 직접 완료한다. 개인 일상용 Chrome 프로필과 같은 디렉터리를
사용하지 않는다.
