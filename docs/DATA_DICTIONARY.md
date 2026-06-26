# 더오름 운영 포털 데이터 사전

이 문서는 CentralDB GAS + Google Sheets SSOT와 Supabase runtime/replica에서 사용하는 핵심 데이터의 의미를 정리한다. 학생/직원/학부모/클리닉/리포트 기능을 확장할 때 같은 용어를 사용하기 위한 기준이다.

## 1. 핵심 원칙

- `student_id`는 숫자가 아니라 4자리 문자열이다. 예: `0004`.
- CentralDB GAS + Google Sheets가 최종 원본이며, Supabase는 빠른 조회/운영용 replica다.
- 출결 로그와 감사 로그는 append-only에 가깝게 설계한다.
- 내부 메모와 학부모 공유 메모는 반드시 분리한다.
- 학부모/보호자는 자녀에게 공개된 정보만 볼 수 있다.

## 2. 학생/직원 기본 테이블

| 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `students.student_id` | 4자리 내부 학생 식별자 | string 유지. QR/출결/리포트 연결 키 |
| `students.student_name` | 학생 이름 | 직원 포털 표시용 |
| `students.school` | 학교 | 학생 상세/리포트 표시 |
| `students.grade` | 학년 | 학생 상세/리포트 표시 |
| `students.status` | 학생 상태 | `재원`/active 학생만 출결 대상 |
| `students.qr_id` | 학생 QR 식별자 | QR1/QR2/Q3 호환 유지 |
| `students.is_exception` | QR 어려운 학생 표시 | 학번 출결은 기본 허용. `Y`이면 QR 인식 어려움/운영 메모 대상 |
| `students.exception_note` | QR 예외 사유 | 예: 카톡 X, QR 인식 어려움 |
| `staff.staff_id` | 직원 식별자 | 로그인/직원 QR/감사 로그 actor |
| `staff.role` | 직원 역할 | admin, teacher, assistant 등 |
| `staff_snapshot.pin_hash` | 직원 PIN 해시 | 수동 정정 등 민감 작업 검증 |

## 3. 출결 테이블

| 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `attendance_logs.trace_id` | 출결 이벤트 추적 ID | 수동 정정 원본 연결에 사용 |
| `attendance_logs.ts` | 출결 이벤트 시각 | UTC 저장 후 KST 표시 |
| `attendance_logs.yyyymmdd` | KST 기준 날짜 | 일별 조회/집계 키 |
| `attendance_logs.student_id` | 학생 ID | 4자리 문자열 |
| `attendance_logs.action_type` | 출결 액션 | CHECK_IN, CHECK_OUT, OUTING, RETURN 등 |
| `attendance_logs.result` | 처리 결과 | OK 또는 실패 상태 |
| `attendance_logs.deny_reason` | 차단 사유 | 잘못된 학번/상태 오류 등 |
| `attendance_logs.qr_id` | 사용 QR ID | QR 기반 처리 시 |
| `attendance_logs.meta_json` | 부가 정보 | input_mode=STUDENT_ID/QR, student_id_attendance 등 |
| `today_student_state.checked_in` | 오늘 등원 여부 | 빠른 조회용 상태 |
| `today_student_state.checked_out` | 오늘 하원 여부 | 빠른 조회용 상태 |
| `today_student_state.outing_active` | 외출 상태 | 외출/복귀 흐름 |
| `today_student_state.last_action_type` | 마지막 출결 액션 | 현재 상태 표시 |

## 4. 클래스/스케줄/미등원

| 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `classes.class_id` | 클래스 ID | CentralDB와 맞춰 유지 |
| `classes.class_name` | 클래스명 | 화면 표시 |
| `classes.alert_delay` | 미등원 알림 지연 설정 | 예: `5,20` |
| `class_students.class_id` | 클래스 ID | 학생-반 연결 |
| `class_students.student_id` | 학생 ID | 학생-반 연결 |
| `class_schedule.yyyymmdd` | 수업일 | 미등원 감지 기준 |
| `class_schedule.status` | 수업 상태 | 정상/휴강 등 |
| `absence_excuses.student_id` | 미등원 문자 제외 학생 | 지각/결석 연락 등 |
| `attendance_notify_queue.status` | 문자 큐 상태 | PENDING, SENT, FAILED 등 |
| `attendance_notify_queue.trace_id` | 알림 이벤트 추적 ID | 재시도/감사 연결 |

