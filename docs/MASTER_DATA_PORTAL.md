# 중앙DB 마스터데이터 포털 이관 v2

운영 포털의 `클래스` 메뉴에서 중앙DB 웹앱의 핵심 마스터데이터 작업을 처리한다.

## 이관된 작업

- 클래스 생성/수정/삭제
- 학생DB 학생 추가/수정
- 학생 휴대폰/학부모 휴대폰 수정
- 반 수강생 추가/제외
- 저장 후 Supabase replica 즉시 반영 시도
- 반복 조회 클라이언트 캐시 / in-flight 중복 요청 병합

## 기준

- 중앙DB GAS/Google Sheets가 SSOT이다.
- 포털은 Vercel API를 통해 `bridge.*` GAS 작업을 호출한다.
- 쓰기 작업 후 `classes`, `students`, `class_students` replica가 즉시 patch 되도록 한다.
- 실패 시 중앙DB 저장 성공 여부와 replica 반영 실패 여부를 분리해서 확인한다.

## 필수 환경변수

- `CENTRAL_GAS_WEBAPP_URL`
- `CENTRAL_BRIDGE_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## 배포 순서

1. 중앙DB GAS 패치 배포
2. Vercel 앱 패치 적용
3. Supabase `supabase-master-speed-v2.sql` 실행
4. Vercel 배포
5. smoke-test
6. 클래스 메뉴에서 CRUD 리허설

## CentralDB 웹앱 잔여 기능 이관 v3

운영 포털에서 중앙DB 웹앱의 잔여 관리 기능까지 처리하도록 확장했다.

- 반별 휴강: `admin.central.classHolidays.list/add/remove` → `bridge.class.holidays.*`
- 실제 일정 수동 편집: `admin.central.schedule.list/update/rebuild` → `bridge.schedule.*`
- 학원 전체 휴무: `admin.central.globalHolidays.list/add/remove` → `bridge.global_holidays.*`
- 직원 계정 관리: `admin.central.staff.list/upsert/toggle/resetSecret` → `bridge.staff.*`
- 중앙DB 시스템 설정/Self Check: `admin.central.props.get/set`, `admin.central.selfCheck`

운영 원본은 여전히 Google Sheets 중앙DB이며, 포털은 GAS bridge를 통해 원본을 수정한다. 조회는 Supabase replica와 짧은 서버/클라이언트 캐시를 함께 사용해 체감 속도를 높인다.

## CentralDB 이관/속도 안정화 v4

v4에서는 중앙DB 웹앱에 남아 있던 일상 운영 기능 중 `미등원 문자 제외/예외` 관리를 운영 포털 출결 메뉴로 이관했다.

포털에서 처리하는 추가 기능:

- `assistant.listAbsenceExcuses`: 미등원 예외 조회
- `assistant.addAbsenceExcuse`: 학생 1명 미등원 예외 추가
- `assistant.bulkAddAbsenceExcuses`: 여러 학생 미등원 예외 일괄 추가
- `assistant.removeAbsenceExcuse`: 미등원 예외 삭제

속도 안정화 보강:

- 중앙DB bridge 읽기 API는 메모리 fresh cache와 stale fallback을 사용한다.
- 중앙DB 직원 목록은 우선 Supabase replica(`staff` 또는 `staff_snapshot`)에서 읽고, 필요한 경우에만 GAS 원본으로 fallback한다.
- 중앙DB 설정은 최초 원본 조회 후 `runtime_config.central_props_snapshot`에 snapshot을 남겨 이후 설정 화면을 빠르게 연다.
- 브라우저 RPC 캐시는 fresh TTL이 지나도 짧은 stale 값을 보관해 네트워크 지연/타임아웃 때 이전 정상 응답을 즉시 보여줄 수 있다.

운영 원칙:

- 저장/삭제/계정 변경은 여전히 중앙DB GAS bridge를 원본으로 한다.
- 빠른 조회는 Supabase replica와 snapshot을 우선 사용한다.
- 원본과 replica가 다르면 `중앙DB 최신화` 또는 강제 원본 조회(`force=true`)로 확인한다.
