# midcycle-qa-ui-review-v1

## 목적
전화번호 출석화 안정화 이후 중간 점검 기준을 고정한다.

## 확인한 현재 상태
- Production deep QA 기준 Failed 0 / Warnings 0 상태를 유지한다.
- 학생 전화번호 출석, 직원 staff 진입어, 직원 전화번호 출퇴근은 잠금 기준으로 관리한다.
- 스크린샷은 매 실행마다 `_logs/PRODUCTION_DEEP_QA_BUNDLE_<runId>.zip`으로 생성한다.

## 이번 보강
1. 학생 오늘 링크 페이지가 실제 데이터 로딩 완료 전에는 QA 통과로 보이지 않도록 `data-qa-state`를 둔다.
2. 학생 오늘 링크에 오늘 할 일 요약, 새로고침, 클리닉/단어/온라인강의 count를 표시한다.
3. deep QA가 학생 링크 public 페이지를 열 때 `loaded` 상태까지 기다린 뒤 캡처한다.
4. deep QA zip 안에 `SCREENSHOT_INDEX.html`을 넣어 스크린샷을 한눈에 확인할 수 있게 한다.

## 다음 패치 후보
1. student-portal-task-v1: 학생 오늘 링크에 오늘 할 일/미완료/완료 구분 강화
2. online-lecture-completion-v1: 온라인강의 학생 완료 체크
3. parent-portal-report-link-v1: 학부모용 리포트 링크
4. student360-risk-summary-v1: 학생360 위험 신호 요약
5. ops-board-daily-priority-v1: 원장/조교 오늘 우선순위 보드
