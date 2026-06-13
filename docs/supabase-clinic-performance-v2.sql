-- TheOreum Clinic / Word / Notify performance hardening v2
-- Safe to re-run. This file adds indexes only and does not change existing data.

create index if not exists idx_clinic_tasks_due_status_type
  on public.clinic_tasks (due_date, status, task_type);

create index if not exists idx_clinic_tasks_source_group
  on public.clinic_tasks (source_id, class_id, due_date, task_type);

create index if not exists idx_clinic_tasks_student_due
  on public.clinic_tasks (student_id, due_date, status);

create index if not exists idx_clinic_tasks_class_due
  on public.clinic_tasks (class_id, due_date, status);

create index if not exists idx_clinic_logs_task_created
  on public.clinic_logs (clinic_task_id, created_at desc);

create index if not exists idx_word_test_results_session_student
  on public.word_test_results (session_id, student_id);

create index if not exists idx_word_test_results_student_created
  on public.word_test_results (student_id, created_at desc);

create index if not exists idx_attendance_notify_queue_status_due
  on public.attendance_notify_queue (status, occurred_at, action_type);

create index if not exists idx_attendance_notify_queue_clinic_trace
  on public.attendance_notify_queue (trace_id, action_type)
  where action_type like 'CLINIC_%';

create index if not exists idx_portal_audit_logs_op_created
  on public.portal_audit_logs (op, created_at desc);
