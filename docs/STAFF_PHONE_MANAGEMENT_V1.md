# staff-phone-management-v1

목적: 직원 휴대폰 뒤 8자리 출퇴근을 실제 운영에서 사용할 수 있도록 중앙DB 직원 관리 화면에 휴대폰 입력/표시 흐름을 추가한다.

## 정책

- 관리자 화면 `중앙DB 직원 계정 관리`에 휴대폰 입력란을 표시한다.
- `01055556666` 또는 뒤 8자리 `55556666` 입력을 허용한다.
- 서버 저장값은 `010` 포함 11자리 숫자로 정규화한다.
- 직원 전화번호는 비밀번호/PIN과 별개로 저장한다.
- 직원 출퇴근 키오스크는 기존처럼 `010` 제외 뒤 8자리로 처리한다.

## DB

Supabase mirror 테이블에 `staff_phone` 컬럼을 추가한다.

```sql
-- docs/supabase-staff-phone-v1.sql
alter table if exists public.staff add column if not exists staff_phone text;
alter table if exists public.staff_snapshot add column if not exists staff_phone text;
```

## 주의

중앙DB GAS 원본이 phone 컬럼을 아직 저장하지 않는 경우에도, Vercel 서버가 Supabase 직원 mirror에 `staff_phone`을 best-effort로 반영한다. 장기적으로는 중앙DB GAS 직원 시트에도 phone/staff_phone 헤더를 추가하는 것이 좋다.
