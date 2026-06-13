-- TheOreum Clinic Auto Notification v1
-- Run this in Supabase SQL Editor BEFORE deploying the app patch.
-- Purpose:
-- 1) restore clinic task types to CLASS_CLINIC / EXTRA_CLINIC / INDIVIDUAL_CLINIC
-- 2) add offline clinic schedule fields
-- 3) guarantee student_phone exists for student KakaoTalk/SMS routing
-- 4) support scheduled clinic queues using occurred_at as send_at

alter table if exists public.students
add column if not exists student_phone text not null default '';

alter table if exists public.clinic_tasks
add column if not exists due_time text not null default '';

alter table if exists public.clinic_tasks
add column if not exists due_at timestamp with time zone;

alter table if exists public.clinic_tasks
add column if not exists clinic_mode text not null default 'OFFLINE';

alter table if exists public.clinic_tasks
add column if not exists auto_notice_enabled boolean not null default true;

-- Normalize legacy task types before tightening the constraint.
update public.clinic_tasks
set task_type = case
  when task_type in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC') then task_type
  when task_type in ('WORD','HOMEWORK','MAKEUP') then 'EXTRA_CLINIC'
  when task_type in ('GRAMMAR','READING','WRITING') then 'CLASS_CLINIC'
  else 'INDIVIDUAL_CLINIC'
end
where task_type is null
   or task_type not in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC');

alter table if exists public.clinic_tasks
drop constraint if exists clinic_tasks_type_chk;

alter table public.clinic_tasks
add constraint clinic_tasks_type_chk
check (task_type in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC'));

alter table if exists public.clinic_tasks
drop constraint if exists clinic_tasks_mode_chk;

alter table public.clinic_tasks
add constraint clinic_tasks_mode_chk
check (clinic_mode in ('OFFLINE','ONLINE'));

alter table if exists public.clinic_tasks
drop constraint if exists clinic_tasks_due_time_chk;

alter table public.clinic_tasks
add constraint clinic_tasks_due_time_chk
check (due_time = '' or due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

alter table if exists public.clinic_item_templates
add column if not exists task_type text not null default 'INDIVIDUAL_CLINIC';

update public.clinic_item_templates
set task_type = case
  when task_type in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC') then task_type
  when task_type in ('WORD','HOMEWORK','MAKEUP') then 'EXTRA_CLINIC'
  when task_type in ('GRAMMAR','READING','WRITING') then 'CLASS_CLINIC'
  else 'INDIVIDUAL_CLINIC'
end
where task_type is null
   or task_type not in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC');

alter table if exists public.clinic_item_templates
drop constraint if exists clinic_item_templates_task_type_chk;

alter table public.clinic_item_templates
add constraint clinic_item_templates_task_type_chk
check (task_type in ('CLASS_CLINIC','EXTRA_CLINIC','INDIVIDUAL_CLINIC'));

create index if not exists idx_clinic_tasks_mode_due
on public.clinic_tasks(clinic_mode, due_date, due_time, status);

create index if not exists attendance_notify_queue_status_occurred_idx
on public.attendance_notify_queue(status, occurred_at, created_at);

-- Quick verification
select
  to_regclass('public.students') as students,
  to_regclass('public.clinic_tasks') as clinic_tasks,
  to_regclass('public.attendance_notify_queue') as attendance_notify_queue;
