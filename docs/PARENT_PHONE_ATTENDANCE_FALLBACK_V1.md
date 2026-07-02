# PARENT_PHONE_ATTENDANCE_FALLBACK_V1

## 목적
학생 본인 휴대폰이 없는 학생도 키오스크 전화번호 출결을 사용할 수 있게 한다.

## 운영 규칙
- 학생 휴대폰(`students.student_phone`)이 010 형식으로 있으면 학생 번호를 우선 사용한다.
- 학생 휴대폰이 비어 있거나 010 형식이 아니고, 학부모 휴대폰(`students.parent_phone`)이 010 형식이면 학부모 번호 뒤 8자리로 출결을 허용한다.
- 형제/자매처럼 같은 학부모 번호가 여러 재원생에게 걸리면 ambiguous 처리하고 데스크 문의로 막는다.
- 따라서 학부모 번호 fallback은 편의 기능이지만 중복 여부는 `admin.phoneIdentity.audit`로 반드시 확인한다.

## 관리자 사용법
학생 메뉴에서 학생을 선택한 뒤:
1. 학생 휴대폰을 비운다.
2. 학부모 휴대폰에 010 형식 번호를 입력한다.
3. 학생 저장을 누른다.

또는 `학생번호 비우고 학부모번호로 출결` 버튼을 사용한다.

## QA 기준
- `api/kiosk-mark.js`에 `parent_phone_fallback` 로직이 있어야 한다.
- `admin.phoneIdentity.audit`는 parent fallback 가능 학생 수를 summary에 포함한다.
