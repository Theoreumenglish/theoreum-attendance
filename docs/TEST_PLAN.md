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
| 학생 학번 출결 | 일반 재원생 학번 4자리로 등원/하원 정상, 이름 음성 미출력 |
| 학생 QR | QR 보조수단으로 등원/하원 정상, 이름 음성 미출력 |
| 직원 QR | staff/staffout 정상, 이름 음성 미출력 |
| QR 어려운 학생 표시 | `is_exception=Y`는 허용 조건이 아니라 운영 표시로 유지 |
| 일반 학생 | 학번 4자리 직접 출결 가능 |
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
| 맞은개수 입력 | 학생 ID + 회차 ID + 점수 저장 가능 |
| 불통과 자동 후보 | 통과개수 미만 저장 시 `clinic_tasks.source_type = WORD_FAIL` 후보 생성 |
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

## First Complete Portal v1 테스트

배포 전 자동 검사:

```powershell
npm run verify
```

수동 테스트:

1. 단어시험 회차를 생성한다.
2. 회차 선택 후 반 ID를 확인하고 `명단 불러오기`를 누른다.
3. 여러 학생 맞은개수를 입력하고 `전체 저장`을 누른다.
4. 불통과 학생이 `clinic_tasks` 후보로 생성되는지 확인한다.
5. 학생을 선택한 뒤 리포트 화면에서 기간을 입력하고 `리포트 미리보기`를 누른다.
6. 단어 평균, 출석일, 공개 클리닉 메모가 표시되는지 확인한다.
7. `스냅샷 저장` 후 `report_snapshots`에 row가 생기는지 확인한다.
8. 설정·점검 화면에서 감사 로그를 조회한다.

## First Complete Portal v2 test checklist

1. Run `npm run verify`.
2. Create or select a word-test session.
3. Enter one student's correct count and click **결과 저장**.
4. Click **결과 확인** and confirm the saved row appears.
5. Enter a failing score and confirm a WORD_FAIL clinic candidate is created.
6. Change that same result to PASS or EXEMPT and confirm the linked WORD_FAIL clinic is marked DONE.
7. Preview a report for a selected student.
8. Save a report snapshot.
9. Click **스냅샷 조회** and confirm the saved snapshot appears.
10. Check **설정 → 감사 로그** for `wordTest.listResults`, `report.listSnapshots`, `clinic.autoResolveWordFail`, and related write operations where applicable.

## 2026-06-13 Integrity / Smoke / Clinic Notice v2

추가 검증 루틴:

```powershell
npm run verify
npm run smoke-test
```

`npm run verify`는 정적 검사, UI 계약 검사, UX 검사, 업무 흐름 시뮬레이션, 무결성 검사, 운영 체크리스트, 빌드를 순서대로 실행한다.

실제 API smoke-test는 배포 후 아래 환경변수를 지정해 실행한다.

```powershell
$env:SMOKE_BASE_URL="https://<배포도메인>"
$env:SMOKE_STAFF_ID="<직원ID>"
$env:SMOKE_PASSWORD="<비밀번호>"
npm run smoke-test
```

확인 대상:

- meta.ping
- auth.me
- auth.login / auth.logout
- admin.getOpsOverview
- clinic.listTasks
- wordTest.listSessions
- report.listSnapshots

운영 체크리스트 자동화는 `scripts/ops-checklist.mjs`에서 수행한다. 이 검사는 외부 API를 호출하지 않으므로 `npm run verify`에 포함된다.


## 클리닉 알림톡 5종 테스트

배포 후 다음 순서로 확인한다.

1. 클리닉 메뉴에서 task 조회
2. 알림 유형을 `학부모 예약`으로 선택하고 `알림 예약` 클릭
3. `HH:MM` 예정시간 입력
4. 문자 메뉴에서 `CLINIC / PENDING` queue 확인
5. 같은 task에 대해 `학생 예약`, `학부모 미제출`, `학생 미제출`, `학부모 미등원`도 각각 예약
6. 학생용 알림은 prompt에 테스트 학생 번호 입력
7. worker 실행 후 `DONE` 또는 실패 원인 확인
8. 감사 로그에서 다음 op 확인
   - `clinic.queueReservationParent`
   - `clinic.queueReservationStudent`
   - `clinic.queueMissingParent`
   - `clinic.queueMissingStudent`
   - `clinic.queueAbsenceParent`

