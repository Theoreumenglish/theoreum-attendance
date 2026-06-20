# Daily Ops Polish v1

내부 직원이 매일 쓰는 기준으로 관리자 포털을 더 빠르게 조작할 수 있게 정리한 패치입니다.

## 핵심 변경

- 오늘 화면에 `오늘 업무 레일` 추가
  - 미등원, 클리닉, 단어, 문자 실패, 학생 검색을 한 줄에서 바로 처리
- 최근 작업 대상 추가
  - 최근 선택한 클래스와 학생을 상단 chip으로 다시 선택
- 명령 팔레트 추가
  - `Ctrl+K` 또는 `/`로 열기
  - 학생 검색, 오늘 화면, 미등원, 오늘 클리닉, 단어 일괄 입력, 문자 실패, 리포트, 설정으로 바로 이동
- 설명문 기본 숨김
  - 내부 실사용 기준으로 장황한 설명을 줄이고 작업명 중심으로 정리
- 실시간 미등원 보드와 오늘 업무 레일 연동
  - 미등원 수, 수업반 수, 등원 수가 오늘 화면 상단에서 바로 보임
- 키보드 단축 이동
  - `/`: 명령 팔레트 열기
  - `Ctrl+K`: 명령 팔레트 열기
  - `H`: 오늘 화면
  - `C`: 오늘 클리닉
  - `W`: 오늘 단어시험

## 수정 범위

- `public/admin.html`만 수정합니다.
- 중앙DB GAS 수정 없음
- Supabase SQL 추가 없음
- 서버 API 추가 없음

## 검증

패치 제작 시 다음을 통과했습니다.

- `npm run check`
- `npm run contract-check`
- `npm run ux-check`
- `npm run flow-sim`
- `npm run integrity-check`
- `npm run ops-checklist`
- `npm run final-readiness-check`
- `npm run build`
- `npm run verify`
