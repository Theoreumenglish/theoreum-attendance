# 더오름 운영 포털 API Operations

이 문서는 `api/rpc.js`에서 사용하는 RPC `op` 이름, 권한, 운영 의미를 정리한다. 목적은 기능 추가 시 같은 흐름을 재사용하고, 포트폴리오에서는 시스템 아키텍처와 role-based access control을 설명할 수 있게 하는 것이다.

## 1. 원칙

- `op`는 기능 단위의 공개 계약이다.
- CentralDB GAS + Google Sheets는 SSOT, Supabase는 빠른 운영 runtime/replica다.
- 학생 식별자는 항상 4자리 문자열 `student_id`로 유지한다.
- 출결 로그는 append-only 원칙을 유지한다.
- 문자 템플릿 문구는 NCP 템플릿과 일치해야 하며 임의 변경하지 않는다.
- 주요 write action은 향후 `portal_audit_logs` 또는 동일 목적의 감사 로그에 actor, role, target, before/after, reason을 남긴다.

## 2. 현재 사용 중인 RPC op

| op | 영역 | 현재 목적 | 권한 메모 | 감사 로그 필요 |
| --- | --- | --- | --- | --- |
| `meta.ping` | meta | runtime metadata 확인 | 공개/내부 점검 | 아니오 |
| `auth.login` | auth | 직원 로그인 | 직원 계정 | 예: 로그인 실패/잠금은 보안 로그 |
| `auth.me` | auth | 현재 세션 확인 | 로그인 세션 | 아니오 |
| `auth.logout` | auth | 로그아웃 | 로그인 세션 | 선택 |
| `kiosk.mark` | kiosk | 학생 학번/QR 출결 처리 | 키오스크 | 이미 출결 로그 |
| `kiosk.approvePin` | legacy | 과거 학번 출결 PIN 승인 | legacy | 현재 정책상 사용하지 않음 |
| `staff.clock` | staff | 직원 직접 출퇴근 처리 | 직원/관리 | 예 |
| `staff.clock.qr` | staff | 직원 QR 출퇴근 처리 | 직원 QR | 예 |
| `assistant.searchStudents` | student | 학생 검색 | 관리자/강사/조교 | 조회 감사는 필요 시 |
| `assistant.listClassOptions` | class | 클래스 옵션 조회 | 관리자/강사/조교 | 아니오 |
| `assistant.listClassRoster` | class | 클래스 학생 명단 조회 | 관리자/강사/조교 | 아니오 |
| `assistant.getLogs` | attendance | 출결 로그 조회 | 관리자/강사/조교 | 아니오 |
| `assistant.getLogByTrace` | attendance | trace_id 기준 출결 로그 조회 | 관리자/강사/조교 | 아니오 |
| `assistant.manualAttendance` | attendance | 출결 수동 정정 | 관리자/강사/조교 | 필수 |
| `assistant.listAbsenceExcuses` | absence | 미등원 문자 제외 조회 | 관리자/강사/조교 | 아니오 |

