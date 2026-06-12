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
