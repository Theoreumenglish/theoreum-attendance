# online-lecture-assignment-v1

## Purpose

Add the first practical online lecture workflow without building a full LMS.
The academy can assign external lecture links to a selected student, and visible assignments appear in the student mobile today link.

## Scope

Included:
- `student_lecture_assignments` table.
- `admin.lectureAssignment.list` read API.
- `admin.lectureAssignment.save` create/update API.
- Student 360 lecture assignment panel.
- Student today public link lecture rendering.
- Smoke-test route coverage.

Excluded for now:
- Native student app.
- Video hosting.
- Playback tracking.
- Payment or paid lecture sales.
- Public editing by students.

## Operating rule

The system stores links and operational assignment status only. It does not host lecture files.
Use visible-to-student assignments for student links and archive old assignments instead of deleting them.

## Safety

- Staff login is required for assignment create/update.
- Public student links only expose visible, non-archived assignments.
- URLs must start with `http://` or `https://`.
- Admin save action writes portal audit logs when available.