| `assistant.todayAbsenceBoard` | attendance | 오늘 수업 시간이 지난 반에서 아직 등원하지 않은 학생을 실시간 보드로 조회 | 관리자/강사/조교 | 아니오 |
| `assistant.addAbsenceExcuse` | absence | 미등원 문자 제외 추가 | 관리자/강사/조교 | 필수 |
| `assistant.bulkAddAbsenceExcuses` | absence | 미등원 문자 제외 일괄 추가 | 관리자/강사/조교 | 필수 |
| `assistant.removeAbsenceExcuse` | absence | 미등원 문자 제외 제거 | 관리자/강사/조교 | 필수 |
| `admin.getOpsOverview` | operations | 운영 요약 조회 | 관리자 중심 | 아니오 |
| `admin.listNotifyQueue` | notification | 실패 알림 큐 조회 | 관리자 중심 | 아니오 |
| `admin.retryNotifyQueue` | notification | 실패 알림 재시도 | 관리자 중심 | 필수 |
| `admin.previewNotifyPayload` | notification | 문자 payload 미리보기 | 관리자 중심 | 선택 |
| `admin.listAbsenceRuns` | absence | 미등원 감지 실행 기록 조회 | 관리자 중심 | 아니오 |
| `admin.listNotifyWorkerRuns` | notification | 알림 worker 실행 기록 조회 | 관리자 중심 | 아니오 |
| `admin.scanTodayStateMismatch` | integrity | 오늘 상태 불일치 점검 | 관리자 중심 | 아니오 |
| `admin.rebuildTodayState` | integrity | 오늘 상태 재계산 | 관리자 중심 | 필수 |
| `admin.cleanupQrExpired` | qr | 만료 QR 세션 정리 | 관리자 중심 | 선택 |
| `admin.flushCache` | runtime | 운영 캐시 비우기 | 관리자 + PIN | 필수 |
| `admin.runCentralReplicaSync` | sync | 중앙DB → Supabase replica 최신화 | 관리자 + PIN | 필수 |
| `admin.getRuntimeConfig` | config | runtime 설정 조회 | 관리자 | 아니오 |
| `admin.setKioskFloor` | config | kiosk 층 설정 | 관리자 | 필수 |
| `admin.toggleSafe` | config | safe mode toggle | 관리자 | 필수 |
| `admin.setSafeMode` | config | safe mode 지정 | 관리자 | 필수 |
| `admin.setStudentException` | student | QR 어려운 학생 표시/해제. 학번 출결은 기본 허용 | 관리자/정책상 강사·조교 검토 | 필수 |
| `teacher.setException` | student | QR 예외 alias | 정책 동기화 필요 | 필수 |
| `admin.getStaffMonthlySummary` | staff | 월간 직원 근무 요약 | 관리자 | 아니오 |
| `admin.getStaffDailyDetail` | staff | 직원 일별 근무 상세 | 관리자 | 아니오 |
| `meta.diag` | meta | runtime 진단 | 관리자 | 아니오 |
| `meta.checkCentral` | meta | 중앙DB/replica 점검 | 관리자 | 아니오 |
| `meta.logoError` | meta | 로고 오류 기록 | 공개/내부 | 아니오 |
| `admin.testNcp` | notification | NCP 문자 테스트 | 관리자 | 필수 |
| `absent.runNow` | absence | 미등원 감지 수동 실행 | 관리자 중심 | 필수 |

## 3. 예정 op

| 예정 op | 목적 | 비고 |
| --- | --- | --- |
| `student.getProfile` | Student 360 Profile 조회 | 출결, 클리닉, 단어시험, 메모 요약 |
| `clinic.listTemplates` | 클리닉 항목 템플릿 조회 | 공통 + 선생님 개인 항목 |
| `clinic.createTemplate` | 클리닉 항목 추가 | 관리자/강사/조교 가능, audit 필수 |
| `clinic.createTask` | 학생 클리닉 생성 | 후보/확정 분리 |
| `clinic.updateTaskStatus` | 완료/부분완료/반려 처리 | 내부/학부모 공유 메모 분리 |
| `wordTest.createSession` | 단어시험 회차 생성 | 범위, 통과개수 |
| `wordTest.enterResult` | 학생별 맞은개수 입력 | 불통과 시 후보 생성 |
| `report.createDailyLink` | 일간 리포트 링크 생성 | 만료 링크 |
| `report.createWeeklyLink` | 주간 리포트 링크 생성 | 학부모 공유 전용 |
| `audit.searchLogs` | 감사 로그 조회 | 관리자 중심 |
| `parent.authStart` | 학부모 인증 시작 | 문자 인증/로그인 확장 |
| `parent.getReport` | 자녀 리포트 조회 | linked_student_ids 제한 |

## 4. 권한 정책 기준

| role | 의미 | 원칙 |
| --- | --- | --- |
| `admin` | 원장/관리자 | 전체 가능 |
| `teacher` | 강사 | 시스템 설정, 권한, 직원 근무시간/급여성 정보 제외하고 학생 운영 대부분 가능 |
| `assistant` | 조교 | 현장 운영 가능. 학부모 연락처 전체 번호는 숨기고 뒤 4자리만 표시 |
| `parent` | 학부모/보호자 | 자녀에게 공개된 정보만 조회 |

