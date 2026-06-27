# 프로젝트 인수인계/운영 기준 (운영 고도화 단계)

## 1) 현재 상태표 (반드시 이 표 기준으로 판단)

- **중앙DB GAS (`v26.0-central-ultimate`)**: 운영 중인 기준 시스템(SSOT), strict schema/repair/self-check/cron/replica sync 허브.
- **출석 GAS (`v27.2.2-att-central-final`)**: 레거시 기준 동작 + 운영 보조/비상 레퍼런스.
- **직원 QR 생성기 GAS (`v1.0.1-staff-release2`)**: 직원 QR 세션/검증 정책 원본.
- **Vercel/Supabase**: 실시간 핫패스 주력 런타임. 이전의 큰 줄기는 완료되었고, 현재는 운영 안정화·기능 추가·UI/UX 고도화 대상.

> 핵심: 이 프로젝트는 GAS를 “전부 폐기”하는 것이 아니라,
> **중앙DB 정책 원본은 유지하고, 실시간 운영은 Vercel/Supabase direct runtime으로 굳힌 상태에서 안정화와 고도화를 진행**하는 단계다.

## 2) 권위 순서 (authoritative precedence)

정책/코드가 충돌할 때 신뢰 순서는 아래와 같다.

1. 현재 배포된 **direct 런타임 동작**
2. 마지막에 통과된 **기준본 버전 파일**
3. 레거시 파일의 오래된 주석/중간 스니펫

## 3) 절대 깨면 안 되는 데이터/계약

- SSOT는 중앙DB 유지.
- STAFF / 학생 exact header 계약 유지.
- `student_id`, 전화번호, `qr_id`는 **텍스트** 처리.
- 학생 QR prefix: `QR1.*`, 직원 QR prefix: `STAFFQR1.*`.
- `trace_id`는 로그/미러링/감사 경로에서 **필수 계약**.
- 스케줄 판정은 `CLASS_SCHEDULE` 우선, `CLASSES` fallback.

## 4) 런타임 구분 (혼용 금지)

- GAS 프론트: `google.script.run`, `?res=manifest`/`?res=sw` 계열 자산 경로.
- Vercel 프론트: 정적 자산 경로(`/manifest.webmanifest`, `/sw.js`) + `fetch('/api/...')`.

같은 UI처럼 보여도 RPC 계층/자산 경로가 다르므로 **섞으면 바로 깨진다**.

## 5) 운영 고도화 우선순위 (현 시점)

1. 중앙DB bridge / hybrid write / replica patch 정합성 고정
2. direct 런타임의 cron·worker·sync 운영 안정화
3. 직원 화면 입력 UX와 장애 대응 도구 고도화
4. 레거시 fallback 제거 여부를 최신 운영본 기준으로 최종 검수

## 6) 운영 전 최종 점검 체크리스트

1. 중앙DB self-check/cron 정상 여부
2. STAFF/학생 exact header 검증
3. snapshot 최신화 확인
4. direct env/secret 세트 확인
5. 학생 QR / 예외 PIN / 직원 웹출퇴근 / 직원 QR 실스캔 테스트
6. notify worker sweep/stale recovery 확인

## 7) 롤백 원칙

- 기준 데이터 문제: 중앙DB에서 해결.
- direct 런타임 문제: Vercel 배포 rollback 우선.
- 레거시 GAS는 완전 검수 전까지 비상 레퍼런스로 유지.
- 오래된 스니펫 복붙으로 rollback하지 말고, **통과된 최신 배포 커밋 기준**으로 되돌린다.

### 2026-05-16 운영 고도화 추가 기준
- 중앙DB 직접 수정 경로는 selective replica patch를 우선 적용하고, 실패/복구가 필요할 때만 전체 `중앙DB 최신화 반영`을 사용한다.
- 직원 화면은 운영 상태 요약 카드, 결석예외 반 roster 다중선택, queue 범주 선택(미등원/등하원)을 기준 UI로 삼는다.
- 전체 replica sync는 중복 실행 방지와 마지막 상태 확인을 전제로 운영한다.

### 2026-06-12 cron/worker 운영 기준
- `/api/absent-run-cron`은 미등원 감지와 queue 생성만 수행한다.
- `/api/attendance-notify-worker`는 `attendance_notify_queue` 발송만 수행한다.
- 두 cron이 모두 매분 실행되더라도 역할은 분리되어야 하며, 감지 cron 내부에서 worker를 직접 호출하지 않는다.
- 중복 queue는 `attendance_notify_queue(trace_id, action_type)` unique index와 duplicate 처리로 막는다.
- 발송 중복은 worker의 `PENDING → PROCESSING → DONE/FAILED` 상태 전이와 `queue_id + status=PENDING` claim 조건으로 막는다.
- 오래된 `PROCESSING` 항목은 `ATT_NOTIFY_STALE_SEC` 기준으로 `PENDING` 복구 후 재처리한다.
- 오래된 미등원 queue는 `ABSENT_QUEUE_MAX_AGE_MIN`을 초과하면 발송하지 않고 `ABSENT_SEND_WINDOW_EXPIRED`로 실패 처리한다.

