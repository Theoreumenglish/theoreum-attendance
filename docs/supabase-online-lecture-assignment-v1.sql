-- TheOreum online lecture assignment schema v1
-- Safe additive migration only.
-- Purpose: assign external online lecture links to students and expose visible items in student today links.

create extension if not exists pgcrypto;

create table if not exists public.student_lecture_assignments (
  assignment_id text primary key default gen_random_uuid()::text,
  student_id text not null,
  title text not null,
  url text not null,
  due_date text,
  status text not null default 'ACTIVE',
  visible_to_student boolean not null default true,
  note text not null default '',
  completed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  archived_by text,
  archived_at timestamptz,
  meta_json jsonb not null default '{}'::jsonb,
  constraint student_lecture_assignments_student_chk check (length(trim(student_id)) > 0),
  constraint student_lecture_assignments_title_chk check (length(trim(title)) > 0),
  constraint student_lecture_assignments_url_chk check (url ~* '^https?://'),
  constraint student_lecture_assignments_due_chk check (due_date is null or due_date ~ '^[0-9]{8}$'),
  constraint student_lecture_assignments_status_chk check (status in ('ACTIVE','COMPLETED','ARCHIVED'))
);

create index if not exists idx_student_lecture_assignments_student_status
  on public.student_lecture_assignments (student_id, status, due_date, updated_at desc);

create index if not exists idx_student_lecture_assignments_visible
  on public.student_lecture_assignments (student_id, visible_to_student, status, due_date);

create index if not exists idx_student_lecture_assignments_updated
  on public.student_lecture_assignments (updated_at desc);
