# 프로젝트 인수인계/운영 기준 (Direct 전환 단계)

## 1) 현재 상태표 (반드시 이 표 기준으로 판단)

- **중앙DB GAS (`v26.0-central-ultimate`)**: 운영 중인 기준 시스템(SSOT), strict schema/repair/self-check/cron/replica sync 허브.
- **출석 GAS (`v27.2.2-att-central-final`)**: 레거시 기준 동작 + 운영 보조/비상 레퍼런스.
- **직원 QR 생성기 GAS (`v1.0.1-staff-release2`)**: 직원 QR 세션/검증 정책 원본.
- **Vercel/Supabase**: 실시간 핫패스 주력 런타임(점진 이전의 실제 대상).

> 핵심: 이 프로젝트는 GAS를 “전부 폐기”하는 것이 아니라,
> **중앙DB 정책 원본은 유지하고 실시간 경로의 GAS 의존만 제거**하는 작업이다.

## 2) 권위 순서 (authoritative precedence)

정책/코드가 충돌할 때 신뢰 순서는 아래와 같다.

1. 현재 배포된 **direct 런타임 동작**
2. 마지막에 통과된 **기준본 버전 파일**
3. 레거시 파일의 오래된 주석/중간 스니펫

## 3) 절대 깨면 안 되는 데이터/계약

- SSOT는 중앙DB 유지.
- STAFF / 학생 exact header 계약 유지.
- `student_id`, 전화번호, `qr_id`는 **텍스트** 처리.
- 학생 QR prefix: `QR1.*`, 직원 QR prefix: `STAFFQR1.*`.
- `trace_id`는 로그/미러링/감사 경로에서 **필수 계약**.
- 스케줄 판정은 `CLASS_SCHEDULE` 우선, `CLASSES` fallback.

## 4) 런타임 구분 (혼용 금지)

- GAS 프론트: `google.script.run`, `?res=manifest`/`?res=sw` 계열 자산 경로.
- Vercel 프론트: 정적 자산 경로(`/manifest.webmanifest`, `/sw.js`) + `fetch('/api/...')`.

같은 UI처럼 보여도 RPC 계층/자산 경로가 다르므로 **섞으면 바로 깨진다**.

## 5) Direct 전환 우선순위 (현 시점)

1. snapshot/sync 품질 안정화
2. direct 배포본 최종 검수
3. Pro 기준 cron/worker를 복구/보조 경로로 재설계
4. 레거시 fallback 제거 최종 검수

## 6) 운영 전 최종 점검 체크리스트

1. 중앙DB self-check/cron 정상 여부
2. STAFF/학생 exact header 검증
3. snapshot 최신화 확인
4. direct env/secret 세트 확인
5. 학생 QR / 예외 PIN / 직원 웹출퇴근 / 직원 QR 실스캔 테스트
6. notify worker sweep/stale recovery 확인

## 7) 롤백 원칙

- 기준 데이터 문제: 중앙DB에서 해결.
- direct 런타임 문제: Vercel 배포 rollback 우선.
- 레거시 GAS는 완전 검수 전까지 비상 레퍼런스로 유지.
- 오래된 스니펫 복붙으로 rollback하지 말고, **통과된 최신 배포 커밋 기준**으로 되돌린다.
