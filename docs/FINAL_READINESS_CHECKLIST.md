# 더오름 운영 포털 최종 운영 체크리스트

이 문서는 2차 완성본 배포 후 실제 운영 전 확인해야 하는 마지막 체크리스트입니다.
관리자 포털의 `설정 → 최종 운영 체크` 버튼과 `npm run smoke-test` 결과를 함께 확인합니다.

## 1. 배포 전 자동 검사

```powershell
npm run verify
.\scripts\preflight-before-deploy.ps1
```

통과 기준:

- JS 문법 검사 통과
- API/UI 계약 검사 통과
- UX 복잡도 검사 통과
- 업무 흐름 시뮬레이션 통과
- 무결성 검사 통과
- 운영 체크리스트 통과
- 최종 readiness 정적 검사 통과
- Vite build 통과

## 2. 배포 후 live API smoke-test

```powershell
$env:SMOKE_BASE_URL="https://theoreum-attendance.vercel.app"
$env:SMOKE_STAFF_ID="직원ID"
$env:SMOKE_PASSWORD="비밀번호"
npm run smoke-test
```

확인 API:

- meta.ping
- auth.login / auth.me / auth.logout
- admin.getOpsOverview
- admin.finalReadiness
- clinic.listTasks / clinic.todayBoard
- wordTest.listSessions
- report.listSnapshots

## 3. 관리자 포털 최종 체크

관리자 포털에서:

```txt
설정 → 최종 운영 체크 → 최종 체크 실행
```

확인 항목:

1. DB 필수 테이블/컬럼
2. 학생/학부모 연락처 동기화율
3. Vercel 운영 환경변수
4. 클리닉 업무 흐름
5. 클리닉 알림 queue 상태
6. 단어시험 데이터 흐름
7. 리포트/감사 로그 흐름

## 4. 실제 운영 리허설

최소 1개 반, 1명 학생으로 아래를 실제로 수행합니다.

1. 수업 클리닉 반 전체 생성
2. 오늘 클리닉 업무판 확인
3. 열린 건 일괄 완료
4. 추가 클리닉 생성
5. 학생/학부모 예약 안내 queue 생성 확인
6. 단어시험 회차 생성
7. 반 명단 불러오기
8. 맞은개수/전체개수 일괄 입력
9. 불통과 자동 추가 클리닉 생성 확인
10. 리포트 미리보기
11. 리포트 스냅샷 저장
12. 감사 로그 조회

## 5. 운영 중 우선 모니터링

- `attendance_notify_queue`의 FAILED 증가 여부
- `notify_worker_runs`의 최근 실행 시각
- `absence_detection_runs`의 최근 실행 시각
- `clinic_tasks` 오늘 미완료 건수
- `word_test_results` 저장 오류 여부
- `portal_audit_logs` 기록 여부

## 6. 다음 단계

2차 완성본 이후에는 큰 기능 추가보다 메뉴별 디테일 패치를 진행합니다.

권장 순서:

1. 클리닉 화면 디테일
2. 단어시험 화면 디테일
3. 문자 queue / 발송 실패 처리
4. 리포트 문구 다듬기
5. 권한별 버튼 숨김
6. admin.html / api/rpc.js 모듈화

## One-click release / smoke env

- `.env.smoke.local`은 운영 smoke-test 계정 정보를 로컬에만 저장한다.
- `.env.smoke.local`은 Git commit 및 release zip에 포함하지 않는다.
- `scripts/one-click-release.ps1`은 검사 → 검증 → 빌드 → 커밋 → 푸쉬 → 압축파일 → 배포 → smoke-test 흐름을 한 번에 실행한다.
- 비밀번호는 코드와 문서에 하드코딩하지 않는다.


## Node 24 / 직원 근태 수기 보정

- package.json engines.node가 24.x인지 확인
- Vercel build log에서 Node 20.x deprecation 경고가 사라졌는지 확인
- 직원 탭에서 관리자/원장이 출퇴근 로그를 수기로 추가/수정할 수 있는지 확인
- 수기 저장 후 staff_daily / staff_monthly가 재계산되는지 확인
