# KIOSK_VISUAL_QA_V1

Marker: kiosk-visual-qa-v1

## Purpose

This patch fixes the kiosk phone input flow found during direct browser-style UI verification.

## Fixed

- Rapid physical keyboard input such as `12345678` no longer loses the last four digits when the first input is still focused.
- When the first 4-digit box is full, the next numeric key is routed directly into the second 4-digit box.
- `staff`, `staffin`, and `staffout` typed from the visible phone input still route to the raw staff command scanner.
- The kiosk card is slightly more compact on common 1366x768 / 1366x900 kiosk displays.
- Duplicate `StaffUI.studentSearchTimer` / `studentSearchSeq` object properties were removed.

## Verification

Run:

```bash
npm run kiosk-input-check
npm run verify
```

Manual screen checks:

1. Open kiosk.
2. Type `12345678` quickly with the physical keyboard.
3. Confirm first box shows `1234` and second box receives `5678`.
4. Type `staff` from kiosk mode and confirm staff quick mode opens.
5. Type staff phone tail 8 digits and confirm staff clock request runs.
