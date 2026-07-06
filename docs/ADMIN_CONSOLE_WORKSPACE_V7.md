# admin-console-workspace-v7

Purpose: make the admin console easier for desk staff and teachers without changing the existing data architecture.

## What changed

- Added an operator-first admin console guard class: `adminConsoleV7`.
- Student search results are now a compact master list with checkbox selection, status badges, and kebab menus.
- Student detail work is pushed into the existing right drawer so the list stays clean.
- Heavy student profile sections remain in the DOM for compatibility but are hidden from the default operator view.
- Student Today Link and Online Lecture labels remain visible for deep QA compatibility, while lecture inputs are no longer always visible.
- Staff account management now shows only the core fields by default: staff ID, name, phone, and role.
- Staff status, revoked, password, and PIN fields are moved into an advanced details panel.
- Staff phone cells are read-only by default and become editable only on double-click.
- Async buttons receive pending visual feedback and are disabled while promises are running to prevent duplicate clicks.
- Student searches show a skeleton loading state so the UI does not look frozen.

## Non-goals

- No database schema change.
- No removal of existing APIs.
- No destructive data cleanup.
- Bulk attendance/message actions are currently UI-safe placeholders; actual write automation should be connected in a separate patch after policy confirmation.
