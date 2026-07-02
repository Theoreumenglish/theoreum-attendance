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


-- v2: phone attendance directory for centralDB-only staff.
-- This table lets staff/teacher phone clock-in work even when a centralDB account
-- exists before the Supabase staff/staff_snapshot mirror row is populated.
create table if not exists public.staff_phone_directory (
  staff_id text primary key,
  name text not null default '',
  role text not null default 'assistant',
  status text not null default 'active',
  revoked text not null default 'N',
  staff_phone text not null,
  source text not null default 'central_staff_upsert',
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  meta_json jsonb not null default '{}'::jsonb,
  constraint staff_phone_directory_phone_chk check (staff_phone ~ '^010[0-9]{8}$'),
  constraint staff_phone_directory_revoked_chk check (revoked in ('Y','N'))
);

create index if not exists idx_staff_phone_directory_phone
  on public.staff_phone_directory (staff_phone);

create index if not exists idx_staff_phone_directory_status
  on public.staff_phone_directory (status, revoked);
