# DEV_CONVENIENCE_SUITE_V1

## Purpose

This patch adds developer-convenience tools so the operator does not need to keep copying long PowerShell blocks or scrolling terminal output.

## Added commands

```powershell
npm run dev:doctor
npm run dev:quick-check
npm run dev:apply-patch -- -PatchZip "$env:USERPROFILE\Downloads\some-patch.zip" -CommitMessage "feat: message"
npm run dev:rollback-latest
npm run copy-last-log
```

## Main workflows

### 1. Send current project state to ChatGPT

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"; npm run dev:doctor
```

This creates and copies:

```txt
_logs/DEV_DOCTOR_TO_SEND.txt
```

It includes git status, branch, recent commits, Node/npm version, required file checks, and a Vercel/Supabase/GitHub/OpenAI/Google Drive surface checklist. It does not copy secret values.

### 2. Fast local verification before asking for a patch

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"; npm run dev:quick-check
```

This runs:

```txt
git status
npm run check
npm run verify
npm run build
```

Success and failure summaries are saved under `_logs`.

### 3. Apply future patch zip with one short command

Instead of running long patch commands, use:

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"; npm run dev:apply-patch -- -PatchZip "$env:USERPROFILE\Downloads\PATCH_NAME.zip" -CommitMessage "commit message"
```

The helper:

- extracts the patch zip
- finds `patch-files`
- backs up changed files
- copies files directly, avoiding Korean path issues in `APPLY_PATCH.ps1`
- writes `_logs/LAST_PATCH_APPLY.txt`
- runs `scripts/one-click-release.ps1` unless `-ApplyOnly` is passed

### 4. Roll back the latest patch backup

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"; npm run dev:rollback-latest
```

This restores the latest `_patch_backup_*` folder and runs `npm run verify`.

## Surface checklist

For every development patch, consider:

- Vercel: Node runtime, build, deployment, smoke-test
- Supabase: schema, migration, indexes, RLS/privacy, data integrity
- GitHub: branch, commit, push, release zip
- OpenAI Platform: only when API/key/model/AI features are touched
- Google Drive: only when docs/sheets/slides/drive backup or file handoff is touched

## Secret safety

The tools must not commit:

```txt
.env*
.env.smoke.local
_logs/
```

Release zip generation must exclude logs and local env files.