정적 검사는 `npm run verify`에 포함되어 있다. 실제 NCP 발송은 배포 후 `npm run smoke-test`와 화면 queue 테스트로 확인한다.


## Offline clinic auto-notification test

1. Run `docs/supabase-clinic-auto-notify-v1.sql` in Supabase.
2. Create an offline clinic with due date and due time.
3. Confirm queue rows are created for immediate reservation, 08:00 reminder, and absence follow-up.
4. Confirm student notices use `students.student_phone` without prompting for a phone number.
5. Confirm future reminder/absence rows remain PENDING until `occurred_at`.
6. Mark clinic DONE before absence time and confirm the absence row is skipped by the worker.

## Clinic semantics v2 tests

1. 클리닉 메뉴에서 수업 클리닉 선택 → 반 ID 입력 → 반 명단 확인 → 생성 → 해당 반 학생 수만큼 clinic_tasks 생성 확인.
2. 오늘 할 일 보기 → due_date=오늘, terminal 상태 제외 목록 표시 확인.
3. 개별 클리닉 선택 → 클리닉 메뉴 내부 학생 검색 → 학생 선택 → 생성 → 해당 학생에게만 row 생성 확인.
4. 추가 클리닉 선택 → 학생 선택 → 예정일/예정시간/OFFLINE/자동 알림 → 생성 → CLINIC_RESERVATION_*, CLINIC_REMINDER_*, CLINIC_ABSENCE_PARENT queue 확인.
5. 수업/개별 클리닉은 자동 알림이 생성되지 않는지 확인.

## 2차 완성본 v2 테스트

1. `npm run verify` 통과.
2. Supabase SQL Editor에서 `docs/supabase-clinic-performance-v2.sql` 실행.
3. 수업 클리닉을 반 전체로 생성한다.
4. 클리닉 메뉴에서 오늘 업무판을 조회한다.
5. 수업 클리닉 묶음의 `목록` 버튼으로 개별 task가 필터링되는지 확인한다.
6. `열린 건 완료`로 해당 묶음이 DONE 처리되는지 확인한다.
7. Supabase `clinic_logs`, `portal_audit_logs`에서 `BULK_STATUS_CHANGE`, `clinic.bulkUpdateStatus` 기록을 확인한다.
8. 배포 후 `npm run smoke-test`에서 `clinic.todayBoard`까지 통과하는지 확인한다.

## 최종 운영 체크 v1

2차 완성본에는 `admin.finalReadiness`와 관리자 포털 `설정 → 최종 운영 체크`가 포함됩니다.
이 기능은 DB 스키마, 연락처 동기화율, 환경변수, 클리닉 알림 queue, 단어시험, 리포트, 감사 로그 준비 상태를 한 번에 점검합니다.
배포 후에는 `npm run smoke-test`와 함께 최종 운영 체크를 실행한 뒤 메뉴별 디테일 패치로 넘어갑니다.

## 클래스 조회 / 속도 개선 v1 추가 점검

- 클래스 메뉴 진입 시 날짜가 자동으로 오늘로 고정되지 않고, 비워두면 전체 클래스 목록을 조회한다.
- 날짜는 `YYYYMMDD`와 `YYYY-MM-DD` 모두 허용한다.
- 해당 날짜 `class_schedule`이 비어 있으면 전체 `classes` 목록으로 자동 대체된다.
- live smoke-test는 `assistant.listClassOptions`를 포함한다.
- 운영 속도 인덱스는 `docs/supabase-class-speed-v1.sql`을 실행해 적용한다.

## CentralDB 기능 이관 v3 테스트

1. 클래스 메뉴에서 클래스 선택 후 반별 휴강 조회, 추가, 삭제를 테스트한다.
2. 같은 화면에서 실제 일정 조회, 상태/사유 수동 수정, 일정 재생성을 테스트한다.
3. 학원 전체 휴무 조회, 추가, 삭제를 테스트한다.
4. 직원 메뉴에서 중앙DB 직원 목록 조회, 신규/수정 저장, 활성 토글, 비밀번호/PIN 재설정을 테스트한다.
5. 설정 메뉴에서 중앙DB 시스템 설정 조회/저장, self-check 실행을 테스트한다.
6. 모든 쓰기 작업 후 클래스 목록, 반 명단, 학생 검색, 직원 목록을 다시 조회해 캐시 무효화가 반영되는지 확인한다.
7. Vercel 배포 후 `npm run smoke-test`에서 `admin.central.props.get`, `admin.central.staff.list`가 200 OK인지 확인한다.

