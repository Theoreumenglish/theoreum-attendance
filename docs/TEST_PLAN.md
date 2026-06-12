# 더오름 운영 포털 테스트 계획

이 문서는 운영 안정성과 포트폴리오 신뢰성을 위해 단계적으로 추가할 테스트 범위를 정리한다. 현재 단계에서는 대규모 E2E보다 정적 계약 검사와 smoke test를 먼저 도입한다.

## 1. 현재 수동 검사 기준

배포 전 항상 실행한다.

```powershell
Select-String -Path .\public\admin.html,.\public\sw.js,.\docs\OPERATIONS_PORTAL_V1.md -Pattern '^<<<<<<<|^=======|^>>>>>>>'
node --check .\public\sw.js

$adminHtml = Get-Content .\public\admin.html -Raw
$adminScript = [regex]::Match($adminHtml, '(?s)<script>(.*?)</script>').Groups[1].Value
$adminScript | Set-Content -Encoding UTF8 .\_admin_inline_check.js
node --check .\_admin_inline_check.js
Remove-Item .\_admin_inline_check.js -Force

git diff --check
npm run check
npm run build
```

## 2. Static Contract Test v1

예정 파일:

```text
scripts/contract-check.mjs
```

검사 항목:

| 항목 | 목적 |
| --- | --- |
| `public/admin.html` script 문법 | inline JS 깨짐 방지 |
| 중복 id 검사 | 버튼/입력 연결 충돌 방지 |
| `data-go` 대상 검사 | 메뉴 클릭 대상 누락 방지 |
| 필수 화면 id 검사 | dashboard/attendance/students 등 유지 |
| 필수 버튼 id 검사 | 로그인, 로그 조회, 수동 정정 등 유지 |
| 필수 RPC op 문자열 검사 | api/rpc.js 공개 계약 유지 |
| service worker cache version 검사 | 배포 후 캐시 꼬임 방지 |

## 3. Smoke Test v1

환경변수와 테스트 계정이 준비된 뒤 추가한다.

예정 파일:

```text
scripts/smoke-test.mjs
```

테스트 항목:

| 테스트 | 의미 |
| --- | --- |
| 로그인 실패 | auth validation |
| 로그인 성공 | auth flow |
| `auth.me` | session 유지 |
| 학생 검색 | 핵심 read flow |
| 출결 로그 조회 | attendance read flow |
| 권한 없는 admin op 차단 | role control |
| 수동 정정 validation 실패 | auditability 전 단계 |
| 운영 요약 조회 | reporting |

## 4. E2E Test v1

나중에 Playwright 또는 동등한 도구로 도입한다. 지금은 범위가 너무 커서 보류한다.

예정 시나리오:

1. 직원 로그인
2. 학생 검색
3. 출결 로그 조회
4. QR 예외 학생 등록/해제
5. 수동 정정 validation
6. 학부모 리포트 링크 미리보기
7. 로그아웃

## 5. 실제 운영 검수 체크리스트

| 영역 | 확인 |
| --- | --- |
| 학생 QR | 등원/하원 정상, 이름 음성 미출력 |
| 직원 QR | staff/staffout 정상, 이름 음성 미출력 |
| QR 예외 | `is_exception=Y` 학생 학번 출결 가능 |
| 일반 학생 | 학번 직접 출결 차단 |
| 수동 정정 | PIN + reason + source_trace_id 필수 |
| 알림 | 실패 큐 조회 정상 |
| 포털 UI | 메뉴별 화면 독립 표시, hash 유지 |
| 캐시 | `public/sw.js` cache version 증가 |

## 6. 실패 시 원칙

- 배포 전 실패: 커밋하지 않는다.
- 배포 후 화면 이상: service worker/cache를 먼저 의심한다.
- 출석/QR 로직 이상: 최신 안정화 태그와 diff 비교한다.
- 중앙DB GAS 수정 시: Apps Script 새 Web App 버전 배포가 필요하다.
## 7. Cron / Worker 안정화 검수

| 항목 | 확인 |
| --- | --- |
| 미등원 감지 cron | `/api/absent-run-cron`은 detection과 queue 생성만 수행 |
| 문자 worker cron | `/api/attendance-notify-worker`가 queue 발송만 수행 |
| 중복 실행 방지 | worker claim 조건이 `queue_id + status=PENDING`인지 확인 |
| stale 복구 | `PROCESSING` 장기 방치 항목이 `ATT_NOTIFY_STALE_SEC` 이후 PENDING 복구 |
| 미등원 발송 기한 | `ABSENT_QUEUE_MAX_AGE_MIN` 초과 queue는 발송하지 않고 만료 처리 |
| 감사 로그 | `absence_detection_runs`, `notify_worker_runs`가 각각 분리 기록 |


## 8. 운영 관측성 / 클래스 조회 검수

| 항목 | 확인 |
| --- | --- |
| 홈 cron health | 미등원 감지 cron과 문자 worker cron 카드가 정상/점검 상태를 분리 표시 |
| 자동화 기록 | 설정·점검에서 미등원 감지 기록과 문자 worker 기록 조회 가능 |
| 클래스 목록 | 날짜 입력 시 class_schedule 기준 목록 조회 가능 |
| 클래스 전체 | 날짜를 비우면 classes 기준 목록 조회 가능 |
| 수강생 명단 | 클래스 목록에서 명단 버튼 클릭 시 class_students + students 기준 roster 표시 |
| 권한 | 클래스 조회는 조교 이상, 자동화 기록은 관리자 이상 정책 유지 |

