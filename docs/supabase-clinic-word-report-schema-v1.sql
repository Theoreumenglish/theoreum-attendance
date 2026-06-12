-- TheOreum Clinic / Word Test / Report / Audit schema v1
-- 실행 순서: 기존 core schema + docs/supabase-final-constraints.sql 적용 후 실행
-- 목적: 클리닉 업무, 단어시험 결과, 학부모 리포트 스냅샷, 운영 감사 로그를 Supabase runtime table로 먼저 검증

create extension if not exists pgcrypto;

create table if not exists public.clinic_item_templates (
  template_id text primary key default gen_random_uuid()::text,
  title text not null,
  task_type text not null default 'GENERAL',
  default_priority text not null default 'NORMAL',
  default_internal_note text not null default '',
  default_parent_note text not null default '',
  is_active text not null default 'Y',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinic_item_templates_task_type_chk check (task_type in ('GENERAL','WORD','GRAMMAR','READING','WRITING','ATTENDANCE','HOMEWORK','MAKEUP')),
  constraint clinic_item_templates_priority_chk check (default_priority in ('LOW','NORMAL','HIGH','URGENT')),
  constraint clinic_item_templates_active_chk check (is_active in ('Y','N'))
);

create table if not exists public.clinic_tasks (
  clinic_task_id text primary key default gen_random_uuid()::text,
  student_id text not null,
  class_id text,
  title text not null,
  task_type text not null default 'GENERAL',
  source_type text not null default 'MANUAL',
  source_id text,
  status text not null default 'CANDIDATE',
  priority text not null default 'NORMAL',
  due_date date,
  assigned_staff_id text,
  internal_note text not null default '',
  parent_note text not null default '',
  parent_visible boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint clinic_tasks_student_id_chk check (student_id ~ '^\d{4}$'),
  constraint clinic_tasks_type_chk check (task_type in ('GENERAL','WORD','GRAMMAR','READING','WRITING','ATTENDANCE','HOMEWORK','MAKEUP')),
  constraint clinic_tasks_source_chk check (source_type in ('MANUAL','WORD_FAIL','ATTENDANCE','ABSENCE','HOMEWORK','REPORT')),
  constraint clinic_tasks_status_chk check (status in ('CANDIDATE','PENDING','IN_PROGRESS','DONE','PARTIAL','REJECTED','CANCELLED')),
  constraint clinic_tasks_priority_chk check (priority in ('LOW','NORMAL','HIGH','URGENT'))
);

create index if not exists idx_clinic_tasks_student_updated on public.clinic_tasks(student_id, updated_at desc);
create index if not exists idx_clinic_tasks_status_due on public.clinic_tasks(status, due_date, updated_at desc);
create index if not exists idx_clinic_tasks_source on public.clinic_tasks(source_type, source_id);

create table if not exists public.clinic_logs (
  clinic_log_id text primary key default gen_random_uuid()::text,
  clinic_task_id text not null,
  event_type text not null,
  before_status text,
  after_status text,
  internal_note text not null default '',
  parent_note text not null default '',
  parent_visible boolean not null default false,
  actor_staff_id text,
  created_at timestamptz not null default now(),
  constraint clinic_logs_event_type_chk check (event_type in ('CREATE','STATUS_CHANGE','NOTE','DELETE','AUTO_CREATED'))
);

create index if not exists idx_clinic_logs_task_created on public.clinic_logs(clinic_task_id, created_at desc);

create table if not exists public.word_test_sessions (
  session_id text primary key default gen_random_uuid()::text,
  title text not null,
  yyyymmdd text not null,
  class_id text,
  scope_text text not null default '',
  pass_score numeric not null default 90,
  max_score numeric not null default 100,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint word_test_sessions_yyyymmdd_chk check (yyyymmdd ~ '^\d{8}$'),
  constraint word_test_sessions_scores_chk check (pass_score >= 0 and max_score > 0 and pass_score <= max_score)
);

create index if not exists idx_word_test_sessions_date_class on public.word_test_sessions(yyyymmdd desc, class_id);

create table if not exists public.word_test_results (
  result_id text primary key default gen_random_uuid()::text,
  session_id text not null,
  student_id text not null,
  score numeric,
  max_score numeric not null default 100,
  pass_score numeric not null default 90,
  result_status text not null default 'PASS',
  clinic_task_id text,
  note text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint word_test_results_student_id_chk check (student_id ~ '^\d{4}$'),
  constraint word_test_results_status_chk check (result_status in ('PASS','FAIL','ABSENT','EXEMPT')),
  constraint word_test_results_score_chk check (score is null or (score >= 0 and score <= max_score)),
  constraint word_test_results_unique unique (session_id, student_id)
);

create index if not exists idx_word_test_results_student_created on public.word_test_results(student_id, updated_at desc);
create index if not exists idx_word_test_results_session_status on public.word_test_results(session_id, result_status);
create index if not exists idx_word_test_results_clinic on public.word_test_results(clinic_task_id);

create table if not exists public.report_snapshots (
  report_id text primary key default gen_random_uuid()::text,
  student_id text not null,
  period_type text not null default 'WEEKLY',
  period_start text not null,
  period_end text not null,
  summary_json jsonb not null default '{}'::jsonb,
  parent_note text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  constraint report_snapshots_student_id_chk check (student_id ~ '^\d{4}$'),
  constraint report_snapshots_period_type_chk check (period_type in ('DAILY','WEEKLY','MONTHLY','CUSTOM'))
);

create index if not exists idx_report_snapshots_student_period on public.report_snapshots(student_id, period_start desc, period_end desc);

create table if not exists public.report_links (
  report_link_id text primary key default gen_random_uuid()::text,
  report_id text not null,
  token_hash text not null,
  expires_at timestamptz,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists idx_report_links_report on public.report_links(report_id);
create unique index if not exists idx_report_links_token_hash on public.report_links(token_hash);

create table if not exists public.portal_audit_logs (
  audit_id text primary key default gen_random_uuid()::text,
  actor_staff_id text,
  actor_role text,
  actor_name text,
  op text not null,
  target_type text,
  target_id text,
  action text not null,
  before_json jsonb not null default '{}'::jsonb,
  after_json jsonb not null default '{}'::jsonb,
  meta_json jsonb not null default '{}'::jsonb,
  trace_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_portal_audit_created on public.portal_audit_logs(created_at desc);
create index if not exists idx_portal_audit_actor on public.portal_audit_logs(actor_staff_id, created_at desc);
create index if not exists idx_portal_audit_target on public.portal_audit_logs(target_type, target_id, created_at desc);
create index if not exists idx_portal_audit_op on public.portal_audit_logs(op, created_at desc);
