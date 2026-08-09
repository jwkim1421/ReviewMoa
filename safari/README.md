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

`safari:package`는 Xcode 프로젝트를 처음 만들거나 Apple 변환기를 다시 실행해야 할
때만 사용한다. 평소 확장과 첫 실행 안내 화면을 기존 프로젝트에 동기화할 때는 다음
명령을 사용한다.

```bash
npm run safari:prepare
```

Xcode 설치 후 다음을 확인한다.

```bash
xcodebuild -version
xcrun --find safari-web-extension-packager
```

## iPhone 개발 테스트

- 시뮬레이터 검증은 Apple Developer Program 가입 전에도 가능하다.
- 무료 Apple 계정의 Personal Team으로 개인 iPhone에 설치해 테스트할 수 있다.
  무료 프로비저닝은 7일 후 만료되므로 이후 다시 빌드·설치해야 한다.
- TestFlight와 App Store 배포에는 Apple Developer Program 멤버십이 필요하다.
- 생성된 `safari/generated/ReviewMoa/ReviewMoa.xcodeproj`를 Xcode에서 연다.
- `ReviewMoa`와 `ReviewMoa Extension` 타깃의 `Signing & Capabilities`에서
  `Automatically manage signing`을 켜고 같은 Apple Developer Team을 선택한다.
- iOS 앱 scheme과 대상 iPhone을 선택해 실행한다.
- iPhone의 `설정 → Safari → 확장 프로그램`에서 리뷰모아를 활성화한다.
- `reviewmoa.kro.kr`과 대상 쇼핑몰에 대한 웹사이트 접근을 허용한다.

## TestFlight 가족 베타 배포

고정 식별자는 `safari/release.json`에서 관리한다.

- 앱: `kr.reviewmoa.ReviewMoa`
- Safari Extension: `kr.reviewmoa.ReviewMoa.Extension`

두 타깃 모두 Xcode의 `Signing & Capabilities`에서 같은 유료 Apple Developer Team과
자동 서명을 사용해야 한다. 앱 식별자를 바꾸면 기존 설치와 업데이트 연결이 끊어질 수
있으므로 배포를 시작한 뒤에는 변경하지 않는다.

### 1. 릴리스 빌드 준비

다음 명령은 TestFlight에서 중복될 수 없는 빌드 번호를 1 증가시키고, 확장 리소스와
앱 첫 실행 안내, 버전, Bundle ID, 1024px App Store 아이콘을 Xcode 프로젝트에
동기화한다.

```bash
npm run safari:release:prepare
```

준비가 끝나면 Xcode에서 앱과 확장 타깃의 Team이 같은지 확인한다. 명령줄에서 Release
Archive를 만들려면 다음 명령을 실행한다.

```bash
npm run safari:archive
```

아카이브는 `safari/build/ReviewMoa.xcarchive`에 생성되며 Git에는 포함되지 않는다.
App Store Connect용 자동 재서명과 IPA 생성을 미리 검증하려면 다음을 실행한다.

```bash
npm run safari:export
```

성공하면 `safari/build/export/`에 배포 산출물이 생성된다. `Your session has expired`가
표시되면 Xcode의 `Settings → Accounts`에서 Apple 계정을 다시 로그인한 뒤 두 타깃의
Team을 확인하고 명령을 다시 실행한다. 로그인 세션이 유효해야 Xcode가 앱과 확장의
App Store 배포 프로파일을 자동으로 만들거나 내려받을 수 있다.

### 2. App Store Connect에 앱과 빌드 등록

1. App Store Connect의 `나의 앱`에서 새 iOS 앱을 만든다.
2. Bundle ID로 `kr.reviewmoa.ReviewMoa`를 선택하고 고유 SKU를 입력한다.
3. Xcode에서 `Product → Archive`를 실행하거나 위 명령으로 만든 아카이브를
   Organizer에서 연다.
4. `Distribute App → App Store Connect → Upload` 순서로 업로드한다.
5. App Store Connect의 TestFlight 탭에서 빌드 처리가 끝날 때까지 기다린다.

같은 버전의 빌드를 다시 올릴 때도 빌드 번호는 반드시 달라야 한다. 업로드 전에
App Store Connect 앱 레코드가 먼저 만들어져 있어야 한다.

### 3. 아내를 외부 테스터로 초대

App Store Connect 사용자가 아닌 가족은 외부 테스터에 해당한다.

1. TestFlight의 내부 테스트 그룹을 먼저 만든다.
2. 외부 테스트 그룹을 만들고 처리된 빌드를 추가한다.
3. 베타 설명, 검토 연락처, 피드백 이메일과 테스트할 기능을 입력한다.
4. 첫 외부 빌드를 TestFlight App Review에 제출한다.
5. 승인 후 아내의 Apple 계정 이메일로 초대한다.
6. 아내는 iPhone의 TestFlight 앱에서 초대를 수락하고 리뷰모아를 설치한다.

TestFlight 빌드는 업로드 후 90일 동안 사용할 수 있다. 새 빌드는 같은 앱으로
업데이트되므로 Personal Team처럼 7일마다 케이블을 연결할 필요는 없다.

### 4. 가족 iPhone의 최초 설정

리뷰모아 앱을 처음 열면 다음 안내가 표시된다.

1. `설정 → 앱 → Safari → 확장 프로그램`에서 리뷰모아를 켠다.
2. 웹사이트 접근 권한을 `항상 허용`으로 설정한다.
3. 앱의 `리뷰모아 열기`를 눌러 실제 상품 URL로 수집을 한 번 확인한다.

개인정보 처리방침 URL은 `https://reviewmoa.kro.kr/privacy.html`이다. 외부 테스트 제출
전 App Store Connect의 검토 연락처와 피드백 이메일에는 실제로 확인 가능한 주소를
입력한다.

2026-07-31 기준 무료 Personal Team으로 실제 iPhone 설치, 개발자 신뢰, Safari 확장
활성화와 네이버 상품 페이지의 팝업 실행까지 확인했다. 확장 0.1.5부터 iPhone 작업은
제출 즉시 모바일 수집을 시작하며, 진행 heartbeat와 자동 복귀를 사용한다. 0.1.6부터
수집 중에는 상품 페이지 조작을 막는 진행 오버레이를 표시하고, CAPTCHA나 로그인이
실제로 감지된 경우에만 오버레이를 제거한다.
0.1.7부터 수집한 상품명을 보고서에 전달하고, 보고서의 `다시 불러오기`도 중앙
collector가 아니라 동일한 iPhone Safari 수집 흐름으로 새 작업을 시작한다.
0.1.8부터 네이버 대표 리뷰만 발견되면 전체 리뷰 링크를 같은 탭에서 열고, 이동한
전체 리뷰 페이지에서 기존 작업을 복원해 최신순·별점별 수집을 이어간다.
0.1.9부터 첫 링크가 목록을 열지 못하면 다른 전체보기 버튼을 순차적으로 시도하고,
확장 버전과 안전한 단계별 진단 결과를 작업 상태에 기록한다.
0.1.10부터 리뷰 탭을 먼저 열어 대표 리뷰 영역을 로드한 뒤 전체보기 여부를 판단한다.
따라서 초기 화면에 리뷰 DOM이 없다는 이유로 전체 목록 탐색을 건너뛰지 않는다.
0.1.11부터 네이버 화면의 대표 리뷰 판정과 무관하게 전체보기 후보를 반드시 시도하고,
URL 또는 리뷰 목록이 실제로 바뀐 경우에만 전환 성공으로 처리한다.
