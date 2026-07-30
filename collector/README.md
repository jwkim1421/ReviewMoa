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

## 설정

`collector/.env.example`을 참고해 저장소 루트에 `.env.collector`를 만든다. 실제
token이 든 파일과 Chrome profile은 커밋하지 않는다.

```bash
npm run collector:start
```

기본값은 화면이 보이는 Chrome을 실행한다. 최초 실행 시 열린 전용 프로필에서 필요한
쇼핑몰 로그인을 사용자가 직접 완료한다. 개인 일상용 Chrome 프로필과 같은 디렉터리를
사용하지 않는다.
