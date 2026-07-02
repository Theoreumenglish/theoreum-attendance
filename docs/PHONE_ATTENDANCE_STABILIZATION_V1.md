# phone-attendance-stabilization-v1

## Purpose

This patch closes the production deep QA failures around phone-based attendance.

Priority:
1. Student phone-tail kiosk input must not lose digits.
2. Staff/teacher phone-tail clock-in/out must work even when the staff account exists only in CentralDB and has not yet been fully mirrored into Supabase `staff` / `staff_snapshot`.
3. Production deep QA must automatically create a screenshot bundle so the operator does not manually compress dozens of images.

## Changes

### Kiosk physical-keyboard input

The segmented `010-[4]-[4]` inputs now write numeric key presses manually from `keydown`.
This fixes the previous bug where `preventDefault()` blocked the native input update, causing QA to report `mid=, last=`.

### Staff phone directory

A new additive table is introduced:

- `public.staff_phone_directory`

It stores normalized staff phone numbers for phone-tail attendance. It is intentionally separate from auth secrets and does not store passwords/PINs.

CentralDB staff save now writes the phone number into:

- CentralDB bridge staff payload
- Supabase `staff_phone_directory`
- Existing Supabase `staff` / `staff_snapshot` phone-like columns when matching rows exist

The staff clock endpoint now checks these sources in order:

1. `staff_phone_directory`
2. `staff_snapshot`
3. `staff`

### Production deep QA

`npm run prod:qa:deep` and `npm run prod:qa:deep:write` now:

- automatically create `_logs/PRODUCTION_DEEP_QA_BUNDLE.zip`
- resolve QA student ID from `admin.master.searchStudents` `data.items`
- avoid false login failure when `#loginMsg` exists but is hidden
- ignore hidden modal/drawer overflow in DOM audit
- in write mode, try to ensure the QA staff phone directory before staff phone clock testing

## SQL

Apply:

```txt
docs/supabase-staff-phone-v1.sql
```

This SQL is safe and additive: it uses `alter table if exists`, `create table if not exists`, and `create index if not exists`.

## Validation

Run:

```txt
npm run verify
npm run prod:qa:deep:write
```

Expected improvement:

- kiosk phone input failure should disappear
- admin page login false failure should disappear
- `admin.lectureAssignment.list` should not be called with blank `student_id`
- staff phone clock should pass after QA staff phone directory is created or after saving the staff phone once in CentralDB staff management
- screenshot zip should be generated automatically
