# production-qa-runner-v1

목적: ChatGPT 실행 환경에서 Vercel preview DNS가 열리지 않는 경우에도, 사용자 PC에서 실제 production/preview URL을 대상으로 로그인/API/핵심 기능 QA를 한 번에 실행한다.

## 명령어

```powershell
$env:QA_BASE_URL="https://your-preview.vercel.app"
$env:QA_STAFF_ID="chatgpt_qa"
$env:QA_PASSWORD="임시비밀번호"
$env:QA_STUDENT_QUERY="QA학생"
$env:QA_STAFF_TAIL8="55556666"
npm run prod:qa
```

쓰기 테스트까지 실행하려면:

```powershell
npm run prod:qa:write
```

## 생성 파일

- `_logs/PRODUCTION_QA_REPORT.md`
- `_logs/PRODUCTION_QA_TO_SEND.txt`

## 점검 항목

- 메인 페이지 응답
- 학생 링크 페이지 응답
- 로그인
- auth.me
- 최종 운영 체크
- 휴대폰 출결 준비도
- 중앙DB 직원 목록
- 학생 검색
- 학생 오늘 링크 생성/공개 조회(write 모드)
- 온라인강의 배정 저장(write 모드)
- 단어/클리닉 주요 read API
- 직원 휴대폰 출근 처리(write 모드, QA_STAFF_TAIL8 있을 때)
