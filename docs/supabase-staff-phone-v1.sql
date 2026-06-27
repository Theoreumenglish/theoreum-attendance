-- TheOreum staff phone support v1
-- Safe additive migration only. Supports staff phone-tail clock-in/out and phone identity audit.

alter table if exists public.staff
  add column if not exists staff_phone text;

alter table if exists public.staff_snapshot
  add column if not exists staff_phone text;

create index if not exists idx_staff_staff_phone
  on public.staff (staff_phone);

create index if not exists idx_staff_snapshot_staff_phone
  on public.staff_snapshot (staff_phone);
