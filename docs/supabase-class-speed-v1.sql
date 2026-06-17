-- TheOreum class list / portal speed indexes v1
-- Safe to re-run. Adds indexes only; does not change data.

create index if not exists idx_classes_status_start_id
  on public.classes (status, start, class_id);

create index if not exists idx_classes_teacher_status
  on public.classes (teacher, status);

create index if not exists idx_class_schedule_ymd_status_start
  on public.class_schedule (yyyymmdd, status, start, class_id);

create index if not exists idx_class_students_class_student
  on public.class_students (class_id, student_id);

create index if not exists idx_class_students_student_class
  on public.class_students (student_id, class_id);

create index if not exists idx_staff_sessions_token_hash
  on public.staff_sessions (session_token_hash);

create index if not exists idx_staff_snapshot_staff_id
  on public.staff_snapshot (staff_id);

create index if not exists idx_staff_staff_id
  on public.staff (staff_id);

create index if not exists idx_students_name_id
  on public.students (student_name, student_id);

create index if not exists idx_students_status_id
  on public.students (status, student_id);
