# phone-attendance-final-lock-v1

목적: 전화번호 기반 학생 출석/직원 출퇴근을 운영 전 필수 품질 기준으로 잠근다.

## 완료 기준

- 키오스크 `010-[4자리]-[4자리]` 물리 키보드 입력이 `npm run kiosk-input-check`와 deep QA에서 모두 통과한다.
- `staff_phone_directory`는 RLS가 켜진 private lookup table로 유지한다.
- 중앙DB 직원 저장 시 `staff_phone_directory`에도 직원 번호가 저장되어 직원 휴대폰 출퇴근이 실패하지 않아야 한다.
- `admin.phoneIdentity.audit` API가 200 응답해야 하며 관리자 UI도 `data-qa-state="loaded"` 상태로 갱신되어야 한다.
- `prod:qa:deep:write`에서 `kiosk phone input`, `staff phone clock write test`, `phone identity audit UI`가 모두 OK여야 한다.

## QA false-fail 방지

전화번호 출결 준비도 UI는 API 응답 이후 `#phoneIdentitySummary[data-qa-state="loaded"]`를 남긴다. Deep QA는 이 상태를 최대 40초까지 기다린다.

## 보안 기준

`staff_phone_directory`는 anon/authenticated client 직접 조회를 허용하지 않는다. 서버 API는 service_role로만 접근한다.
