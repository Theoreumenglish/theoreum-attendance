-- 더오름 운영 포털 master-data + speed v2
-- 목적: 학생/클래스/반배정 조회와 포털 CRUD 후 replica 확인 속도 개선
-- 안전성: CREATE INDEX IF NOT EXISTS만 사용하므로 반복 실행 가능

create index if not exists idx_students_student_id_master_v2
  on public.students (student_id);

create index if not exists idx_students_name_master_v2
  on public.students (student_name);

create index if not exists idx_students_phone_master_v2
  on public.students (student_phone);

create index if not exists idx_students_parent_phone_master_v2
  on public.students (parent_phone);

create index if not exists idx_students_status_master_v2
  on public.students (status);

create index if not exists idx_classes_class_id_master_v2
  on public.classes (class_id);

create index if not exists idx_classes_status_start_master_v2
  on public.classes (status, start);

create index if not exists idx_classes_teacher_master_v2
  on public.classes (teacher);

create index if not exists idx_class_students_class_sid_master_v2
  on public.class_students (class_id, student_id);

create index if not exists idx_class_students_sid_class_master_v2
  on public.class_students (student_id, class_id);

create index if not exists idx_class_schedule_ymd_class_master_v2
  on public.class_schedule (yyyymmdd, class_id);

create index if not exists idx_staff_sessions_token_expire_master_v2
  on public.staff_sessions (session_token_hash, expires_at, revoked_at);
