# 리뷰모아 iPhone Safari Web Extension

`extension/`은 Chrome과 Safari가 함께 사용하는 WebExtension 원본이다. iPhone
Safari에서 상품 URL을 제출하면 중앙 collector를 기다리지 않고 확장이 해당 작업을
직접 맡는다.

확장은 다음 순서로 동작한다.

1. 웹이 iPhone Safari 확장을 확인하고 작업을 `mobile-safari` 소유로 생성한다.
2. 확장이 Safari의 새 탭에서 해당 상품 페이지를 즉시 연다.
3. CAPTCHA나 로그인이 없으면 바로 리뷰를 수집한다.
4. CAPTCHA 또는 로그인이 실제로 표시된 경우에만 사용자가 직접 완료하고, 사라지면
   자동으로 수집을 재개한다.
5. 공개 리뷰만 Worker의 `mobile-complete` API로 전송한다.
6. 성공하면 원래 리뷰모아 탭으로 돌아오고 상품 탭을 닫는다. 웹의 기존 폴링이
   분석된 보고서를 표시한다.

`이 iPhone에서 보안 확인하기` 버튼은 자동 시작이 실패했거나 실제 보안 확인 중
전송이 중단됐을 때 다시 시도하는 용도다.

로그인 쿠키, 비밀번호, CAPTCHA 답은 Worker나 중앙 Mac으로 전송하지 않는다. iPhone에서
얻은 보안 통과 상태는 Mac Chrome과 공유되지 않기 때문에 리뷰 수집도 같은 Safari
세션에서 이어서 수행한다.

## Xcode 프로젝트 만들기

전체 Xcode를 설치하고 개발자 디렉터리를 Xcode로 선택한 뒤 저장소 루트에서 실행한다.

```bash
npm run safari:package
```

이 명령은 테스트 파일을 제외한 WebExtension 리소스를 `safari/package/`에 준비하고,
Apple의 `safari-web-extension-packager`로 `safari/generated/` 아래에 iOS 전용 앱과
확장 Xcode 프로젝트를 만든다. 생성물은 로컬 서명 설정을 포함할 수 있어 Git에
커밋하지 않는다.

Xcode 설치 후 다음을 확인한다.

```bash
xcodebuild -version
xcrun --find safari-web-extension-packager
```

## iPhone 테스트

- 시뮬레이터 검증은 Apple Developer Program 가입 전에도 가능하다.
- 무료 Apple 계정의 Personal Team으로 개인 iPhone에 설치해 테스트할 수 있다.
  무료 프로비저닝은 7일 후 만료되므로 이후 다시 빌드·설치해야 한다.
- TestFlight와 App Store 배포에는 Apple Developer Program 멤버십이 필요하다.
- 생성된 `safari/generated/ReviewMoa/ReviewMoa.xcodeproj`를 Xcode에서 연다.
- `ReviewMoa`와 `ReviewMoa Extension` 타깃의 `Signing & Capabilities`에서
  `Automatically manage signing`을 켜고 같은 Personal Team을 선택한다.
- iOS 앱 scheme과 대상 iPhone을 선택해 실행한다.
- iPhone의 `설정 → Safari → 확장 프로그램`에서 리뷰모아를 활성화한다.
- `reviewmoa.kro.kr`과 대상 쇼핑몰에 대한 웹사이트 접근을 허용한다.

운영 배포 전에는 App Store Connect/TestFlight 검증과 확장 권한 설명을 별도로
마무리한다.

2026-07-31 기준 무료 Personal Team으로 실제 iPhone 설치, 개발자 신뢰, Safari 확장
활성화와 네이버 상품 페이지의 팝업 실행까지 확인했다. 확장 0.1.5부터 iPhone 작업은
제출 즉시 모바일 수집을 시작하며, 진행 heartbeat와 자동 복귀를 사용한다.
