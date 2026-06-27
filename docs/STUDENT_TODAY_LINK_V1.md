# student-today-link-v1

## Goal
Create the first lightweight student mobile portal without building a native app.

## What this adds
- Admin can create a 7-day student today link from Student 360.
- Link opens `/student-today.html?t=...`.
- Public page shows limited student-safe data:
  - today attendance state
  - visible or actionable clinic items
  - recent word records
  - online lecture placeholder for the next phase
- Tokens are stored as SHA-256 hashes only.

## What this does not add yet
- Native student app
- Parent portal
- Online lecture assignment management
- Payment features
- Internal memo exposure

## SQL
Apply:

```txt
./docs/supabase-student-today-link-v1.sql
```

## Security rules
- Do not store raw tokens in DB.
- Links expire by default after 7 days.
- Public output must not include phone numbers, parent phones, internal notes, staff memo, or audit logs.
- Link access count is recorded for operational awareness.
