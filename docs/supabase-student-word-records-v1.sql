-- TheOreum student word records schema v1
-- Purpose: Add cumulative student-level word records.
-- Safe migration: additive only.
-- Existing word_test_sessions and word_test_results are preserved.

create extension if not exists pgcrypto;

create table if not exists public.word_records (
  record_id text primary key default gen_random_uuid()::text,
  academy_id text,
  student_id text not null,
  class_id text,
  session_id text,
  result_id text,
  book_id text,
  range_id text,
  word_book_title text not null default '',
  range_label text not null default '',
  scope_text text not null default '',
  yyyymmdd text not null,
  word_total_count integer not null,
  word_correct_count integer,
  word_pass_count integer not null,
  word_accuracy numeric(6,2),
  result_status text not null default 'PASS',
  word_passed boolean not null default false,
  word_needs_retest boolean not null default false,
  word_needs_clinic boolean not null default false,
  clinic_task_id text,
  attempt_no integer not null default 1,
  source text not null default 'wordTest.mirror',
  note text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint word_records_student_chk check (length(trim(student_id)) > 0),
  constraint word_records_ymd_chk check (yyyymmdd ~ '^[0-9]{8}$'),
  constraint word_records_total_chk check (word_total_count > 0),
  constraint word_records_correct_chk check (
    word_correct_count is null
    or (
      word_correct_count >= 0
      and word_correct_count <= word_total_count
    )
  ),
  constraint word_records_pass_chk check (
    word_pass_count >= 0
    and word_pass_count <= word_total_count
  ),
  constraint word_records_status_chk check (
    result_status in ('PASS','FAIL','ABSENT','EXEMPT')
  ),
  constraint word_records_attempt_chk check (attempt_no > 0)
);

create unique index if not exists idx_word_records_session_student
  on public.word_records (session_id, student_id);

create index if not exists idx_word_records_student_ymd
  on public.word_records (student_id, yyyymmdd desc, updated_at desc);

create index if not exists idx_word_records_class_ymd
  on public.word_records (class_id, yyyymmdd desc);

create index if not exists idx_word_records_result_status
  on public.word_records (result_status, yyyymmdd desc);

create index if not exists idx_word_records_retest
  on public.word_records (word_needs_retest, yyyymmdd desc);

create index if not exists idx_word_records_clinic
  on public.word_records (word_needs_clinic, yyyymmdd desc);

create index if not exists idx_word_records_book_range
  on public.word_records (book_id, range_id, yyyymmdd desc);