## 5. 다음 정리 작업

1. 실제 구현 권한과 위 정책이 다른 op를 표시한다.
2. `admin.setStudentException`/`teacher.setException`의 정책명을 정리한다.
3. write action에 `actor_id`, `actor_role`, `reason` 전달을 표준화한다.
4. `portal_audit_logs` 도입 후 모든 주요 write op에 audit hook을 추가한다.

## 2026-06-12 Batch Portal v1 추가 op

| op | 권한 | 목적 | 비고 |
| --- | --- | --- | --- |
| `assistant.getStudentProfile` | assistant 이상 | 학생 기본 정보, 오늘 상태, 최근 출결, 소속 클래스, 최근 결석예외를 한 번에 조회 | Student 360 Profile v1 화면에서 사용 |
| `admin.getStaffMonthlySummary` | admin 이상 | 직원 월간 근무 요약 조회 | 직원 화면에서 사용 |
| `admin.getStaffDailyDetail` | admin 이상 | 특정 직원의 월간 일별 근무 상세 조회 | 직원 화면에서 사용 |
| `admin.listNotifyQueue` | admin 이상 | 문자 queue 상태별 조회 | 문자·알림 화면에서 사용 |
| `admin.retryNotifyQueue` | admin 이상 + PIN | FAILED/PROCESSING queue 재처리 | 문자·알림 화면에서 사용 |

## 2026-06-12 Clinic / Word / Audit Schema v1 추가 op

| op | 권한 | 목적 | 비고 |
| --- | --- | --- | --- |
| `clinic.listTasks` | assistant 이상 | 상태/학생/반 기준 클리닉 task 조회 | 클리닉 화면 및 Student 360 검수에 사용 |
| `clinic.createTask` | assistant 이상 | 선택 학생에게 클리닉 task 생성 | 내부 메모와 학부모 공개 메모 분리 |
| `clinic.updateTaskStatus` | assistant 이상 | 클리닉 상태 변경 | CANDIDATE/PENDING/IN_PROGRESS/DONE/PARTIAL/REJECTED/CANCELLED |
| `wordTest.listSessions` | assistant 이상 | 단어시험 회차 조회 | 날짜/반 필터 지원 |
| `wordTest.createSession` | assistant 이상 | 단어시험 회차 생성 | 범위, 통과개수, 전체개수 저장 |
| `wordTest.enterResult` | assistant 이상 | 학생별 단어시험 결과 저장 | 불통과 시 `clinic_tasks`에 WORD_FAIL 후보 자동 생성 |
| `audit.searchLogs` | admin 이상 | 운영 감사 로그 조회 | `portal_audit_logs` 기반 |

이번 단계는 Supabase runtime-first 패치다. 중앙DB GAS/Google Sheets SSOT 확장은 실제 운영 흐름을 검증한 뒤 별도 bridge/replica 패치로 진행한다.

## First Complete Portal v1 추가 op

| op | 권한 | 설명 |
|---|---:|---|
| `wordTest.bulkEntry` | assistant+ | 회차와 반 ID 기준 수강생 명단 및 기존 단어시험 결과 조회 |
| `wordTest.bulkEnterResults` | assistant+ | 단어시험 결과 일괄 저장. 불통과 시 클리닉 후보 자동 생성 |
| `report.previewStudentReport` | assistant+ | 학생별 기간 리포트 미리보기 생성 |
| `report.createSnapshot` | assistant+ | 리포트 미리보기 내용을 `report_snapshots`에 저장 |
| `audit.searchLogs` | admin+ | 감사 로그 조회. op, target_type, actor_staff_id 필터 지원 |

주의: report 링크 발송과 학부모 로그인은 아직 포함하지 않는다.

## Added in first-complete-portal-v2

### `wordTest.listResults`

Lists saved word-test results for a session, student, or result status. Used by the admin portal after individual or bulk score entry to verify what was actually saved.

### `report.listSnapshots`

Lists saved `report_snapshots`, optionally filtered by selected student and period type. Used by the report screen to review previously generated parent-report snapshots.