## 9. Batch Portal v1 검수

| 항목 | 확인 |
| --- | --- |
| 학생 360 | 학생 검색 후 오늘 상태, QR 예외, 최근 출결, 소속 클래스, 최근 결석예외 표시 |
| 학생 정정 연결 | 학생 최근 출결의 원본 버튼 클릭 시 수동 정정 폼에 student_id와 trace_id 반영 |
| 문자 queue | 상태/종류별 queue 조회 가능 |
| 문자 재처리 | FAILED + ABSENT/ATTENDANCE 선택 후 관리자 PIN으로 재처리 가능 |
| 직원 월간 | staff_monthly 월간 요약 조회 가능 |
| 직원 일별 | 월간 요약에서 직원 선택 시 staff_daily 상세 표시 |
| 권한 | admin 전용 직원/문자 재처리 기능은 권한 없을 때 서버가 차단 |
| 정적 계약 | `npm run contract-check`가 신규 id/op를 확인 |

## 10. Clinic / Word / Audit Schema v1 검수

| 항목 | 확인 |
| --- | --- |
| SQL 실행 | Supabase SQL Editor에서 `docs/supabase-clinic-word-report-schema-v1.sql` 실행 성공 |
| 테이블 확인 | `clinic_tasks`, `word_test_sessions`, `word_test_results`, `portal_audit_logs` 존재 |
| 클리닉 생성 | 학생 선택 후 클리닉 생성 시 `clinic_tasks`에 row 생성 |
| 클리닉 조회 | 상태별 조회와 학생 필터 조회 가능 |
| 클리닉 상태 변경 | 목록에서 상태 변경 시 `updated_at`, `updated_by`, `clinic_logs` 반영 |
| 단어시험 회차 | 회차 생성 후 목록에서 선택 가능 |
| 점수 입력 | 학생 ID + 회차 ID + 점수 저장 가능 |
| 불통과 자동 후보 | 기준점수 미만 저장 시 `clinic_tasks.source_type = WORD_FAIL` 후보 생성 |
| Student 360 | 최근 클리닉과 최근 단어시험 결과 표시 |
| 감사 로그 | 신규 write op가 `portal_audit_logs`에 best-effort 기록 |
| 정적 계약 | `npm run contract-check`가 신규 id/op/schema를 확인 |

## One-click Operations UX v1 테스트

1. 로그인 후 상단 원클릭 업무 런처가 보이는지 확인한다.
2. 원클릭 검색창에 학생 이름 또는 학번을 입력하고 Enter를 눌러 학생 검색 화면으로 이동하는지 확인한다.
3. 학생을 선택한 뒤 상단 선택 학생 문구가 갱신되는지 확인한다.
4. 홈 > 오늘 전체 점검을 눌러 운영 요약, 문자 큐, 클리닉 후보, 단어시험 회차 조회가 연속 실행되는지 확인한다.
5. 학생 선택 후 “오늘 로그” 버튼을 눌러 출결 화면의 날짜/학번이 자동 입력되고 로그 조회가 실행되는지 확인한다.
6. 학생 선택 후 클리닉 프리셋 중 “단어 재시험”을 눌러 clinic_tasks가 생성되는지 확인한다.
7. 단어시험 회차 선택 + 학생 선택 후 80점 저장 버튼을 눌러 FAIL 결과와 WORD_FAIL 클리닉 후보가 생성되는지 확인한다.
8. 문자·알림 화면에서 미등원 실패/등하원 실패 필터 버튼이 상태와 종류를 자동 설정하는지 확인한다.
9. `npm run verify`에서 중복 id 검사와 원클릭 업무 필수 id/함수 검사가 통과하는지 확인한다.

## Simple Ops UX v2 checks

Run before deployment:

```powershell
npm run verify
```

`verify` now includes `npm run ux-check` in addition to syntax, contract, and build checks.

Manual smoke test:

1. Login screen shows only brand, employee ID, password, and login button.
2. Primary side menu shows only 5 core items.
3. Secondary menus are under `더 보기`.
4. Top quick dock has student search plus four action buttons.
5. Dashboard has at most four buttons and no explanatory marketing board.
6. Select a student and confirm attendance, clinic, and word-score workflows are auto-filled.

## Balanced Simple Ops UX v3 verification

Run `npm run verify` before deploy. It now includes:

1. JS syntax check
2. API/UI contract check
3. Admin UX complexity check
4. Admin flow simulation
5. Vite build

Manual simulation after deploy:

1. Login screen shows 직원 로그인 / 직원 ID / 비밀번호.
2. Side menu shows all 10 menu items without hidden 더 보기.
3. Select a student and confirm 오늘 로그 / 클리닉 / 점수 / 리포트 flows.
4. Clinic screen exposes only 생성/조회 as primary buttons.
5. Word screen exposes only 회차 생성/회차 조회/결과 저장 as primary buttons.
6. Enter key in 점수 input saves the word-test result.