## 5. 직원 근태

| 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `staff_clock_logs.staff_id` | 직원 ID | QR/수동 출퇴근 actor |
| `staff_clock_logs.action_type` | 출근/퇴근 액션 | CLOCK_IN, CLOCK_OUT 등 |
| `staff_clock_logs.source` | 입력 경로 | QR, MANUAL, ADMIN 등 |
| `staff_daily.first_in_ts` | 일별 첫 출근 | nullable 허용 |
| `staff_daily.last_out_ts` | 일별 마지막 퇴근 | nullable 허용 |
| `staff_daily.worked_minutes` | 일별 근무분 | HR reporting 기반 |
| `staff_monthly.worked_minutes` | 월별 근무분 | 관리자만 전체 조회 |

## 6. QR 세션

| 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `student_qr_sessions.token` | 학생 QR 세션 토큰 | 화면 QR 동적 세션 |
| `student_qr_sessions.public_session_id` | 공개 세션 ID | nonce 연결 |
| `student_qr_nonces.nonce` | 일회성 QR nonce | 재사용 방지 |
| `student_qr_nonces.used` | 사용 여부 | true면 재사용 불가 |
| `staff_qr_sessions.token` | 직원 QR 세션 토큰 | 직원 QR 전용 |
| `staff_qr_nonces.nonce` | 직원 QR nonce | 재사용 방지 |

## 7. 예정: 클리닉

| 예정 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `clinic_item_templates.template_id` | 클리닉 항목 ID | 공통/개인 항목 모두 지원 |
| `clinic_item_templates.scope` | 항목 범위 | GLOBAL 또는 STAFF |
| `clinic_item_templates.owner_staff_id` | 개인 항목 소유자 | scope=STAFF일 때 |
| `clinic_tasks.task_id` | 학생에게 배정된 클리닉 ID | 실제 수행 단위 |
| `clinic_tasks.student_id` | 대상 학생 | 4자리 문자열 |
| `clinic_tasks.status` | 상태 | 대기, 진행중, 완료, 부분완료, 반려, 취소 |
| `clinic_tasks.source_type` | 생성 원인 | 수업, 개별, 단어불통과, 미등원 등 |
| `clinic_logs.internal_note` | 내부 메모 | 직원만 조회 |
| `clinic_logs.parent_note` | 학부모 공유 메모 | 공개 가능한 문장만 |
| `clinic_logs.parent_visible` | 학부모 공개 여부 | true일 때만 parent 포털 노출 |

## 8. 예정: 단어시험/성적

| 예정 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `word_test_sessions.session_id` | 단어시험 회차 ID | 범위/날짜/통과개수 |
| `word_test_results.score` | 맞은개수 | DB 컬럼명은 score 유지, 화면/API에서는 correct_count 별칭 사용 |
| `word_test_results.result_status` | 통과 여부 | 맞은개수 >= 통과개수로 자동 판정 |
| `word_test_results.wrong_count` | 틀린 개수 | 리포트/그래프 기반 |
| `word_test_results.clinic_candidate_id` | 클리닉 후보 연결 | 자동 확정이 아니라 후보 생성 |

## 9. 예정: 학부모/리포트

| 예정 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `parent_accounts.parent_id` | 학부모 계정 ID | 최종 로그인 구조 |
| `parent_student_links.parent_id` | 보호자 ID | 자녀 연결 |
| `parent_student_links.student_id` | 자녀 학생 ID | 자녀만 조회 제한 |
| `report_links.token` | 리포트 링크 토큰 | 초기 문자 링크 방식 |
| `report_links.expires_at` | 링크 만료 시각 | 보안 |
| `report_snapshots.summary_json` | 일간/주간 리포트 스냅샷 | 발송 당시 내용 보존 |

## 10. 예정: 감사 로그

