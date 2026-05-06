import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_STAGES = [10, 30];

function nowIso(date = new Date()) {
  return date.toISOString();
}

function kstYmd(date = new Date()) {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);

  return text.replace(/-/g, '');
}

function isStrictYmd(value) {
  return /^\d{8}$/.test(String(value || '').trim());
}

function normalizeStudentId(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'scheduled') return 'SCHEDULED';
  if (s === 'active') return 'SCHEDULED';
  if (s === '수업') return 'SCHEDULED';
  if (s === 'holiday') return 'HOLIDAY';
  if (s === 'cancelled' || s === 'canceled' || s === '휴강') return 'CANCELLED';
  return String(raw || '').trim().toUpperCase();
}

function isActiveStudentStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s === '재원' || s === '재원생' || s === 'active';
}

function normPhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').trim();
}

function parseStages(raw) {
  const source = Array.isArray(raw)
    ? raw
    : String(raw || process.env.ABSENT_STAGE_MINUTES || '10,30').split(/[,,/|;\s]+/);

  const out = source
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 240)
    .map(n => Math.floor(n));

  const unique = Array.from(new Set(out)).sort((a, b) => a - b);
  return unique.length ? unique : DEFAULT_STAGES;
}

function parseKstStartMs(yyyymmdd, hhmm) {
  const t = String(hhmm || '').trim();
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!isStrictYmd(yyyymmdd) || !m) return 0;

  const y = Number(yyyymmdd.slice(0, 4));
  const mo = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const h = Number(m[1]);
  const mi = Number(m[2]);

  return Date.UTC(y, mo - 1, d, h - 9, mi, 0, 0);
}

function isFutureExcuse(row, nowMs) {
  const until = String(row?.until_ts || '').trim();
  if (!until) return true;

  const parsed = Date.parse(until);
  if (!Number.isFinite(parsed)) return true;
  return parsed >= nowMs;
}

function chunkArray(items, size = 100) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function makeTraceId(ymd, classId, studentId, stage) {
  return ['ABSENT', ymd, classId, studentId, String(stage)].join('|');
}

function makeActionType(stage) {
  return 'ABSENT_' + String(stage);
}

function isDuplicateKeyError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const detail = String(error?.details || '').toLowerCase();

  return (
    code === '23505' ||
    message.includes('duplicate key') ||
    detail.includes('duplicate key')
  );
}

async function selectInChunks(supabase, table, columns, field, values, extra = null) {
  const all = [];
  const chunks = chunkArray(Array.from(new Set(values.filter(Boolean))), 100);

  for (const chunk of chunks) {
    let query = supabase.from(table).select(columns).in(field, chunk);
    if (typeof extra === 'function') query = extra(query);

    const { data, error } = await query;
    if (error) throw new Error(error.message || table + ' 조회 실패');
    all.push(...(data || []));
  }

  return all;
}

function buildPresentStudentSet(attendanceRows, nowMs) {
  const byStudent = new Map();

  for (const row of attendanceRows || []) {
    const sid = normalizeStudentId(row.student_id);
    if (!sid) continue;

    const tsMs = Date.parse(String(row.ts || ''));
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs > nowMs) continue;

    if (!byStudent.has(sid)) byStudent.set(sid, []);
    byStudent.get(sid).push({
      tsMs,
      action: String(row.action_type || '').trim().toUpperCase()
    });
  }

  const presentSet = new Set();

  for (const [sid, logs] of byStudent.entries()) {
    logs.sort((a, b) => a.tsMs - b.tsMs);

    let present = false;
    for (const item of logs) {
      if (item.action === 'CHECK_IN') {
        present = true;
        continue;
      }

      if (item.action === 'CHECK_OUT') {
        present = false;
      }
    }

    if (present) presentSet.add(sid);
  }

  return presentSet;
}

