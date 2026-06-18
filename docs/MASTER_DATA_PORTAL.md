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