### 2026-06-12 운영 관측성/클래스 조회 기준
- 홈 대시보드는 `admin.getOpsOverview`의 `cron_health`를 표시하여 미등원 감지 cron과 문자 worker cron이 따로 정상 실행되는지 바로 보여준다.
- 설정·점검 화면의 자동화 실행 기록 버튼은 `admin.listAbsenceRuns`, `admin.listNotifyWorkerRuns`로 최근 실행 이력을 조회한다.
- 클래스 화면은 더 이상 placeholder가 아니라 `assistant.listClassOptions`와 `assistant.listClassRoster`를 이용하는 조회 전용 운영 화면이다.
- 클래스 조회는 날짜 입력 시 `class_schedule`, 날짜 미입력 시 `classes`를 확인하는 API 계약을 따른다.

### 2026-06-12 Batch Portal v1 운영 기준
- 학생 화면은 `assistant.getStudentProfile`을 사용해 Student 360 Profile v1로 전환한다.
- Student 360 Profile v1은 기본 정보, 오늘 출결 상태, QR 예외, 최근 출결, 소속 클래스, 최근 결석예외를 한 화면에 표시한다.
- 문자·알림 화면은 `attendance_notify_queue` 조회와 실패 큐 재처리를 직접 제공한다. 재처리는 관리자 PIN을 요구한다.
- 직원 화면은 `staff_monthly`, `staff_daily` 기반 월간/일별 근무 조회 화면으로 전환한다.
- 클리닉, 단어시험, 리포트 화면은 DB 쓰기 전 단계로 운영 흐름과 스키마 방향을 UI에 고정한다.

### 2026-06-12 Clinic / Word / Audit Schema v1 운영 기준
- SQL 파일 `docs/supabase-clinic-word-report-schema-v1.sql`을 Supabase SQL Editor에서 먼저 실행해야 한다.
- 앱 배포 전에 SQL이 실행되지 않으면 `clinic_tasks`, `word_test_sessions`, `portal_audit_logs` relation missing 오류가 발생한다.
- `clinic.createTask`, `clinic.updateTaskStatus`, `wordTest.createSession`, `wordTest.enterResult`는 Supabase runtime table에 먼저 기록한다.
- 단어시험 결과가 FAIL이면 기본값으로 `clinic_tasks`에 `source_type = WORD_FAIL` 후보가 자동 생성된다.
- 내부 메모와 학부모 공개 메모는 각각 `internal_note`, `parent_note`, `parent_visible`로 분리한다.
- 중앙DB GAS는 이 단계에서 수정하지 않는다. 운영 흐름 검증 후 Google Sheets SSOT/replica 확장을 별도로 진행한다.

## 2026-06-12 One-click Operations UX v1

최신 관리자 포털은 원클릭 업무 런처를 중심으로 이동한다. 상단 quickDock은 모든 화면에서 유지되며, 선택 학생과 연결된 주요 업무를 즉시 실행한다.

주요 확인 포인트:

1. 학생 검색 후 quickSelectedStudentText가 선택 학생으로 바뀌는지 확인한다.
2. 오늘 전체 점검 버튼이 overview, 문자 queue, 클리닉 후보, 오늘 단어시험을 순차 조회하는지 확인한다.
3. 학생 선택 후 오늘 로그, 단어 입력, 클리닉 생성 버튼이 각각 해당 화면과 필드를 자동 준비하는지 확인한다.
4. 클리닉 프리셋 버튼이 clinic_tasks를 생성하고 Student 360에 반영되는지 확인한다.
5. 단어시험 맞은개수 프리셋 버튼이 word_test_results 저장과 FAIL 시 WORD_FAIL 클리닉 후보 생성을 유지하는지 확인한다.

## 2026-06-12 Simple Ops UX v2

The admin portal was simplified after field feedback that the previous one-click version still felt visually busy. This patch does not change the database or server API. It narrows the visible interface to the daily operating loop and adds `scripts/admin-ux-check.mjs` to prevent future UI bloat.

Key rule: new features should be added behind an existing daily action, a specific student profile, or a collapsed advanced area instead of adding another always-visible button.

## 2026-06-12 Balanced Simple Ops UX v3

This patch corrects over-simplification from the previous UX pass. The login page now keeps necessary guidance while removing non-essential explanation. The side menu is no longer hidden behind a details menu; all operational categories are visible. Complexity is controlled inside each page by reducing duplicated buttons and moving occasional actions into secondary sections.

