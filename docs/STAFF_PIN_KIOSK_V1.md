# staff-pin-kiosk-v1

## 목적

학생 출석은 물리 키보드 학번 4자리 입력을 기본으로 하고, 직원 출퇴근은 QR 대신 직원 ID + PIN으로 처리할 수 있게 한다.

## 운영 흐름

### 학생 출석

1. 키오스크에서 등원/하원/이동/외출 버튼을 선택한다.
2. 학생이 물리 키보드로 학번 4자리를 입력한다.
3. Enter 또는 기존 자동 제출 흐름으로 출결을 처리한다.
4. QR 스캔은 보조수단으로 유지한다.

화면 숫자 키패드는 제거한다. 실제 현장에서는 물리 키보드가 더 빠르고 오입력이 적다.

### 직원 출퇴근

1. 어떤 출결 버튼이 선택된 상태든 입력창에 `staff`를 입력한다.
2. 직원 출퇴근 모드로 전환된다.
3. 직원 출근/퇴근 버튼 중 필요한 동작을 선택한다.
4. 직원 ID를 입력하고 Enter를 누른다.
5. PIN을 입력하고 Enter를 누른다.
6. `staff.clock` RPC가 `staff_id + pin`을 검증한 뒤 출퇴근 기록을 남긴다.

`staffin`, `staffout`, `직원출근`, `직원퇴근`도 진입어로 허용한다.

## 서버 변경

`api/staff-clock.js`는 기존 세션 기반 `staff.clock`을 유지하면서, 다음 입력도 허용한다.

```json
{
  "action": "IN",
  "staff_id": "fubao",
  "pin": "1234",
  "input_mode": "PIN",
  "note": "KIOSK_PIN"
}
```

PIN 검증은 기존 직원 PIN 해시/솔트 구조를 사용한다.

## 보안 원칙

- PIN은 브라우저에 저장하지 않는다.
- PIN은 Git, 문서, release zip에 포함하지 않는다.
- 입력창은 PIN 단계에서 password 타입으로 전환한다.
- 직원 QR은 보조수단으로 유지한다.
- 직원 ID/PIN 방식은 내부 키오스크 전용으로 사용한다.

## 변경 파일

- `index.html`
- `api/staff-clock.js`
- `lib/staff-attendance.js`
- `scripts/admin-integrity-check.mjs`
- `scripts/ops-checklist.mjs`
- `docs/STAFF_PIN_KIOSK_V1.md`
