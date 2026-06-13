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
| `kiosk.mark` | kiosk | 학생 QR/학번 출결 처리 | 키오스크 | 이미 출결 로그 |
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
| `admin.setStudentException` | student | QR 예외 학생 상시 학번 출결 허용/해제 | 관리자/정책상 강사·조교 검토 | 필수 |
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
