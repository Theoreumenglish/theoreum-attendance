# 더오름 운영 포털 v1

## 적용 범위

이번 패치는 출석 안정화 코드를 건드리지 않고 `public/admin.html`을 운영 포털 Shell v1로 확장한다.

## 역할

- `admin`: 원장/관리자. 전체 운영, 설정, 권한, 직원 근무 정보 접근.
- `teacher`: 학생·출결·클리닉·단어시험·문자 발송·출결 수동 정정 가능. 시스템 설정/권한/직원 전체 근무시간 접근 제한.
- `assistant`: 전체 학생 조회, 학생 상세 조회, 출결 수동 정정, 문자 발송, 내부 메모, 학부모 공유 메모 작성/조회 가능. 학부모 연락처는 뒤 4자리 표시 원칙. 시스템 설정/권한/직원 전체 근무시간 접근 제한.
- `parent`: 최종 학부모 포털용. linked_student_ids 기준으로 자녀의 공개 정보만 조회.

## 포털 메뉴

1. 홈
2. 출결
3. 학생
4. 클래스
5. 클리닉
6. 단어시험
7. 문자·알림
8. 학부모 리포트
9. 직원
10. 설정·점검

## 구현 원칙

- 중앙DB GAS + Google Sheets는 SSOT.
- Supabase는 운영 런타임/replica.
- 새 쓰기 기능은 CentralDB bridge 또는 mutation queue를 통과시킨 뒤 Supabase replica를 갱신한다.
- `attendance_logs`는 append-only 원칙을 유지한다.
- 모든 주요 행동은 audit log 대상으로 설계한다.
- 학생/직원 이름은 성공 음성으로 출력하지 않는다.

## 다음 Phase

- Phase 2: 학생 상세 read model 확장
- Phase 3: clinic_item_templates / clinic_tasks / clinic_logs 설계
- Phase 4: 단어시험 결과 입력 및 후보 클리닉 생성
- Phase 5: 학부모 일간/주간 리포트 링크
- Phase 6: parent_accounts / parent_student_links 기반 로그인 포털