| 예정 테이블.컬럼 | 의미 | 메모 |
| --- | --- | --- |
| `portal_audit_logs.log_id` | 감사 로그 ID | append-only |
| `portal_audit_logs.created_at` | 발생 시각 | UTC 저장 |
| `portal_audit_logs.actor_id` | 행동자 직원 ID | 누가 했는지 |
| `portal_audit_logs.actor_role` | 행동자 역할 | admin/teacher/assistant |
| `portal_audit_logs.action_type` | 행동 유형 | MANUAL_ATTENDANCE, SEND_MESSAGE 등 |
| `portal_audit_logs.target_type` | 대상 유형 | student, clinic_task, report 등 |
| `portal_audit_logs.target_id` | 대상 ID | trace_id/task_id 등 |
| `portal_audit_logs.student_id` | 관련 학생 ID | 학생 중심 추적 |
| `portal_audit_logs.before_json` | 변경 전 | 민감정보 최소화 |
| `portal_audit_logs.after_json` | 변경 후 | 민감정보 최소화 |
| `portal_audit_logs.reason` | 사유 | 수동 정정/반려 등 필수 |

## 2026-06-12 확정: Clinic / Word / Audit Schema v1

SQL 파일: `docs/supabase-clinic-word-report-schema-v1.sql`

| 테이블 | 역할 | 핵심 컬럼 |
| --- | --- | --- |
| `clinic_item_templates` | 반복 클리닉 항목 템플릿 | `template_id`, `title`, `task_type`, `default_priority`, `is_active` |
| `clinic_tasks` | 학생별 클리닉 업무 본체 | `clinic_task_id`, `student_id`, `title`, `status`, `priority`, `internal_note`, `parent_note`, `parent_visible` |
| `clinic_logs` | 클리닉 이벤트 기록 | `clinic_log_id`, `clinic_task_id`, `event_type`, `before_status`, `after_status` |
| `word_test_sessions` | 단어시험 회차 | `session_id`, `title`, `yyyymmdd`, `class_id`, `scope_text`, `pass_score`, `max_score` |
| `word_test_results` | 학생별 단어시험 결과 | `result_id`, `session_id`, `student_id`, `score`, `result_status`, `clinic_task_id` |
| `report_snapshots` | 학부모 리포트 스냅샷 | `report_id`, `student_id`, `period_type`, `summary_json`, `parent_note` |
| `report_links` | 리포트 공유 링크 | `report_link_id`, `report_id`, `token_hash`, `expires_at`, `revoked_at` |
| `portal_audit_logs` | 운영 감사 로그 | `audit_id`, `actor_staff_id`, `op`, `target_type`, `target_id`, `before_json`, `after_json` |

메모 분리 원칙:

- `internal_note`: 직원/운영자만 보는 조치 기록.
- `parent_note`: 학부모에게 보여줄 수 있는 문장.
- `parent_visible`: true인 경우에만 향후 parent/report 화면에 포함.

## First Complete Portal v1 운영 테이블 사용 상태

- `word_test_sessions`: 단어시험 회차 저장 및 일괄 입력 기준 회차로 사용.
- `word_test_results`: 개별/일괄 맞은개수 입력 결과 저장. `(session_id, student_id)` unique upsert.
- `clinic_tasks`: 수동 클리닉 및 단어시험 불통과 자동 후보 저장.
- `report_snapshots`: 학생별 기간 리포트 미리보기 결과를 JSON snapshot으로 저장.
- `portal_audit_logs`: 클리닉, 단어시험, 리포트 주요 작업 감사 로그 저장.

아직 미구현: `report_links` 기반 학부모 공유 링크, CentralDB GAS sync 확장.

## first-complete-portal-v2 behavior notes

- `word_test_results.clinic_task_id`: links a failed word-test result to the auto-created WORD_FAIL clinic task.
- If a linked failed result is later changed to PASS or EXEMPT, the corresponding WORD_FAIL clinic task is automatically completed with `status = DONE`.
- `report_snapshots.summary_json`: stores the exact report preview summary used at the time of snapshot creation.

## 2026-06-13 queue 확장

`attendance_notify_queue.action_type`에 `CLINIC_NOTICE`를 추가로 사용한다.

- `trace_id`: clinic_task_id
- `student_id`: 대상 학생 ID
- `parent_phone`: students.parent_phone
- `status`: PENDING / PROCESSING / DONE / FAILED

