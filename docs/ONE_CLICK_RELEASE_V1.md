# One-click release v1

## 목적

패치 적용 후 매번 흩어진 명령어를 실행하지 않도록, 문법검사부터 운영 smoke-test까지 한 번에 실행하는 로컬 운영 루틴을 제공한다.

## 포함 범위

- `scripts/setup-smoke-env.ps1`
- `scripts/one-click-release.ps1`
- `scripts/smoke-test.mjs`의 `.env.smoke.local` 자동 로딩
- `.gitignore`의 `.env.smoke.local` 제외

## 원칙

- smoke-test 계정 비밀번호는 코드, 문서, 커밋, release zip에 넣지 않는다.
- `.env.smoke.local`은 각 PC 로컬에만 둔다.
- release zip 생성 스크립트는 `.env*` 파일을 제외한다.

## 사용 순서

최초 1회:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-smoke-env.ps1 -StaffId "직원ID" -Password "비밀번호"
```

이후 패치 완료 루틴:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\one-click-release.ps1 -CommitMessage "feat: ..."
```

## 실패 시

- 검증 실패: 해당 npm script 로그부터 확인한다.
- 배포 실패: Vercel CLI 로그인/권한/환경변수를 확인한다.
- smoke-test 실패: `.env.smoke.local`의 `SMOKE_BASE_URL`, `SMOKE_STAFF_ID`, `SMOKE_PASSWORD`를 확인한다.
