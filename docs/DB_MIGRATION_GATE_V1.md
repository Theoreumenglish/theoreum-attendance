# DB Migration Gate v1

Purpose: prevent code that depends on new Supabase SQL from being deployed before the SQL is applied.

## What it catches

When `npm run dev:apply-patch` applies a patch containing `docs/supabase-*.sql`, the release is paused before verify/deploy/smoke.

Generated files:

- `_logs/LAST_SQL_TO_APPLY.txt`: copy-ready SQL bundle for Supabase SQL Editor.
- `_logs/PENDING_SQL_MIGRATIONS.txt`: local marker that blocks `one-click-release`.
- `_logs/LAST_SQL_GATE_TO_SEND.txt`: copy-ready explanation to send back for debugging.

## Normal flow

```powershell
npm run dev:apply-patch -- -PatchZip "$env:USERPROFILE\Downloads\some-patch.zip" -CommitMessage "feat: add db backed feature"
```

If SQL is required, the command stops before deploy. Apply the SQL in Supabase, then run:

```powershell
npm run dev:release -- -CommitMessage "feat: add db backed feature" -SqlApplied
```

## Why this matters

The app can build successfully even when production Supabase is missing a new table. Without this gate, the live smoke-test fails after deployment.