`CLINIC_NOTICE`는 별도 신규 테이블 없이 기존 queue/worker 구조를 사용한다.


## 클리닉 알림톡 action_type v4

`attendance_notify_queue.action_type`은 클리닉 알림에서 다음 5개 값을 사용한다.

- `CLINIC_RESERVATION_PARENT`: 학부모용 클리닉 예약 안내
- `CLINIC_RESERVATION_STUDENT`: 학생용 클리닉 예약 안내
- `CLINIC_MISSING_PARENT`: 학부모용 온라인 클리닉 미제출 안내
- `CLINIC_MISSING_STUDENT`: 학생용 온라인 클리닉 미제출 안내
- `CLINIC_ABSENCE_PARENT`: 학부모용 오프라인 클리닉 미등원 안내

호환을 위해 기존 `CLINIC_NOTICE`는 서버에서 `CLINIC_RESERVATION_PARENT`로 정규화한다.

템플릿 환경변수 기본명:

- `TPL_CLINIC_RESERVATION_PARENT=clinicreservationforparents`
- `TPL_CLINIC_RESERVATION_STUDENT=clinicreservationforstudents`
- `TPL_CLINIC_MISSING_PARENT=onlineclinicabsenceforparents`
- `TPL_CLINIC_MISSING_STUDENT=onlineclinicabsenceforstudents`
- `TPL_CLINIC_ABSENCE_PARENT=offlineclinicabsence`

`clinic_time_hhmm`은 `HH:MM` 형태로 입력받아 queue의 `occurred_at`에 KST ISO 시간으로 저장한다.


## Clinic auto notification fields

`clinic_tasks` now uses these runtime fields for offline clinic automation:

- `due_time`: clinic scheduled time in `HH:mm`.
- `due_at`: full scheduled timestamp.
- `clinic_mode`: `OFFLINE` or `ONLINE`.
- `auto_notice_enabled`: whether the automatic clinic notification chain is enabled.

`students.student_phone` is the student KakaoTalk/SMS target. It is synced from CentralDB and is used for student clinic reservation/reminder messages.

`attendance_notify_queue.occurred_at` is treated as the send time for scheduled clinic notifications. The worker only claims rows whose `occurred_at <= now()`.

## Clinic semantics v2

`clinic_tasks.task_type` values:

- `CLASS_CLINIC`: 수업 클리닉. class_id 기준 반 전체에 학생별 row 생성.
- `INDIVIDUAL_CLINIC`: 개별 클리닉. 당일 특정 학생용.
- `EXTRA_CLINIC`: 추가 클리닉. 별도 일정/등원 및 자동 알림 대상.

`clinic_tasks.clinic_mode`는 현재 DB 제약에 맞춰 `ONLINE` 또는 `OFFLINE`을 사용한다. 수업/개별 클리닉은 `ONLINE`으로 저장하여 자동 문자에서 제외하고, 추가 클리닉은 `OFFLINE` 일정 기반 알림을 사용한다.

## Performance indexes v2

`docs/supabase-clinic-performance-v2.sql`은 운영 조회 속도 개선용 인덱스를 추가한다. 기존 데이터 구조를 바꾸지 않으며 재실행해도 안전하다.

## 최종 운영 체크 v1

2차 완성본에는 `admin.finalReadiness`와 관리자 포털 `설정 → 최종 운영 체크`가 포함됩니다.
이 기능은 DB 스키마, 연락처 동기화율, 환경변수, 클리닉 알림 queue, 단어시험, 리포트, 감사 로그 준비 상태를 한 번에 점검합니다.
배포 후에는 `npm run smoke-test`와 함께 최종 운영 체크를 실행한 뒤 메뉴별 디테일 패치로 넘어갑니다.

## phone-tail-attendance-v1

학생과 직원 출결 키오스크의 기본 입력 방식은 `010`을 화면에 고정 표시하고 사용자가 뒤 8자리만 입력하는 방식이다. 학생은 `students.student_phone`, 직원은 `staff` 또는 `staff_snapshot`의 phone-like 컬럼을 기준으로 매칭한다. QR은 보조수단으로 유지한다. 2차 직원 확인 기능은 이번 버전에서 제외한다.

