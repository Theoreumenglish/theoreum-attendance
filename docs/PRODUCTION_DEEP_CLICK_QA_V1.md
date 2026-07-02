# production-deep-click-qa-v1

## 목적

네가 직접 화면을 하나하나 캡처하지 않도록, 네 PC에서 실제 production/preview 사이트를 브라우저로 열고 자동으로 눌러보는 QA 도구다.

기존 `prod:qa`는 API 중심 점검이다.  
`prod:qa:deep`은 실제 브라우저 화면 중심 점검이다.

## 실행되는 것

- `/` 키오스크 접속
- 010 뒤 8자리 입력 UI 확인
- `staff` hotword 직원 모드 확인
- `/admin.html` 접속
- QA 계정 로그인
- 핵심 메뉴 이동
- 휴대폰 출결 준비도 버튼 실행
- 중앙DB 직원 관리 화면 확인
- 학생 검색 화면 확인
- 학생 링크 / 온라인강의 영역 표시 확인
- `/student-today.html` 표시 확인
- 콘솔 오류 수집
- pageerror 수집
- HTTP 400/500 응답 수집
- 화면 스크린샷 저장
- 복붙용 리포트 생성
- 스크린샷 zip bundle 생성

## 읽기 전용 실행

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"
npm run prod:qa:deep -- -BaseUrl "https://theoreum-attendance.vercel.app" -StaffId "chatgpt_qa" -Password "임시비밀번호" -StudentQuery "QA학생" -StudentTail8 "11112222" -StaffTail8 "55556666"
```

## 쓰기 포함 실행

학생 링크 생성, 숨김 온라인강의 테스트 저장, 직원 출근 테스트까지 포함한다.

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"
npm run prod:qa:deep:write -- -BaseUrl "https://theoreum-attendance.vercel.app" -StaffId "chatgpt_qa" -Password "임시비밀번호" -StudentQuery "QA학생" -StudentTail8 "11112222" -StaffTail8 "55556666"
```

## 생성 파일

```txt
_logs/PRODUCTION_DEEP_QA_TO_SEND.txt
_logs/PRODUCTION_DEEP_QA_REPORT.md
_logs/PRODUCTION_DEEP_QA_RAW.json
_logs/PRODUCTION_DEEP_QA_BUNDLE.zip
_logs/deep-qa/<run-id>/*.png
```

ChatGPT에는 보통 `PRODUCTION_DEEP_QA_TO_SEND.txt` 내용만 보내면 된다.  
화면 디자인 문제까지 봐야 하면 `PRODUCTION_DEEP_QA_BUNDLE.zip`도 같이 첨부한다.

## 비밀번호 보안

비밀번호와 sessionToken은 리포트에 쓰지 않는다.  
명령어 실행 중 환경변수로만 사용한다.

테스트가 끝난 QA 계정 비밀번호는 변경하거나 비활성화한다.

## 첫 실행

처음 실행할 때 Playwright가 없으면 스크립트가 자동으로 임시 설치한다.

```txt
npm install --no-save playwright@1
```

package.json에는 저장하지 않으므로 운영 의존성은 늘어나지 않는다.

## v2 note: automatic screenshot bundle

Deep QA now writes `_logs/PRODUCTION_DEEP_QA_BUNDLE.zip` automatically. The operator no longer has to manually compress the screenshot folder.


## v1.1 bundle upgrade

`run-production-deep-click-qa.ps1` now copies the copy-ready report, raw JSON, and a screenshot README into the screenshot directory before creating `PRODUCTION_DEEP_QA_BUNDLE.zip`. This keeps screenshots and logs together so the user does not need to manually compress the folder.

Student search QA uses the visible top student search button (`btnStudentSearchNow`) rather than the lower centralDB maintenance search button.


## Timestamped screenshot bundles

Each deep QA run must produce two zip files in `_logs`:

- `PRODUCTION_DEEP_QA_BUNDLE_<runId>.zip` — permanent timestamped bundle for that run.
- `PRODUCTION_DEEP_QA_BUNDLE.zip` — latest-run alias for quick attachment.

The bundle includes screenshots, DOM audit JSON files, the copy-ready QA report, the full markdown report, raw JSON, and `README_SCREENSHOTS.txt`.

Screenshots are captured with Playwright `page.screenshot`, so they capture the tested browser page DOM rather than the entire Windows desktop. Other apps/windows on the monitor are not included, but the user should not type or click in the QA browser while the runner is working because focus can affect keyboard/click automation.


## Midcycle QA UI review

From `midcycle-qa-ui-review-v1`, the deep QA bundle also includes `SCREENSHOT_INDEX.html`. Open it inside the zip to review all screenshots in one page.

The student today public page must expose `data-qa-state="loaded"` after real data is rendered. Deep QA waits for that state before capturing the public student link screenshot, so a loading-only screen is no longer accepted as a pass.
