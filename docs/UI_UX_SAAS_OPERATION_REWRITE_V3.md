# ui-ux-saas-operation-rewrite-v3

## 목적

기능상 오류가 없는 상태에서, 일반 직원(데스크·강사·조교)이 설명 없이 사용할 수 있도록 운영 화면을 `search-first`, `automation-first`, `minimal-first` 방식으로 전면 재정리한다.

이번 개편은 버튼을 더 붙이는 것이 아니라, 기본 화면에서 불필요한 선택지를 줄이고 직원이 실제로 하는 업무 순서에 맞춰 화면을 다시 묶는 작업이다.

## 참고한 제품/UX 원칙

- NN/G 10 Usability Heuristics
  - Visibility of system status: 지금 어떤 상태인지 화면에서 바로 보여준다.
  - Match between system and the real world: 개발자 용어가 아니라 학원 업무 언어를 사용한다.
  - Recognition rather than recall: 사용자가 메뉴/버튼 위치를 외우지 않아도 화면에서 바로 선택할 수 있게 한다.
  - Aesthetic and minimalist design: 지금 필요하지 않은 정보는 기본 화면에서 빼고, 필요한 순간에만 보여준다.
- 학원 운영 SaaS 벤치마크
  - 학생을 먼저 선택한 뒤 출결·청구·상담·기록으로 이어지는 구조.
  - 학생/학부모 전화번호 기반 출결처럼 직원이 따로 설정을 많이 외우지 않아도 되는 흐름.
  - 반 전체/여러 학생을 선택해 한 번에 기록하는 bulk action 구조.

## 핵심 설계 원칙

### 1. Search-first

홈 화면의 기본 동작은 메뉴 선택이 아니라 `학생 검색`이다.

직원은 학생 이름, 학번, 전화번호 일부만 입력하면 학생 후보를 보고, 선택 후 필요한 작업으로 이동한다.

### 2. Automation-first

수동으로 여러 버튼을 누르는 흐름을 줄인다.

- 학생 선택 → 출결번호/학생 링크/클리닉/단어 작업 연결
- 직원 선택 → 휴대폰만 저장 가능
- 학생 휴대폰이 없으면 학부모 휴대폰 fallback 기준을 화면에서 안내
- 단어 불통과/클리닉 후보/오늘 미등원 같은 자동 판단은 홈 요약으로 끌어올림

### 3. Minimal-first

처음 보이는 화면에서는 다음만 남긴다.

- 학생 검색
- 오늘 미등원
- 학생 번호
- 단어 채점
- 클리닉 처리
- 직원 번호

기존 고급 기능은 삭제하지 않고 접어둔다.

### 4. Role-aware controls

assistant/teacher 역할에서는 직원 수정·삭제·비밀번호/PIN 변경처럼 위험도가 높은 버튼을 숨긴다.

### 5. Mobile-first public view

학생/학부모 링크 화면은 스마트폰 기준으로 큰 카드, 충분한 여백, 명확한 오늘 할 일을 우선한다.

## 변경된 파일

- `public/admin.html`
  - SaaS-grade operations UI v3 스타일 추가
  - 검색 중심 운영 홈 추가
  - 학생 자동완성 드롭다운 추가
  - 학생 상태 badge 추가
  - 학생 집중 패널 추가
  - 직원 집중 패널 추가
  - 역할 기반 버튼 숨김 추가
  - 테이블 가독성, sticky 업무 액션, 메시지/리포트 카드 구조 개선
- `index.html`
  - kioskModernV3 적용
  - 21:9 모니터에서도 중앙에 모이는 키오스크 컨테이너
  - 터치 번호패드 추가
  - 버튼 scale 피드백 추가
- `student-today.html`
  - studentMobileV3 적용
  - 모바일 우선 카드형 과제/단어/클리닉 표시
  - 학생·학부모가 보는 화면의 여백/가독성 개선
- `scripts/ops-checklist.mjs`
  - UI/UX 전면 개편 기준 검사 추가

## QA 기준

이번 개편은 DB 변경이 없다. 적용 후 다음을 반드시 확인한다.

```powershell
npm run verify
npm run prod:qa:deep:write -- -BaseUrl "https://theoreum-attendance.vercel.app" -StaffId "chatgpt_qa" -Password "12345678" -StudentQuery "QA학생" -StudentTail8 "11112222" -StaffTail8 "55556666"
```

## 다음 단계

이번 v3는 layout shell과 주요 화면 구조를 갈아엎는 1차 전면 개편이다.

다음 단계는 학생 상세 화면을 독립 workspace로 분리한다.

- 기본정보
- 출결번호
- 오늘 할 일
- 온라인강의
- 클리닉
- 단어 기록
- 학부모 리포트

이렇게 탭 단위로 나누면 현재 학생 화면의 파편화가 크게 줄어든다.
