-- TheOreum Attendance - final constraints and indexes
-- Run carefully in Supabase SQL Editor.
-- Pre-check duplicate rows before creating unique indexes.

select trace_id, count(*) as cnt
from public.attendance_logs
where trace_id is not null and trace_id <> ''
group by trace_id
having count(*) > 1;

select trace_id, action_type, count(*) as cnt
from public.attendance_notify_queue
where trace_id is not null and trace_id <> ''
  and action_type is not null and action_type <> ''
group by trace_id, action_type
having count(*) > 1;

select yyyymmdd, student_id, count(*) as cnt
from public.today_student_state
group by yyyymmdd, student_id
having count(*) > 1;

create unique index if not exists attendance_logs_trace_id_ux
on public.attendance_logs(trace_id)
where trace_id is not null and trace_id <> '';

create unique index if not exists attendance_notify_queue_trace_action_ux
on public.attendance_notify_queue(trace_id, action_type)
where trace_id is not null and trace_id <> ''
  and action_type is not null and action_type <> '';

create unique index if not exists today_student_state_ymd_student_ux
on public.today_student_state(yyyymmdd, student_id);

alter table if exists public.replica_sync_status
add column if not exists counts_json jsonb not null default '{}'::jsonb;

create unique index if not exists replica_sync_status_sync_key_ux
on public.replica_sync_status(sync_key);

create unique index if not exists staff_daily_ymd_staff_ux
on public.staff_daily(yyyymmdd, staff_id);

create unique index if not exists staff_monthly_ym_staff_ux
on public.staff_monthly(yyyymm, staff_id);

alter table if exists public.student_qr_sessions
add column if not exists anchor_ms bigint not null default 0;

alter table if exists public.student_qr_sessions
add column if not exists student_name text not null default '';

create unique index if not exists student_qr_sessions_token_ux
on public.student_qr_sessions(token);

alter table if exists public.staff_qr_sessions
add column if not exists staff_name text not null default '';

alter table if exists public.staff_qr_sessions
add column if not exists role text not null default '';

create unique index if not exists staff_qr_sessions_token_ux
on public.staff_qr_sessions(token);

create index if not exists staff_qr_nonces_session_used_exp_idx
on public.staff_qr_nonces(staff_id, public_session_id, used, exp_ms);

create index if not exists student_qr_nonces_session_used_exp_idx
on public.student_qr_nonces(student_id, public_session_id, used, exp_ms);

create index if not exists student_qr_sessions_student_session_idx
on public.student_qr_sessions(student_id, public_session_id);

create index if not exists staff_qr_sessions_staff_session_idx
on public.staff_qr_sessions(staff_id, public_session_id);

create unique index if not exists student_qr_nonces_nonce_ux
on public.student_qr_nonces(nonce);

create unique index if not exists staff_qr_nonces_nonce_ux
on public.staff_qr_nonces(nonce);

create index if not exists attendance_logs_ymd_student_result_action_ts_idx
on public.attendance_logs(yyyymmdd, student_id, result, action_type, ts);

create index if not exists today_student_state_ymd_present_idx
on public.today_student_state(yyyymmdd, checked_in, checked_out);

create index if not exists class_schedule_ymd_status_idx
on public.class_schedule(yyyymmdd, status);

create index if not exists class_students_class_student_idx
on public.class_students(class_id, student_id);

create index if not exists absence_excuses_ymd_student_class_idx
on public.absence_excuses(yyyymmdd, student_id, class_id);

create index if not exists attendance_notify_queue_status_created_idx
on public.attendance_notify_queue(status, created_at);

create index if not exists absence_detection_runs_created_desc_idx
on public.absence_detection_runs(created_at desc);

create index if not exists notify_worker_runs_created_at_idx
on public.notify_worker_runs(created_at desc);

-- Central DB replica tables, columns, constraints, and indexes
-- Required for GAS Supabase REST upsert with on_conflict.

create table if not exists public.classes (
  class_id text not null,
  name text not null default '',
  teacher text not null default '',
  start text not null default '',
  "end" text not null default '',
  days_json text not null default '[]',
  room text not null default '',
  alert_delay text not null default '',
  alert_to text not null default '',
  status text not null default '',
  calendar_event_id text not null default '',
  created_at text not null default '',
  updated_at text not null default '',
  synced_at timestamp with time zone
);

alter table if exists public.classes
add column if not exists synced_at timestamp with time zone;

create table if not exists public.class_exceptions (
  class_id text not null,
  yyyymmdd text not null,
  reason text not null default '',
  created_at text not null default '',
  created_by text not null default '',
  updated_at text not null default '',
  updated_by text not null default '',
  synced_at timestamp with time zone
);

create table if not exists public.holidays (
  yyyymmdd text not null,
  name text not null default '',
  note text not null default '',
  created_at text not null default '',
  actor text not null default '',
  synced_at timestamp with time zone
);

alter table if exists public.students
add column if not exists synced_at timestamp with time zone;

alter table if exists public.staff
add column if not exists synced_at timestamp with time zone;

alter table if exists public.class_schedule
add column if not exists synced_at timestamp with time zone;

alter table if exists public.class_students
add column if not exists synced_at timestamp with time zone;

alter table if exists public.absence_excuses
add column if not exists synced_at timestamp with time zone;

alter table if exists public.class_exceptions
add column if not exists synced_at timestamp with time zone;

alter table if exists public.holidays
add column if not exists synced_at timestamp with time zone;

alter table if exists public.replica_sync_status
add column if not exists counts_json jsonb not null default '{}'::jsonb;

alter table if exists public.replica_sync_status
add column if not exists error text not null default '';

alter table if exists public.replica_sync_status
add column if not exists updated_at timestamp with time zone;

create unique index if not exists students_student_id_ux
on public.students(student_id);

create unique index if not exists staff_staff_id_ux
on public.staff(staff_id);

create unique index if not exists classes_class_id_ux
on public.classes(class_id);

create unique index if not exists class_schedule_ymd_class_ux
on public.class_schedule(yyyymmdd, class_id);

create unique index if not exists class_students_class_student_ux
on public.class_students(class_id, student_id);

create unique index if not exists class_exceptions_class_ymd_ux
on public.class_exceptions(class_id, yyyymmdd);

create unique index if not exists absence_excuses_class_ymd_student_ux
on public.absence_excuses(class_id, yyyymmdd, student_id);

create unique index if not exists holidays_ymd_ux
on public.holidays(yyyymmdd);

create unique index if not exists replica_sync_status_sync_key_ux
on public.replica_sync_status(sync_key);

create index if not exists classes_status_idx
on public.classes(status);

create index if not exists class_exceptions_ymd_idx
on public.class_exceptions(yyyymmdd);

create index if not exists holidays_ymd_idx
on public.holidays(yyyymmdd);

select pg_notify('pgrst', 'reload schema');