No Supabase schema changes and no CentralDB GAS changes are required.

## 2026-06-12 First Complete Portal v1

이번 버전은 1차 완성본 방향으로 다음 업무를 실제 데이터에 연결했다.

- 단어시험 반 전체 일괄 입력
- 불통과 자동 클리닉 후보 생성
- 학생별 학부모 리포트 미리보기
- 리포트 스냅샷 저장
- 설정·점검 화면의 감사 로그 조회

중앙DB GAS 변경 없음. Apps Script Web App 새 배포 필요 없음.

## 2026-06-12 — First Complete Portal v2

- Added `wordTest.listResults` for post-entry verification of word-test results by session/student/status.
- Added `report.listSnapshots` so saved parent-report snapshots can be reviewed from the admin portal.
- Added automatic WORD_FAIL clinic resolution: when a previously failed word-test result linked to a clinic is later saved as PASS or EXEMPT, the linked WORD_FAIL clinic task is marked DONE and logged.
- Tightened report preview period filtering for clinic tasks with both start and end bounds.
- Admin portal now includes:
  - word-test result review table,
  - report snapshot history table,
  - snapshot JSON tucked behind a details panel rather than always exposed.
- Verification expanded through contract-check and flow-sim for the new result-review and snapshot-review flows.

## 2026-06-13 handover note

이번 패치는 Supabase SQL과 CentralDB GAS를 변경하지 않는다.

추가된 실행 명령:

```powershell
npm run ops-checklist
npm run smoke-test
```

`npm run smoke-test`는 실제 배포 URL이 필요하므로 배포 후 `SMOKE_BASE_URL`을 지정해서 실행한다.


## 2026-06-13 Complete Ops v4: 클리닉 알림톡 템플릿 5종

적용된 템플릿 코드:

- `offlineclinicabsence`
- `onlineclinicabsenceforstudents`
- `onlineclinicabsenceforparents`
- `clinicreservationforparents`
- `clinicreservationforstudents`

핵심 변경:

- `clinic.queueNotice` 신규 op 추가
- 기존 `clinic.queueParentNotice`는 학부모 예약 안내 호환 op로 유지
- `attendance_notify_queue.action_type`을 상황별 5종으로 분리
- worker가 `CLINIC_*` action을 템플릿별 문구/템플릿 코드로 라우팅
- UI는 알림 유형 선택 + 알림 예약 버튼 1개로 유지해 버튼 난립을 방지
- verify에서 클리닉 알림톡 5종 action/template code를 검사


## Latest clinic notification decision

Student phone is part of CentralDB (`student_phone`) and must be treated as an established field. Student clinic notices should use this synced column automatically. Offline clinic creation now queues immediate reservation notices, 08:00 same-day reminders, and parent absence follow-up notices.

## 2026-06-13 Clinic workflow correction

초기 클리닉 정의를 복구했다. CLASS_CLINIC은 반 전체 당일 할 일, INDIVIDUAL_CLINIC은 당일 특정 학생 할 일, EXTRA_CLINIC은 별도 일정 클리닉이다. CLASS_CLINIC 생성 시 class_students 명단을 읽어 학생별 clinic_tasks row를 생성한다. EXTRA_CLINIC만 자동 예약/리마인드/미등원 알림을 사용한다.

## Handover note: 2차 완성본 v2

- 클리닉 업무판은 조교의 당일 처리 화면이다.
- 선생님이 만든 수업 클리닉은 반 학생별 task로 생성되고, 업무판에서는 묶음으로 진행률을 본다.
- 일괄 완료는 열린 task만 변경한다.
- 배포 전 SQL Editor에서 `docs/supabase-clinic-performance-v2.sql`을 실행하면 운영 조회가 더 안정적이다.

## 최종 운영 체크 v1

2차 완성본에는 `admin.finalReadiness`와 관리자 포털 `설정 → 최종 운영 체크`가 포함됩니다.
이 기능은 DB 스키마, 연락처 동기화율, 환경변수, 클리닉 알림 queue, 단어시험, 리포트, 감사 로그 준비 상태를 한 번에 점검합니다.
배포 후에는 `npm run smoke-test`와 함께 최종 운영 체크를 실행한 뒤 메뉴별 디테일 패치로 넘어갑니다.

## 2026-06 클래스 조회/속도 개선 v1

