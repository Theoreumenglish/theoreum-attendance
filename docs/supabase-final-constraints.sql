-- TheOreum Attendance - final constraints and indexes
-- Run carefully in Supabase SQL Editor.

create unique index if not exists attendance_logs_trace_id_ux
on public.attendance_logs(trace_id)
where trace_id is not null and trace_id <> '';

create unique index if not exists attendance_notify_queue_trace_action_ux
on public.attendance_notify_queue(trace_id, action_type)
where trace_id is not null and trace_id <> ''
  and action_type is not null and action_type <> '';

create unique index if not exists staff_daily_ymd_staff_ux
on public.staff_daily(yyyymmdd, staff_id);

create unique index if not exists staff_monthly_ym_staff_ux
on public.staff_monthly(yyyymm, staff_id);

create unique index if not exists student_qr_sessions_token_ux
on public.student_qr_sessions(token);

create unique index if not exists staff_qr_sessions_token_ux
on public.staff_qr_sessions(token);

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