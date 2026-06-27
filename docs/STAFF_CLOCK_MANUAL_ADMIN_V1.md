# STAFF_CLOCK_MANUAL_ADMIN_V1

## 목적

원장/관리자가 직원 출근/퇴근 시간을 수기로 추가하거나 기존 로그를 수정할 수 있게 한다.

## 운영 원칙

- 직원 키오스크 입력은 유지한다.
- 수기 추가/수정은 원장/관리자 권한에서만 수행한다.
- 수기 저장 후 `staff_daily`, `staff_monthly`는 즉시 재계산한다.
- 삭제 기능은 v1에 넣지 않는다. 잘못 입력한 로그는 수정으로 보정한다.

## 추가 API

- `admin.staffClock.listLogs`
  - 입력: `staff_id`, `yyyymmdd`
  - 출력: 해당 직원의 해당 일자 원본 `staff_clock_logs` 목록

- `admin.staffClock.saveManual`
  - 입력: `staff_id`, `yyyymmdd`, `time`, `action`, `note`, 선택 `trace_id`
  - `trace_id` 없음: 수기 로그 추가
  - `trace_id` 있음: 기존 로그 수정

## UI

직원 탭에 “직원 출퇴근 수기 추가/수정” 영역을 추가한다.

- 직원 ID
- 날짜
- 시간
- 출근/퇴근
- 수정 trace_id
- 메모
- 수기 추가/수정 버튼
- 당일 로그 조회 버튼

## DB 변경

없음. 기존 `staff_clock_logs`, `staff_daily`, `staff_monthly`를 사용한다.
