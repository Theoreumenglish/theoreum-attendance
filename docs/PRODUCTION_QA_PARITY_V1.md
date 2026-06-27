# production-qa-parity-megapatch-v1

목적: production/preview QA에서 확인된 `/student-today.html` 404, `admin.phoneIdentity.audit` BAD_OP, `admin.lectureAssignment.list` BAD_OP를 한 번에 추적·방지한다.

## 이번 QA 실패의 실제 의미

아래 조합은 대부분 "코드에 기능이 없어서"가 아니라 "오래된 Vercel preview URL을 보고 있어서" 발생한다.

- `/student-today.html` 404
- `admin.phoneIdentity.audit` BAD_OP
- `admin.lectureAssignment.list` BAD_OP

Vercel preview URL은 배포마다 새로 생기는 경우가 많다. 이전 preview URL로 QA를 돌리면 최신 패치가 반영되지 않은 코드가 응답한다.

## 패치 내용

- `meta.supportedOps` API 추가
- `meta.ping` 응답에 QA feature matrix 포함
- `student-today.html`을 Vite build input으로 고정
- production QA runner에 deployment parity check 추가
- smoke-test에 `/student-today.html` 페이지 확인 추가
- BAD_OP 발생 시 stale preview URL 안내 강화
- legacy alias 지원:
  - `phoneIdentity.audit`
  - `admin.phoneIdentityAudit`
  - `lectureAssignment.list`
  - `lectureAssignment.save`
  - `admin.onlineLecture.list`
  - `admin.onlineLecture.save`

## QA 기준

`npm run prod:qa`는 다음을 확인한다.

1. `/` 응답
2. `/student-today.html` 응답
3. `meta.supportedOps`
4. 로그인
5. 최종 운영 체크
6. 휴대폰 출결 준비도
7. 학생 검색
8. 온라인강의 배정 조회
9. 단어/클리닉 주요 read API

## URL 기준

가능하면 최신 QA는 아래 stable production URL로 실행한다.

```powershell
$env:QA_BASE_URL="https://theoreum-attendance.vercel.app"
npm run prod:qa
```

특정 preview URL을 사용할 때는 반드시 방금 배포된 최신 preview URL인지 확인한다.

## 릴리즈 태그

`production-qa-parity-megapatch-v1`