### Auto-resolution behavior

When an existing `word_test_results` row has a linked `clinic_task_id` from a `WORD_FAIL` source and the result is updated to `PASS` or `EXEMPT`, the linked open clinic task is automatically marked `DONE`. The action is recorded in both `clinic_logs` and `portal_audit_logs`.

## 2026-06-13 추가/보강 op

### `clinic.queueParentNotice`

선택한 클리닉 task를 기준으로 학부모 문자 queue를 생성한다.

입력:

```json
{"clinic_task_id":"..."}
```

동작:

- `clinic_tasks`에서 클리닉 조회
- `students.parent_phone` 확인
- `attendance_notify_queue`에 `action_type = CLINIC_NOTICE`로 PENDING queue 생성
- 중복 기준은 `trace_id = clinic_task_id` + `action_type = CLINIC_NOTICE`
- `portal_audit_logs`에 `clinic.queueParentNotice` 기록

### `wordTest.listSessions` 기간 필터

다음 입력을 지원한다.

```json
{"start_ymd":"20260601", "end_ymd":"20260613", "class_id":"C001"}
```

`yyyymmdd`가 없고 `start_ymd` 또는 `end_ymd`가 있으면 기간 조회를 수행한다.


## Complete Ops v4: 클리닉 알림톡 5종 라우팅

### `clinic.queueNotice`

클리닉 task를 기준으로 상황별 알림톡/SMS queue를 예약한다. 기존 `clinic.queueParentNotice`는 호환용으로 남기고, 신규 화면은 `clinic.queueNotice`를 사용한다.

요청 인자:

```json
{
  "clinic_task_id": "...",
  "notice_type": "CLINIC_RESERVATION_PARENT",
  "clinic_time_hhmm": "19:00",
  "target_phone": "01012345678"
}
```

`notice_type` 허용값:

| 값 | 템플릿 코드 | 용도 | 대상 |
|---|---|---|---|
| `CLINIC_RESERVATION_PARENT` | `clinicreservationforparents` | 클리닉 예약/일정 안내 | 학부모 |
| `CLINIC_RESERVATION_STUDENT` | `clinicreservationforstudents` | 클리닉 예약/일정 안내 | 학생 |
| `CLINIC_MISSING_PARENT` | `onlineclinicabsenceforparents` | 온라인 클리닉 미제출 안내 | 학부모 |
| `CLINIC_MISSING_STUDENT` | `onlineclinicabsenceforstudents` | 온라인 클리닉 미제출 안내 | 학생 |
| `CLINIC_ABSENCE_PARENT` | `offlineclinicabsence` | 오프라인 클리닉 미등원/결석 안내 | 학부모 |

학생용 알림은 학생 휴대폰 번호가 기본 테이블에 확정되어 있지 않으므로 `target_phone`을 직접 받아 queue의 수신번호로 사용한다. 학부모용 알림은 `students.parent_phone`을 기본값으로 사용하되, 필요하면 `target_phone`으로 재지정할 수 있다.

중복 방지 기준은 `attendance_notify_queue(trace_id = clinic_task_id, action_type = notice_type)`이다.


## Clinic auto notifications v1

- `clinic.createTask` supports offline clinic automatic notifications.
- New/updated args: `clinic_mode` (`OFFLINE`/`ONLINE`), `due_time` (`HH:mm`), `due_at`, `auto_notice_enabled`.
- Manual OFFLINE clinic creation with `auto_notice_enabled=true` automatically queues:
  - `CLINIC_RESERVATION_PARENT` immediately using `clinicreservationforparents`
  - `CLINIC_RESERVATION_STUDENT` immediately using `clinicreservationforstudents` and `students.student_phone`
  - `CLINIC_REMINDER_PARENT` at the clinic date 08:00 using `clinicreservationforparents`
  - `CLINIC_REMINDER_STUDENT` at the clinic date 08:00 using `clinicreservationforstudents` and `students.student_phone`
  - `CLINIC_ABSENCE_PARENT` after the scheduled clinic time when the clinic is still not handled, using `offlineclinicabsence`
