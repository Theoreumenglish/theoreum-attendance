# 더오름 운영 포털 v1

## 적용 범위

이번 패치는 출석 안정화 코드를 건드리지 않고 `public/admin.html`을 운영 포털 Shell v1로 확장한다.

## 역할

- `admin`: 원장/관리자. 전체 운영, 설정, 권한, 직원 근무 정보 접근.
- `teacher`: 학생·출결·클리닉·단어시험·문자 발송·출결 수동 정정 가능. 시스템 설정/권한/직원 전체 근무시간 접근 제한.
- `assistant`: 전체 학생 조회, 학생 상세 조회, 출결 수동 정정, 문자 발송, 내부 메모, 학부모 공유 메모 작성/조회 가능. 학부모 연락처는 뒤 4자리 표시 원칙. 시스템 설정/권한/직원 전체 근무시간 접근 제한.
- `parent`: 최종 학부모 포털용. linked_student_ids 기준으로 자녀의 공개 정보만 조회.

## 포털 메뉴

1. 홈
2. 출결
3. 학생
4. 클래스
5. 클리닉
6. 단어시험
7. 문자·알림
8. 학부모 리포트
9. 직원
10. 설정·점검

## 구현 원칙

- 중앙DB GAS + Google Sheets는 SSOT.
- Supabase는 운영 런타임/replica.
- 새 쓰기 기능은 CentralDB bridge 또는 mutation queue를 통과시킨 뒤 Supabase replica를 갱신한다.
- `attendance_logs`는 append-only 원칙을 유지한다.
- 모든 주요 행동은 audit log 대상으로 설계한다.
- 학생/직원 이름은 성공 음성으로 출력하지 않는다.

## 다음 Phase

- Phase 2: 학생 상세 read model 확장
- Phase 3: clinic_item_templates / clinic_tasks / clinic_logs 설계
- Phase 4: 단어시험 결과 입력 및 후보 클리닉 생성
- Phase 5: 학부모 일간/주간 리포트 링크
- Phase 6: parent_accounts / parent_student_links 기반 로그인 포털

## Shell v2: 메뉴별 화면 분리

`public/admin.html`은 실제 운영 사이트처럼 왼쪽 메뉴별 화면 전환 방식으로 동작한다.

- `/admin.html#dashboard`: 홈
- `/admin.html#attendance`: 출결
- `/admin.html#students`: 학생
- `/admin.html#classes`: 클래스
- `/admin.html#clinic`: 클리닉
- `/admin.html#words`: 단어시험
- `/admin.html#messages`: 문자·알림
- `/admin.html#reports`: 학부모 리포트
- `/admin.html#staff`: 직원
- `/admin.html#advanced`: 설정·점검
- `/admin.html#qrCenter`: 출결 보조 화면. 왼쪽 메뉴에는 노출하지 않고 출결 화면 버튼에서 진입한다.

화면 전환은 같은 HTML 안에서 `portalView` 단위로 처리한다. 별도 파일 라우팅으로 나누지 않은 이유는 로그인 세션, 공통 RPC, 권한 처리, 배포 경로를 안정적으로 유지하기 위함이다.

## 학생·학부모 포털 방향

학생/학부모 포털은 직원 포털과 다른 목적의 화면으로 설계한다.

- 학생 화면: 오늘 수업, 오늘 할 일, 숙제/클리닉, 단어 재시험, 시험 결과를 실행 중심으로 보여준다.
- 학부모 화면: 자녀 출결, 클리닉 진행, 단어시험/성적, 일간·주간 리포트, 선생님 공유 메모를 보고 중심으로 보여준다.
- 학부모에게는 `parent_visible = true`인 공유 정보만 공개한다.
- 내부 메모와 학부모 공유 메모는 반드시 분리한다.
- 최종 목표는 `parent_accounts`와 `parent_student_links` 기반 로그인 포털이며, 초기에는 문자 인증/리포트 링크 방식으로 시작할 수 있다.

## 다음 구현 순서

1. Portal Role Policy Sync v1: 관리자·강사·조교·학부모 권한 문구와 실제 API 정책 정렬
2. Student Detail v1: 학생 기본 정보, 오늘 출결, 최근 출결 이력, QR 예외 여부, 메모 영역
3. Audit Log Schema v1: 출결 정정, 문자 발송, 메모, 클리닉, 리포트 등 주요 행동 감사 로그
4. Clinic Schema v1: 공통/개인 클리닉 항목, 과제, 완료/부분완료/반려 로그
5. Parent Report v1: 일간·주간 리포트 링크와 시각화 카드
6. Student Portal v1: 학생 오늘 할 일, 숙제/클리닉, 시험/성적 조회



## Staff Portal App UI v2

### 목적

Screen Split v1은 메뉴별 화면 전환 구조를 만들었다. App UI v2는 같은 구조를 실제 업무 앱처럼 보이도록 정리한다.

### 반영 원칙

- 모든 메뉴는 같은 페이지에 길게 붙는 느낌이 아니라 독립 업무 화면처럼 보여야 한다.
- 왼쪽 메뉴, 상단 페이지 헤더, 오른쪽 업무 화면을 분리한다.
- 홈은 기능 설명 페이지가 아니라 오늘 운영을 판단하는 command center로 둔다.
- 디자인은 미니멀하고 세련된 SaaS 대시보드 느낌을 목표로 한다.
- 출석 안정화 코드, 학생 QR, 직원 QR, `index.html`, 중앙DB GAS는 건드리지 않는다.

