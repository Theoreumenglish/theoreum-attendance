# deep-qa-full-package-v1

## Purpose

Deep QA should give ChatGPT both the production QA result and the exact local code snapshot without making the operator manually zip screenshots and source files.

## What is generated

Every `npm run prod:qa:deep` or `npm run prod:qa:deep:write` run now creates these timestamped files in `_logs`:

- `PRODUCTION_DEEP_QA_BUNDLE_<runId>.zip`
  - screenshots, DOM JSON, QA reports
- `PRODUCTION_DEEP_QA_SOURCE_<runId>.zip`
  - source snapshot for code review
- `PRODUCTION_DEEP_QA_PACKAGE_<runId>.zip`
  - full package containing screenshot bundle, source snapshot, and QA reports

Latest aliases are also maintained:

- `PRODUCTION_DEEP_QA_BUNDLE.zip`
- `PRODUCTION_DEEP_QA_SOURCE.zip`
- `PRODUCTION_DEEP_QA_PACKAGE.zip`

## Security exclusions

The source snapshot intentionally excludes:

- `.env*`
- `node_modules`
- `dist`
- `_logs`
- `.git`
- `.vercel`
- patch backups
- zip/log/tmp/bak files

This keeps local secrets and bulky generated files out of the package.

## Operating rule

When the operator wants ChatGPT to review code + screenshots together, send:

1. the contents of `_logs/PRODUCTION_DEEP_QA_TO_SEND.txt`
2. `_logs/PRODUCTION_DEEP_QA_PACKAGE_<runId>.zip`

The screenshot-only bundle is still useful for pure UI review, but the full package is preferred for debugging and patch generation.