- `clinic.queueNotice` remains available for manual reservation/missing/absence queueing.
- Apply `docs/supabase-clinic-auto-notify-v1.sql` before deploying this feature.

### Clinic semantics v2

- `clinic.createTask`
  - `task_type=CLASS_CLINIC` + `class_id`: class_students 전체 학생에게 clinic_tasks를 bulk 생성한다. `auto_notice_enabled`는 강제로 false이며 `clinic_mode=ONLINE`으로 저장한다.
  - `task_type=INDIVIDUAL_CLINIC` + `student_id`: 특정 학생 당일 클리닉을 생성한다. 기본 자동 알림은 꺼져 있다.
  - `task_type=EXTRA_CLINIC` + `student_id`: 별도 일정 클리닉을 생성한다. OFFLINE + 자동 알림이면 예약/리마인드/미등원 queue를 생성한다.
- `clinic.listTasks` supports `class_id`, `student_id`, `task_type`, `due_date|due_ymd`, and `open_only`.

## Clinic v2 board ops

### clinic.todayBoard
- 권한: assistant 이상
- 목적: 지정일의 열린 클리닉을 업무판 형태로 묶어 조회한다.
- args: `yyyymmdd`, `open_only`, `limit`
- 반환: `summary`, `groups`, `items`

### clinic.bulkUpdateStatus
- 권한: assistant 이상
- 목적: 수업 클리닉 묶음 또는 지정 task 목록을 일괄 상태 변경한다.
- args: `source_id` 또는 `clinic_task_ids`, `status`, `class_id`, `task_type`, `due_date`, `title`, `open_only`
- 감사 로그: `clinic.bulkUpdateStatus`

## 최종 운영 체크 v1

2차 완성본에는 `admin.finalReadiness`와 관리자 포털 `설정 → 최종 운영 체크`가 포함됩니다.
이 기능은 DB 스키마, 연락처 동기화율, 환경변수, 클리닉 알림 queue, 단어시험, 리포트, 감사 로그 준비 상태를 한 번에 점검합니다.
배포 후에는 `npm run smoke-test`와 함께 최종 운영 체크를 실행한 뒤 메뉴별 디테일 패치로 넘어갑니다.

## 클래스 조회/속도 개선 v1

- `assistant.listClassOptions`는 날짜 미입력 시 전체 `classes` 목록을 조회한다.
- 날짜 입력값은 `YYYYMMDD`, `YYYY-MM-DD`를 모두 허용한다.
- 날짜에 해당하는 `class_schedule`이 비어 있거나 조회 실패하면, 운영자가 빈 화면을 보지 않도록 전체 `classes` 목록으로 fallback한다.
- 클래스 조회 결과는 짧은 TTL 캐시를 사용한다. 기본값은 `RPC_CACHE_CLASS_OPTIONS_SEC=45`초다.
- 운영 요약은 짧은 TTL 캐시를 사용한다. 기본값은 `RPC_CACHE_OPS_OVERVIEW_SEC=20`초다.
- 보호 API 인증은 `AUTH_SESSION_CACHE_SEC=25`초 기본 메모리 캐시를 사용해 반복적인 세션/직원 조회와 `last_seen_at` 쓰기를 줄인다.

권장 SQL:

- `docs/supabase-class-speed-v1.sql`

## CentralDB 웹앱 잔여 관리 API v3

운영 포털에서 중앙DB Web App의 잔여 관리 기능을 호출하기 위한 bridge API를 추가했다. 중앙DB Google Sheets는 계속 원본 DB이며, 포털은 `CENTRAL_GAS_WEBAPP_URL`과 `CENTRAL_BRIDGE_SECRET`으로 GAS bridge를 호출한다.

- `admin.central.classHolidays.list/add/remove`: 반별 휴강 조회/추가/삭제
- `admin.central.schedule.list/update/rebuild`: 실제 수업일정 조회/수동 수정/재생성
- `admin.central.globalHolidays.list/add/remove`: 학원 전체 휴무 조회/추가/삭제
- `admin.central.staff.list/upsert/toggle/resetSecret`: 직원 계정 조회/저장/활성 토글/비밀번호·PIN 재설정
- `admin.central.props.get/set`: 중앙DB 시스템 설정 조회/저장
- `admin.central.selfCheck`: 중앙DB 정합성 점검 실행