### 자소서/포트폴리오 관점

이 포털은 단순 기능 모음이 아니라 다음 네 가지 흐름을 보여주는 내부 운영 시스템이다.

1. Information Flow: 출결, 미등원, 알림, 학생 상태가 한 흐름으로 연결된다.
2. Accountability: 수동 정정, 문자, 메모, 클리닉 처리 주체가 추적 가능해야 한다.
3. Intervention Workflow: 단어시험 불통과, 미완료, 출결 위험 신호가 학생 지원 후보로 이어진다.
4. Parent Communication: 내부 메모와 학부모 공개 메모를 분리하고 리포트로 공유한다.

### 다음 단계

1. Portal Role Policy Sync v1
2. Student 360 Profile v1
3. Audit Log Schema v1
4. Clinic Schema v1
5. Word Test Schema v1
6. Parent Report v1
7. Static Contract Test v1


## Staff Portal Minimal App UI v3 메모

2026-06-06 피드백 반영:
- 운영 포털은 기능 카드 나열이 아니라 실제 업무 화면처럼 보이도록 최소 정보 중심으로 재배치한다.
- 직원 QR 링크처럼 운영 포털에서 매일 필요하지 않은 요소는 제거한다.
- 로그인 화면은 작은 카드가 아니라 직원용 업무 시스템의 첫 화면처럼 크게 구성한다.
- 홈 화면은 설명을 줄이고 오늘 처리할 일, 운영 요약, 출결 이상, 개입 후보의 자리만 남긴다.
- 기능 추가보다 화면 밀도, 읽기 흐름, 버튼 수, 정보 우선순위를 먼저 정리한다.

## Operations Visibility v1

2026-06-12 패치 기준으로 운영 포털은 cron/worker가 분리된 뒤의 상태를 UI에서 직접 확인한다.

- 홈: `cron_health` 기반 미등원 감지 cron / 문자 worker cron 상태 표시
- 설정·점검: 최근 `absence_detection_runs`, `notify_worker_runs` 조회 버튼 제공
- 클래스: `assistant.listClassOptions`, `assistant.listClassRoster` 기반 조회 전용 화면 제공

이 단계의 목표는 새 쓰기 기능을 늘리는 것이 아니라, 운영자가 “지금 시스템이 정상적으로 돌고 있는지”를 화면에서 판단할 수 있게 만드는 것이다.

## Batch Portal v1

2026-06-12 Batch Portal v1은 운영 포털을 “조회 가능한 업무 앱”에 가깝게 전진시키는 단계다.

- 학생: Student 360 Profile v1 도입. 학생 선택 후 기본 정보, 오늘 출결 상태, QR 예외, 최근 출결, 소속 클래스, 결석예외를 한 화면에서 본다.
- 문자·알림: 실패 알림 버튼 중심에서 queue 운영 화면으로 전환. 상태와 종류별 조회, 관리자 PIN 기반 재처리를 제공한다.
- 직원: placeholder를 제거하고 staff_monthly / staff_daily 기반 근무 조회 화면으로 전환한다.
- 클리닉/단어시험/리포트: 아직 쓰기 API를 만들지 않고, 실제 운영 흐름과 DB 설계 방향을 화면에 고정한다.

이 패치는 중앙DB GAS를 수정하지 않는다.

## Clinic / Word / Audit Schema v1

2026-06-12 패치 기준으로 클리닉/단어시험 화면이 placeholder에서 실제 DB 쓰기 화면으로 전환된다.

- 클리닉: `clinic_tasks` 생성, 상태별 조회, 상태 변경을 지원한다.
- 단어시험: `word_test_sessions` 회차 생성, `word_test_results` 결과 저장을 지원한다.
- 자동 후보: `wordTest.enterResult`에서 불통과로 저장하면 `clinic_tasks.source_type = WORD_FAIL` 후보가 자동 생성된다.
- Student 360: 최근 클리닉과 최근 단어시험 결과를 함께 표시한다.
- 감사 로그: 신규 write op는 `portal_audit_logs`에 best-effort 방식으로 기록한다.

운영 적용 순서는 반드시 `Supabase SQL 실행 → 앱 패치 적용 → npm run verify → 배포`다.

## 2026-06-12 One-click Operations UX v1

운영 포털의 다음 UX 원칙은 “메뉴를 찾아다니는 화면”이 아니라 “버튼 클릭으로 업무가 이어지는 화면”이다.

- 상단 고정 원클릭 업무 런처를 추가한다.
- 학생은 한 번 선택하면 출결, 클리닉, 단어시험 입력 화면에 자동 반영한다.
- 홈의 딸깍 업무 처리 보드에서 오늘 전체 점검, 미등원 실패, 클리닉 후보, 오늘 단어시험을 바로 열 수 있다.
- 클리닉은 단어 재시험, 독해 오답, 숙제 미완료, 출결 상담, 보강 필요를 프리셋 버튼으로 바로 생성한다.
- 단어시험은 선택 회차 + 선택 학생 상태에서 100/95/90/80/미응시를 버튼 한 번으로 저장할 수 있다.
- 문자 큐와 클리닉 목록은 상태 필터 버튼으로 즉시 조회한다.

후속 UX 작업은 수동 디버깅 결과를 바탕으로 “두 번 이상 반복 입력하는 행동”을 계속 원클릭 액션으로 승격한다.