- 클래스 메뉴의 날짜 입력은 더 이상 로그인 시 오늘 날짜로 자동 고정하지 않는다. 비워두면 전체 클래스 목록을 보여준다.
- 특정 날짜 수업 일정이 없을 때도 빈 화면이 아니라 전체 클래스 목록으로 대체 표시한다.
- 초기 로그인 후 운영 요약 조회는 화면 표시를 막지 않는 비동기 방식으로 변경했다.
- 세션 인증/클래스 목록/운영 요약에 짧은 TTL 캐시를 적용했다.
- 추가 성능 인덱스는 `docs/supabase-class-speed-v1.sql`을 Supabase SQL Editor에서 실행한다.

## 2026-06-18 CentralDB Web App 기능 포털 이관 v3

중앙DB 웹앱에 남아 있던 반별 휴강, 실제 일정 수동 수정, 학원 전체 휴무, 직원 계정 관리, 시스템 설정, self-check 기능을 운영 포털로 이관했다. 포털은 Supabase를 직접 원본으로 쓰지 않고 GAS bridge를 통해 Google Sheets 중앙DB를 수정한다.

운영 순서:
1. 중앙DB GAS patch 적용 후 Apps Script Web App 새 버전 배포
2. 운영 포털 patch 적용 후 Vercel 배포
3. `npm run smoke-test`로 `admin.central.props.get`, `admin.central.staff.list` 확인
4. 포털의 클래스/직원/설정 메뉴에서 실제 조회·저장 테스트

속도 개선은 클라이언트 요청 병합/짧은 캐시, 서버 read-cache, 쓰기 후 캐시 무효화를 조합했다. Google Sheets가 원본인 구조에서는 저장 작업이 네트워크 왕복을 거치므로, 조회는 실시간처럼 빠르게 만들고 저장은 진행/완료 피드백을 명확히 주는 방향으로 운영한다.


## UI/UX Refresh v1

2026-06-18 기준 운영 포털은 class_id 직접 입력 중심에서 클래스 목록 선택 중심으로 전환되었다. 상단 작업 컨텍스트 바, 메뉴별 클래스 select, 담당 직원 select, 학생 검색→수강생 추가 연결이 추가되었다.


## UI/UX Refresh v2

운영 포털은 딸깍 업무 보드, 우측 상세 작업 패널, safe optimistic 저장 상태, 현장/태블릿 모드, 카드형 리포트 미리보기를 포함한다. 다음 단계는 실제 현장 리허설에서 메뉴별 동선과 권한별 노출을 더 다듬는 것이다.

## 실시간 미등원 보드

- 오늘 화면에는 `assistant.todayAbsenceBoard` 기반의 실시간 미등원 보드가 있다.
- 모든 직원이 오늘 예정 수업 중 수업 시간이 지났는데 아직 등원하지 않은 학생을 확인할 수 있다.
- 자동 갱신은 15초 주기이며, 서버 캐시는 8초라 화면이 빠르게 반응하면서도 과도한 DB 조회를 피한다.
- 미등원 예외가 필요한 경우 보드의 `예외` 버튼으로 출결 메뉴의 예외 입력칸을 바로 채운다.

## phone-tail-attendance-v1

학생과 직원 출결 키오스크의 기본 입력 방식은 `010`을 화면에 고정 표시하고 사용자가 뒤 8자리만 입력하는 방식이다. 학생은 `students.student_phone`, 직원은 `staff` 또는 `staff_snapshot`의 phone-like 컬럼을 기준으로 매칭한다. QR은 보조수단으로 유지한다. 2차 직원 확인 기능은 이번 버전에서 제외한다.


## year-round-product-strategy-v1

더오름 운영 OS는 시험기간 전용 도구가 아니다. 시험기간은 사용 강도가 높은 대표 상황일 뿐이며, 제품 정체성은 **상시 학원 운영 누락 방지 OS**다.

현재 제품 방향:

- 상시 운영: 출결, 미등원, 단어, 클리닉, 알림, 리포트, 직원 업무 책임성
- 고강도 운영: 시험기간 재시험/클리닉/리포트 집중 관리
- 외부 공개: 학생 링크 포털, 학부모 링크 포털
- 학습 연결: 온라인강의 링크/과제/시청 관리
- 제외/후순위: 결제 처리, 청구, 자동이체, PG, 현금영수증

더클래스가 결제/기본 관리 역할을 담당하므로 더오름 운영 OS는 결제를 중복 개발하지 않는다. 대신 더클래스가 약한 학습 운영, 개입 기록, 누락 방지, 리포트 근거, 학생/학부모 학습 포털에 집중한다.

관련 문서:

- `docs/YEAR_ROUND_PRODUCT_STRATEGY_V1.md`
- `docs/PARENT_STUDENT_LINK_PORTAL_V1.md`
- `docs/ONLINE_LECTURE_LINKAGE_V1.md`
- `docs/PAYMENT_SCOPE_DECISION_V1.md`
- `docs/DIRECTOR_EXPLANATION_BRIEF_V1.md`