읽기 계열은 짧은 서버 캐시를 사용하고, 쓰기 계열은 관련 캐시를 무효화한다. 쓰기 후 필요한 경우 중앙DB Web App 새 버전 배포와 Supabase replica 최신화를 함께 확인한다.

## v4 속도/안정성 보강

- `admin.central.staff.list`: 기본은 Supabase replica fast path를 사용하고, `force=true` 또는 `source=central`일 때 중앙DB GAS 원본을 확인한다.
- `admin.central.props.get`: `runtime_config.central_props_snapshot` snapshot을 우선 사용하고, `force=true`일 때 중앙DB GAS 원본을 확인한다.
- `assistant.listAbsenceExcuses` / `assistant.addAbsenceExcuse` / `assistant.bulkAddAbsenceExcuses` / `assistant.removeAbsenceExcuse`: 출결 메뉴의 미등원 문자 제외 관리에서 사용한다.

### assistant.todayAbsenceBoard

- 모든 직원이 오늘 수업 시간이 지난 반에서 아직 등원하지 않은 학생을 확인하는 읽기 전용 API다.
- 기준 데이터는 `class_schedule`이며, 실제 출석 여부는 `today_student_state`를 우선 사용한다.
- `absence_excuses`에 등록된 학생은 미등원 수에서 제외한다.
- 이미 발송된 미등원 문자 단계는 `attendance_notify_queue`의 `ABSENT_5`, `ABSENT_20` trace로 표시한다.

## wordCatalog.list

- 목적: 단어책/범위 catalog를 조회한다.
- 권한: assistant 이상.
- 관련 테이블: `word_books`, `word_book_ranges`.
- 개인정보 포함: 없음.
- fallback: 테이블이 아직 없으면 빈 seed fallback을 반환한다.
- 운영 원칙: 단어 원문과 뜻은 저장하지 않고 단어책/범위/word_count만 사용한다.
- smoke test: 포함.


## wordRecord.list

학생별 단어 누적 기록을 조회한다. `student-word-records-v1`에서 추가된 API다.

### 권한

`assistant` 이상.

### 요청 예시

```json
{
  "op": "wordRecord.list",
  "args": {
    "sessionToken": "...",
    "student_id": "0001",
    "start_ymd": "20260601",
    "end_ymd": "20260630",
    "limit": 100
  }
}
```

### 응답 요약

- `count`
- `pass_count`
- `fail_count`
- `retest_count`
- `clinic_candidate_count`
- `items[]`

### 운영 메모

기존 `wordTest.enterResult` / `wordTest.bulkEnterResults`는 계속 `word_test_results`에 저장한다. 동시에 `word_records` 테이블이 있으면 학생별 누적 기록을 mirror 저장한다. `word_records` 테이블이 아직 없으면 기존 저장은 실패하지 않고 `word_record_warning`만 반환한다.


## student-id-attendance-v1

- 등원/하원 `kiosk.mark`는 모든 재원생에게 학번 4자리 입력을 허용한다.
- QR은 계속 지원하지만 필수 출첵 수단이 아니다.
- `students.is_exception`은 더 이상 학번 출결 허용 조건이 아니라, QR이 특히 어려운 학생을 표시하는 운영 메모로만 사용한다.
- 학번 입력 출결은 `attendance_logs.meta_json.input_mode = STUDENT_ID`와 `student_id_attendance = Y`로 남긴다.
- 교실 이동/외출·복귀는 기존처럼 학번 4자리 입력을 사용한다.


## staff.clock PIN mode

`staff.clock` supports two modes.

1. Existing session mode: `sessionToken + action`
2. Kiosk PIN mode: `staff_id + pin + action`

Kiosk PIN example:

```json
{
  "op": "staff.clock",
  "args": {
    "action": "IN",
    "staff_id": "staff_id",
    "pin": "PIN",
    "input_mode": "PIN",
    "note": "KIOSK_PIN"
  }
}
```

