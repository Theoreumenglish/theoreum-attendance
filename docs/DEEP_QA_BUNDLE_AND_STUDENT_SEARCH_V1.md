# deep-qa-bundle-and-student-search-v1

## 목적

전화번호 출석화 최종 통과 이후 남은 QA 경고를 정리하고, 사용자가 스크린샷 폴더를 수동으로 압축하지 않도록 deep QA 번들을 더 명확하게 고정한다.

## 반영 사항

- 학생 화면 상단 검색 입력 옆에 `학생 찾기` 버튼을 추가한다.
- Enter 입력으로도 학생 검색이 즉시 실행된다.
- deep QA는 더 이상 화면 아래의 중앙DB 유지보수용 `btnMasterStudentSearch`를 억지로 찾지 않고, 실제 사용자 흐름에 맞는 상단 `btnStudentSearchNow`를 사용한다.
- deep QA PowerShell wrapper는 스크린샷 PNG, DOM JSON, 복붙용 리포트, raw JSON, README를 `PRODUCTION_DEEP_QA_BUNDLE.zip`에 함께 넣는다.
- `npm run copy-last-log`는 deep QA 리포트를 복사할 때 첨부할 zip 경로도 함께 알려준다.

## 운영 기준

- 전화번호 출석/직원 출퇴근 기준은 `Failed: 0`과 함께 유지한다.
- QA 결과를 보낼 때는 `PRODUCTION_DEEP_QA_TO_SEND.txt` 내용을 우선 붙여넣고, 화면 판단이 필요하면 `PRODUCTION_DEEP_QA_BUNDLE.zip`을 첨부한다.