async function insertQueueRows(supabase, rows) {
  const result = {
    queuedCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    failed: []
  };

  for (const row of rows) {
    const { error } = await supabase
      .from('attendance_notify_queue')
      .insert([row]);

    if (!error) {
      result.queuedCount++;
      continue;
    }

    if (isDuplicateKeyError(error)) {
      result.duplicateCount++;
      continue;
    }

    result.failedCount++;
    result.failed.push({
      trace_id: row.trace_id,
      student_id: row.student_id,
      action_type: row.action_type,
      error: error.message || 'queue insert 실패'
    });
  }

  return result;
}

export async function runAbsenceDetectionDirect(args = {}) {
  const supabase = getSupabaseAdmin();
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'now 값이 올바른 날짜가 아닙니다.'
      }
    };
  }

  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(now)).trim();
  if (!isStrictYmd(yyyymmdd)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'yyyymmdd 8자리가 필요합니다.'
      }
    };
  }

  const stages = parseStages(args.stages);
  const dryRun = String(args.dry_run || args.dryRun || 'N').trim().toUpperCase() === 'Y';
  const nowMs = now.getTime();

  const summary = {
    yyyymmdd,
    checked_at: nowIso(now),
    stages,
    dryRun,
    scheduledClassCount: 0,
    relationCount: 0,
    activeStudentCount: 0,
    alreadyCheckedInCount: 0,
    excusedCount: 0,
    candidates: 0,
    candidateCount: 0,
    queuedCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    sentCount: 0,
    items: []
  };

  const { data: schedules, error: scheduleErr } = await supabase
    .from('class_schedule')
    .select('yyyymmdd, class_id, class_name, teacher, start, end, status, reason')
    .eq('yyyymmdd', yyyymmdd);

  if (scheduleErr) {
    return {
      ok: false,
      error: {
        code: 'DB_SELECT_FAILED',
        message: scheduleErr.message || 'class_schedule 조회 실패'
      }
    };
  }

  const scheduledRows = (schedules || []).filter(row => normalizeStatus(row.status) === 'SCHEDULED');
  summary.scheduledClassCount = scheduledRows.length;

  if (!scheduledRows.length) {
    return { ok: true, data: summary };
  }

  const lateSchedules = scheduledRows
    .map(row => {
      const startMs = parseKstStartMs(yyyymmdd, row.start);
      const lateMin = startMs ? Math.floor((nowMs - startMs) / 60000) : -1;
      const dueStages = stages.filter(stage => lateMin >= stage);
      return { ...row, startMs, lateMin, dueStages };
    })
    .filter(row => row.startMs && row.dueStages.length);

  if (!lateSchedules.length) {
    return { ok: true, data: summary };
  }

  const classIds = Array.from(new Set(lateSchedules.map(row => String(row.class_id || '').trim()).filter(Boolean)));
  const relations = await selectInChunks(
    supabase,
    'class_students',
    'class_id, student_id',
    'class_id',
    classIds
  );
  summary.relationCount = relations.length;

  const studentIds = Array.from(new Set(relations.map(row => normalizeStudentId(row.student_id)).filter(Boolean)));
  if (!studentIds.length) return { ok: true, data: summary };

  const students = await selectInChunks(
    supabase,
    'students',
    'student_id, student_name, school, grade, parent_phone, status',
    'student_id',
    studentIds
  );

  const studentMap = new Map();
  for (const student of students) {
    const sid = normalizeStudentId(student.student_id);
    if (sid && isActiveStudentStatus(student.status)) {
      studentMap.set(sid, student);
    }
  }
  summary.activeStudentCount = studentMap.size;

  if (!studentMap.size) return { ok: true, data: summary };

  const activeStudentIds = Array.from(studentMap.keys());
  const attendanceRows = await selectInChunks(
    supabase,
    'attendance_logs',
    'student_id, action_type, result, ts',
    'student_id',
    activeStudentIds,
    query => query
      .eq('yyyymmdd', yyyymmdd)
      .eq('result', 'OK')
      .in('action_type', ['CHECK_IN', 'CHECK_OUT'])
  );

  const presentSet = buildPresentStudentSet(attendanceRows, nowMs);
  summary.alreadyCheckedInCount = presentSet.size;

  const excuseRows = await selectInChunks(
    supabase,
    'absence_excuses',
    'class_id, yyyymmdd, student_id, until_ts',
    'student_id',
    activeStudentIds,
    query => query.eq('yyyymmdd', yyyymmdd)
  );

  const excuseSet = new Set();
  for (const row of excuseRows) {
    const sid = normalizeStudentId(row.student_id);
    const classId = String(row.class_id || '').trim();
    if (!sid || !classId) continue;
    if (!isFutureExcuse(row, nowMs)) continue;
    excuseSet.add(classId + '|' + sid);
  }
  summary.excusedCount = excuseSet.size;

  const scheduleByClass = new Map(lateSchedules.map(row => [String(row.class_id || '').trim(), row]));
  const candidates = [];

  for (const relation of relations) {
    const classId = String(relation.class_id || '').trim();
    const sid = normalizeStudentId(relation.student_id);
    const schedule = scheduleByClass.get(classId);
    const student = studentMap.get(sid);

    if (!classId || !sid || !schedule || !student) continue;
    if (presentSet.has(sid)) continue;
    if (excuseSet.has(classId + '|' + sid)) continue;

    for (const stage of schedule.dueStages) {
      const traceId = makeTraceId(yyyymmdd, classId, sid, stage);
      candidates.push({
        traceId,
        actionType: makeActionType(stage),
        stage,
        classId,
        className: String(schedule.class_name || ''),
        lateMin: schedule.lateMin,
        student
      });
    }
  }

  summary.candidates = candidates.length;
  summary.candidateCount = candidates.length;

  if (!candidates.length) {
    return { ok: true, data: summary };
  }

  const traceIds = candidates.map(x => x.traceId);
  const existingQueueRows = await selectInChunks(
    supabase,
    'attendance_notify_queue',
    'trace_id, action_type, status',
    'trace_id',
    traceIds
  );
  const existingKeys = new Set(existingQueueRows.map(row => String(row.trace_id || '').trim() + '|' + String(row.action_type || '').trim()));

  const rowsToInsert = [];
  for (const item of candidates) {
    const student = item.student;
    const parentPhone = normPhone(student.parent_phone);
    const key = item.traceId + '|' + item.actionType;

    if (existingKeys.has(key)) {
      summary.duplicateCount++;
      continue;
    }

    if (!parentPhone) {
      summary.failedCount++;
      summary.items.push({
        trace_id: item.traceId,
        student_id: normalizeStudentId(student.student_id),
        class_id: item.classId,
        stage: item.stage,
        status: 'SKIPPED',
        error: 'NO_PARENT_PHONE'
      });
      continue;
    }

    const row = {
      queue_id: randomUUID(),
      trace_id: item.traceId,
      student_id: normalizeStudentId(student.student_id),
      action_type: item.actionType,
      parent_phone: parentPhone,
      school: String(student.school || '').trim(),
      grade: String(student.grade || '').trim(),
      student_name: String(student.student_name || '').trim(),
      occurred_at: nowIso(now),
      status: 'PENDING',
      attempts: 0,
      sent_channel: '',
      last_error: '',
      processed_at: null
    };

    summary.items.push({
      trace_id: item.traceId,
      student_id: row.student_id,
      class_id: item.classId,
      class_name: item.className,
      stage: item.stage,
      late_min: item.lateMin,
      status: dryRun ? 'DRY_RUN' : 'PENDING'
    });

    rowsToInsert.push(row);
  }

  if (dryRun || !rowsToInsert.length) {
    return { ok: true, data: summary };
  }

  const insertResult = await insertQueueRows(supabase, rowsToInsert);
  summary.queuedCount = insertResult.queuedCount;
  summary.duplicateCount += insertResult.duplicateCount;
  summary.failedCount += insertResult.failedCount;
  summary.items.push(...insertResult.failed);

  return { ok: true, data: summary };
}