This is used by the physical keyboard kiosk after the `staff` command. Staff QR remains available as a fallback through `staff.clock.qr`.

## phone-tail-attendance-v1

학생과 직원 출결 키오스크의 기본 입력 방식은 `010`을 화면에 고정 표시하고 사용자가 뒤 8자리만 입력하는 방식이다. 학생은 `students.student_phone`, 직원은 `staff` 또는 `staff_snapshot`의 phone-like 컬럼을 기준으로 매칭한다. QR은 보조수단으로 유지한다. 2차 직원 확인 기능은 이번 버전에서 제외한다.



## admin.staffClock.listLogs / admin.staffClock.saveManual

직원 근태 수기 보정용 관리자 API입니다.

- `admin.staffClock.listLogs`: 특정 직원/일자의 원본 출퇴근 로그를 조회합니다.
- `admin.staffClock.saveManual`: 원장/관리자가 출근/퇴근 로그를 수기로 추가하거나 `trace_id` 기준으로 수정합니다.
- 저장 후 `staff_daily`, `staff_monthly` rollup을 재계산합니다.
- 삭제는 v1에서 제공하지 않습니다. 오입력은 수정으로 처리합니다.

## Product scope note: parent/student portal and online lecture linkage

이 문서는 현재 API 운영 기준을 다룬다. 제품 방향상 학부모/학생 포털과 온라인강의 연결은 중요하지만, v1에서는 무거운 앱이나 자체 동영상 플랫폼보다 링크 포털과 공개 범위 분리부터 시작한다.

향후 API 후보:

- `studentPortal.today`
- `parentPortal.summary`
- `portalLink.issue`
- `portalLink.revoke`
- `lectureAssignment.list`
- `lectureAssignment.complete`

이 API들은 내부 운영 데이터 중 공개 가능한 범위만 노출해야 하며, 내부 메모와 staff-only 데이터는 절대 공개하지 않는다.


## phone-identity-quality-v1

- `admin.phoneIdentity.audit`: 휴대폰 뒤 8자리 출결 준비도를 읽기 전용으로 점검한다.
- 권한: admin 이상.
- DB 변경 없음.
- 학생은 `students.student_phone`, 직원은 `staff` / `staff_snapshot` 전화번호 계열 컬럼을 기준으로 한다.

## student-today-link-v1 API

- `admin.studentTodayLink.create`: logged-in staff creates a short-lived student mobile link from Student 360.
- `studentToday.publicGet`: public token-based read-only endpoint for `/student-today.html`.

Security notes:
- Raw token is never stored in Supabase.
- `student_today_links.token_hash` stores SHA-256 hash only.
- Public response must not include phone numbers, parent phones, internal notes, or audit logs.
- Apply `docs/supabase-student-today-link-v1.sql` before creating links.

## online-lecture-assignment-v1

- `admin.lectureAssignment.list`: logged-in staff lists online lecture link assignments for a selected student. Read-only and safe for smoke checks with a dummy student id.
- `admin.lectureAssignment.save`: logged-in staff creates or updates an online lecture link assignment for a selected student. URLs must be `http` or `https`.
- `studentToday.publicGet`: includes visible, non-archived online lecture assignments in the public student today link.

DB: `student_lecture_assignments` from `docs/supabase-online-lecture-assignment-v1.sql`.

## SQL-backed API deployment rule

When a new API depends on a new Supabase table or column, the patch must include `docs/supabase-*.sql` and must pass through the DB migration gate before live smoke-test.


## staff-phone-management-v1 / production-qa-runner-v1

- 중앙DB 직원 관리 화면에서 휴대폰 번호를 입력할 수 있는지 확인한다.
- Supabase `staff`/`staff_snapshot` mirror에 `staff_phone` 컬럼이 있는지 확인한다.
- `npm run prod:qa`로 preview/production 로그인과 주요 API를 실제 URL 기준으로 점검한다.


## meta.supportedOps

`meta.supportedOps`는 현재 배포본이 지원해야 하는 핵심 op 목록과 정적 페이지 목록을 반환한다. production QA에서 오래된 Vercel preview URL을 잡는 기준으로 사용한다.
