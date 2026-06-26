# WORD_CATALOG_FOUNDATION_V1

문서 버전: v1  
마지막 업데이트일: 2026-06-25  
관련 패치: word-catalog-foundation-v1

## 목표

`student-word-records-v1`에 들어가기 전에 단어책/범위 catalog 기반을 먼저 추가한다.

핵심 원칙:

- 단어 원문과 뜻은 현재 앱 DB에 저장하지 않는다.
- 운영에 필요한 것은 단어책, 범위, 전체 단어 수, 학생별 정답 개수다.
- 기존 `word_test_sessions` / `word_test_results`는 호환성을 위해 유지한다.
- `wordCatalog.list`는 DB 테이블이 아직 없어도 500으로 깨지지 않고 빈 fallback을 반환한다.

## 추가된 API

```txt
op: wordCatalog.list
권한: assistant 이상
목적: word_books / word_book_ranges catalog 조회
개인정보 포함: 없음
fallback: word_books 또는 word_book_ranges 미적용 시 빈 seed fallback
```

응답 요약:

```json
{
  "ok": true,
  "data": {
    "source": "SUPABASE" 또는 "SEED_FALLBACK_EMPTY",
    "seed_fallback": false,
    "books": [],
    "ranges": [],
    "count_books": 0,
    "count_ranges": 0,
    "warnings": []
  }
}
```

## 추가된 SQL

```txt
docs/supabase-word-catalog-v1.sql
```

추가 테이블:

- `word_books`
- `word_book_ranges`

## 운영 주의

- 이 패치는 런타임 코드와 문서를 추가하지만 운영 DB를 자동 변경하지 않는다.
- SQL은 Supabase SQL Editor에서 별도 적용해야 한다.
- 실제 catalog seed는 `db_Cvoca.xlsx` 같은 원천 파일에서 단어책/범위/word_count만 추출해 넣어야 한다.
- seed 생성 시 단어 원문/뜻은 운영 catalog에 넣지 않는다.
