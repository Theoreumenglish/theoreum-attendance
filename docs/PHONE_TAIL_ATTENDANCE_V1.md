# phone-tail-attendance-v1

## Goal

Use one simple kiosk input rule for students and staff:

- The screen always shows `010`.
- The user enters only the remaining 8 digits of their own phone number.
- QR remains as a backup path, not the primary workflow.
- No second staff confirmation workflow is added in this version.

## Student attendance

Student attendance uses `students.student_phone` as the primary identity source.

Flow:

1. Select attendance action: check-in, check-out, move, outing/return.
2. Kiosk shows `010` prefix.
3. Student enters the remaining 8 digits.
4. Server matches the tail against active students with `student_phone` ending in the same 8 digits.
5. Exactly one match is required.
6. Attendance is recorded with `meta_json.input_mode = PHONE_LAST8`.

If multiple students match the same tail, the request is blocked with `PHONE_AMBIGUOUS`.
If no active student matches, the request is blocked with `PHONE_NOT_FOUND`.

## Staff attendance

Staff attendance also uses the phone-tail rule.

Flow:

1. Type `staff`, `staffin`, or `staffout` from any kiosk mode.
2. Staff mode opens.
3. Staff member enters the remaining 8 digits of their own 010 phone number.
4. Server matches the tail against staff/staff_snapshot phone-like fields.
5. Exactly one active staff row is required.
6. Staff clock log is recorded with `input_mode = PHONE_LAST8`.

Legacy staff PIN and staff QR paths remain as backup paths, but the expected kiosk workflow is phone-tail input.

## Security and operations

This version intentionally avoids a second confirmation layer because it adds too much daily operational burden.

Risk handling in this version:

- Phone tail is less publicly shared than a student number.
- Ambiguous phone tails are blocked.
- All clock/attendance rows still keep trace IDs and source metadata.
- QR remains available when a phone number is missing or needs fallback.

Possible later versions:

- Daily rotating short code.
- Staff confirmation workflow.
- Suspicious rapid-entry detection.
- Per-student attendance PIN.
