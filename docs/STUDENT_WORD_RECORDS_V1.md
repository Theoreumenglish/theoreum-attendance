# student-word-records-v1

## 목적

기존 `word_test_sessions` / `word_test_results` 흐름을 유지하면서, 학생별 단어 수행 이력을 누적 조회할 수 있는 `word_records` 기반을 추가한다.

이번 단계는 UI 전면 개편이 아니라 데이터 기반 패치다. 기존 단어시험 입력 화면은 그대로 사용하고, 저장 시 `word_records`에 mirror 기록을 남긴다.

## 핵심 원칙

- 기존 `wordTest.*` API와 기존 테이블을 삭제하지 않는다.
- `word_records`는 학생 중심 누적 기록이다.
- 단어 원문/뜻은 저장하지 않는다.
- 저장 기준은 `맞은 개수 / 전체 개수`다.
- 통과 기준은 기본적으로 전체 단어 수의 90% 이상이다.
- 불통과는 `word_needs_retest=true`, `word_needs_clinic=true`로 남긴다.

## 추가 테이블

- `word_records`

주요 컬럼:

- `student_id`
- `class_id`
- `session_id`
- `result_id`
- `book_id`
- `range_id`
- `scope_text`
- `yyyymmdd`
- `word_total_count`
- `word_correct_count`
- `word_pass_count`
- `word_accuracy`
- `result_status`
- `word_passed`
- `word_needs_retest`
- `word_needs_clinic`
- `clinic_task_id`

## 추가 API

### wordRecord.list

학생별 단어 누적 기록을 조회한다.

필터:

- `student_id`
- `session_id`
- `result_status`
- `start_ymd`
- `end_ymd`
- `needs_retest`
- `needs_clinic`
- `limit`

## 기존 기능 영향

기존 단어시험 결과 저장은 계속 `word_test_results`에 저장된다. `word_records` 저장은 mirror 방식이다.

`word_records` 테이블이 아직 없거나 schema cache가 갱신되지 않은 경우에도 기존 단어 저장은 실패하지 않는다. 이 경우 응답에 `word_record_warning`만 포함된다.

## 다음 단계

1. `docs/supabase-student-word-records-v1.sql` 적용
2. `wordRecord.list` live smoke 확인
3. 학생360에 최근 단어 누적 기록 노출
4. 운영보드에 재시험/클리닉 후보 카운트 연결
5. 리포트에 단어 추이 문장 생성 기반으로 연결
