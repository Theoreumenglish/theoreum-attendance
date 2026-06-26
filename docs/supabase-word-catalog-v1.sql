-- TheOreum Word Catalog schema v1
-- 목적: 단어 원문/뜻을 저장하지 않고, 단어책/범위/단어 수 catalog만 운영 DB에 둔다.
-- 적용 시점: student-word-records-v1 또는 word-catalog-menu-redesign-v1 적용 전후
-- 안전 원칙: additive migration only. 기존 word_test_sessions / word_test_results는 삭제하지 않는다.

create extension if not exists pgcrypto;

create table if not exists public.word_books (
  book_id text primary key default gen_random_uuid()::text,
  academy_id text,
  book_key text not null,
  book_title text not null,
  publisher text not null default '',
  level text not null default '',
  status text not null default 'ACTIVE',
  sort_order integer not null default 0,
  source text not null default 'MANUAL',
  memo text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint word_books_key_chk check (length(trim(book_key)) > 0),
  constraint word_books_title_chk check (length(trim(book_title)) > 0),
  constraint word_books_status_chk check (status in ('ACTIVE','INACTIVE'))
);

create unique index if not exists idx_word_books_academy_key
  on public.word_books (coalesce(academy_id, '_theoreum_default'), book_key);
create index if not exists idx_word_books_status_sort
  on public.word_books (status, sort_order, book_title);

create table if not exists public.word_book_ranges (
  range_id text primary key default gen_random_uuid()::text,
  academy_id text,
  book_id text not null references public.word_books(book_id) on delete restrict,
  range_key text not null,
  range_label text not null,
  start_index integer,
  end_index integer,
  word_count integer not null,
  status text not null default 'ACTIVE',
  sort_order integer not null default 0,
  source text not null default 'MANUAL',
  memo text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint word_book_ranges_key_chk check (length(trim(range_key)) > 0),
  constraint word_book_ranges_label_chk check (length(trim(range_label)) > 0),
  constraint word_book_ranges_count_chk check (word_count > 0),
  constraint word_book_ranges_status_chk check (status in ('ACTIVE','INACTIVE')),
  constraint word_book_ranges_index_chk check (
    start_index is null or end_index is null or start_index <= end_index
  )
);

create unique index if not exists idx_word_book_ranges_book_key
  on public.word_book_ranges (book_id, range_key);
create index if not exists idx_word_book_ranges_book_sort
  on public.word_book_ranges (book_id, status, sort_order, range_label);
create index if not exists idx_word_book_ranges_count
  on public.word_book_ranges (word_count);

comment on table public.word_books is '단어책 catalog. 단어 원문/뜻은 저장하지 않고 책 단위 metadata만 저장한다.';
comment on table public.word_book_ranges is '단어책별 범위 catalog. 범위 label과 전체 단어 수만 저장한다.';
