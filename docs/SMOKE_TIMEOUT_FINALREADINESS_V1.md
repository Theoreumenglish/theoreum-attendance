# SMOKE_TIMEOUT_FINALREADINESS_V1

## Purpose
Production `admin.finalReadiness` can legitimately take longer than the default smoke-test timeout because it aggregates several operational checks. Deep QA showed the page/API itself is healthy, but one-click release failed when the live smoke test timed out on this single operation.

## Changes
- Default smoke-test timeout increased from 10s to 15s.
- Slow smoke timeout added: `SMOKE_SLOW_TIMEOUT_MS`, default 35s.
- `admin.finalReadiness` now uses the slow timeout.
- Smoke output now prints default/slow timeout values.
- Timeout failure summaries now include a clearer next-action hint.

## No DB change
No Supabase SQL is required.

## Manual override
PowerShell example:

```powershell
$env:SMOKE_TIMEOUT_MS="15000"
$env:SMOKE_SLOW_TIMEOUT_MS="45000"
npm run smoke-test
```