## v4 추가 테스트

1. 출결 메뉴 → 미등원 문자 제외에서 날짜/반/학생을 입력하고 1명 추가한다.
2. 같은 화면에서 예외 조회 후 row가 보이는지 확인한다.
3. 일괄 학번에 `0001,0002` 형식으로 입력해 여러 명 추가가 되는지 확인한다.
4. 조회된 예외 row의 삭제 버튼으로 중앙DB/GAS와 Supabase replica에서 함께 삭제되는지 확인한다.
5. 직원 메뉴 → 중앙DB 직원 목록 조회가 첫 호출 이후 1초 안팎으로 재조회되는지 확인한다.
6. 설정 메뉴 → 중앙DB 설정 조회가 최초 원본 조회 후 snapshot으로 빠르게 열리는지 확인한다.


## UI/UX Refresh v1 검증

- 상단 작업 클래스 선택 후 클리닉/단어/미등원 예외 class_id 자동 반영 확인
- 클래스 메뉴 빠른 선택 후 수정 폼/수강생 명단 연동 확인
- 담당 직원 select 선택 후 staff_id hidden mirror 입력 확인
- 학생DB 검색 결과 선택 후 수강생 추가 칸 자동 입력 확인


## UI/UX Refresh v2 리허설

1. 상단 작업 클래스를 선택하고 딸깍 업무 보드 6개 tile을 확인한다.
2. 클래스 행 클릭 시 우측 작업 패널이 열리는지 확인한다.
3. 학생 검색 결과 선택 시 학생 작업 패널이 열리는지 확인한다.
4. 클래스 저장, 학생DB 저장, 수강생 추가, 클리닉 생성, 단어 저장, 리포트 저장 시 하단 저장 상태가 즉시 표시되는지 확인한다.
5. 현장/태블릿 모드 전환 후 사이드 메뉴가 축소되고 태블릿 폭에서 화면이 깨지지 않는지 확인한다.
6. 리포트 미리보기의 학부모 전달 문구가 카드형으로 표시되는지 확인한다.

## 실시간 미등원 보드 테스트

1. 배포 후 `npm run smoke-test`에서 `assistant.todayAbsenceBoard`가 200 OK로 통과하는지 확인한다.
2. 오늘 날짜 `class_schedule`에 수업이 있고 시작 시간이 지난 반을 기준으로, 아직 등원하지 않은 학생이 보드에 표시되는지 확인한다.
3. 학생이 학번 4자리 또는 QR로 등원 처리되면 다음 자동 갱신 또는 새로고침 후 목록에서 사라지는지 확인한다.
4. 미등원 예외를 추가하면 다음 새로고침 후 목록에서 제외되는지 확인한다.
5. 학부모/학생 번호 복사, 학생 선택, 예외 입력 이동 버튼이 정상 동작하는지 확인한다.


## 학생 학번 출결 기본화 테스트

1. 키오스크 등원 모드에서 일반 재원생 학번 4자리를 입력한다.
2. `등원 완료`가 표시되고 `attendance_logs.meta_json.input_mode`가 `STUDENT_ID`로 남는지 확인한다.
3. 같은 학생을 다시 입력했을 때 `이미 등원 처리됨`이 표시되는지 확인한다.
4. 하원 모드에서 같은 학번 4자리를 입력해 `하원 완료`가 표시되는지 확인한다.
5. 기존 학생 QR 스캔도 계속 정상 처리되는지 확인한다.
6. 잘못된 학번이나 재원 상태가 아닌 학생은 기존처럼 차단되는지 확인한다.

## Smoke-test local env / one-click release v1

1. 최초 1회 `scripts/setup-smoke-env.ps1`로 `.env.smoke.local`을 만든다.
2. `.env.smoke.local`은 Git과 release zip에 포함하지 않는다.
3. `npm run smoke-test`는 `.env.smoke.local`을 자동으로 읽어 로그인 이후 보호 API까지 확인한다.
4. 패치 완료 시 `scripts/one-click-release.ps1`로 문법검사, 전체검증, 빌드, 커밋, 푸쉬, 압축파일, 배포, smoke-test를 한 번에 실행할 수 있다.
