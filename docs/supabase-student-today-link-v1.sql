-- TheOreum student today link foundation v1
-- Safe additive migration only.
-- Stores hashed public link tokens for student mobile link access.

create extension if not exists pgcrypto;

create table if not exists public.student_today_links (
  link_id text primary key default gen_random_uuid()::text,
  student_id text not null,
  audience text not null default 'STUDENT',
  token_hash text not null,
  token_prefix text not null default '',
  status text not null default 'ACTIVE',
  expires_at timestamptz not null,
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  meta_json jsonb not null default '{}'::jsonb,
  constraint student_today_links_student_chk check (length(trim(student_id)) > 0),
  constraint student_today_links_hash_chk check (length(trim(token_hash)) >= 32),
  constraint student_today_links_audience_chk check (audience in ('STUDENT','PARENT')),
  constraint student_today_links_status_chk check (status in ('ACTIVE','REVOKED','EXPIRED'))
);

create unique index if not exists idx_student_today_links_token_hash
  on public.student_today_links (token_hash);

create index if not exists idx_student_today_links_student_status
  on public.student_today_links (student_id, status, expires_at desc);

create index if not exists idx_student_today_links_expires
  on public.student_today_links (status, expires_at);
