import { randomUUID } from 'node:crypto';
import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { sendNcpTestMessageDirect } from '../lib/attendance-notify.js';
import {
  runAttendanceNotifyWorker,
  listAttendanceNotifyQueueDirect,
  retryAttendanceNotifyQueueDirect
} from '../lib/attendance-notify-queue.js';
import { runAbsenceDetectionDirect } from '../lib/absent-direct.js';
import { recordAbsenceRunDirect } from '../lib/absence-run-audit.js';
import { verifyAdminPinByStaffId } from './_admin-pin.js';
import {
  readRuntimeMeta,
  writeRuntimeConfig,
  invalidateRuntimeMetaCache,
  appendRuntimeConfigAudit,
  normalizeFloor,
  normalizeYn
} from './_runtime-meta.js';
import {
  assistantGetLogsDirect,
  assistantGetLogByTraceDirect,
  adminGetStaffMonthlySummaryDirect,
  adminGetStaffDailyDetailDirect
} from '../lib/rpc-direct-read.js';

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }

  if (typeof req.body === 'string') {
    const text = req.body.trim();
    return text ? JSON.parse(text) : {};
  }

  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  return {};
}

function normalizeStudentId(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

function normalizeRole(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'assistant';
  if (['assistant', 'staff', '조교'].includes(v)) return 'assistant';
  if (['teacher', '강사'].includes(v)) return 'teacher';
  if (['admin', '관리자'].includes(v)) return 'admin';
  if (['owner', '오너', '원장'].includes(v)) return 'owner';
  return v;
}

function roleLevel(role) {
  const r = normalizeRole(role);
  if (r === 'assistant') return 1;
  if (r === 'teacher') return 2;
  if (r === 'admin' || r === 'owner') return 4;
  return 0;
}

function hasRoleAtLeast(role, need) {
  return roleLevel(role) >= roleLevel(need);
}

function fail(status, code, message, detail = {}) {
  return {
    status,
    body: {
      ok: false,
      error: { code, message, detail }
    }
  };
}

function success(data) {
  return {
    status: 200,
    body: {
      ok: true,
      data
    }
  };
}

async function requireRole(sessionToken, needRole) {
  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });

  if (!me.loggedIn) {
    return { ok: false, out: fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.') };
  }

  if (!hasRoleAtLeast(me.role, needRole)) {
    return {
      ok: false,
      out: fail(403, 'NO_PERMISSION', `${needRole} 이상 권한이 필요합니다.`)
    };
  }

  return { ok: true, me };
}

function pickAdminPin(args = {}) {
  return String(
    args.pin ||
    args.admin_pin ||
    args.adminPin ||
    args.confirm_pin ||
    ''
  ).trim();
}

function normalizeComparableValue(value) {
  return String(value || '').trim().toLowerCase();
}

function expandComparableValues(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeComparableValue).filter(Boolean);
  }

  const text = String(value || '').trim();
  if (!text) return [];

  return text
    .split(/[\/,|;]/)
    .map(normalizeComparableValue)
    .filter(Boolean);
}

function teacherOwnsStudent(me, studentRow) {
  const studentOwners = [
    studentRow?.teacher_value,
    studentRow?.teacher,
    studentRow?.teacher_id,
    studentRow?.teacher_name
  ]
    .flatMap(expandComparableValues)
    .filter(Boolean);

  if (!studentOwners.length) return false;

  const mine = [
    me?.staff_id,
    me?.name
  ]
    .flatMap(expandComparableValues)
    .filter(Boolean);

  return studentOwners.some(v => mine.includes(v));
}

async function adminGetRuntimeConfigDirect(sessionToken) {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const meta = await readRuntimeMeta(true);
  if (!meta.ok) {
    return fail(
      500,
      meta.error.code || 'DB_SELECT_FAILED',
      meta.error.message || 'runtime_config 조회 실패'
    );
  }

  return success(meta.data);
}

async function adminSetKioskFloorDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args);
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(401, pinCheck.error.code || 'AUTH_FAILED', pinCheck.error.message || '관리자 PIN 확인 실패');
  }

  const kioskFloor = normalizeFloor(args.kiosk_floor || args.floor || args.kioskFloor || '');
  if (!kioskFloor || !['5F', '7F'].includes(kioskFloor)) {
    return fail(400, 'INVALID_INPUT', 'kiosk_floor는 5F 또는 7F여야 합니다.');
  }

  const beforeMeta = await readRuntimeMeta(true);
  if (!beforeMeta.ok) {
    return fail(
      500,
      beforeMeta.error.code || 'DB_SELECT_FAILED',
      beforeMeta.error.message || 'runtime_config 조회 실패'
    );
  }

  const { error } = await writeRuntimeConfig(
    'kiosk_floor',
    { value: kioskFloor },
    auth.me.staff_id
  );

  if (error) {
    return fail(500, 'DB_UPSERT_FAILED', error.message || 'runtime_config kiosk_floor 저장 실패');
  }

  const audit = await appendRuntimeConfigAudit({
    key: 'kiosk_floor',
    before_json: { value: beforeMeta.data?.kiosk_floor || '' },
    after_json: { value: kioskFloor },
    changed_by: auth.me.staff_id
  });

  if (!audit.ok) {
    await writeRuntimeConfig(
      'kiosk_floor',
      { value: beforeMeta.data?.kiosk_floor || '5F' },
      auth.me.staff_id
    );

    return fail(500, 'DB_AUDIT_FAILED', audit.error?.message || 'runtime_config_audit 저장 실패');
  }

  const meta = await readRuntimeMeta(true);
  if (!meta.ok) {
    return fail(
      500,
      meta.error.code || 'DB_SELECT_FAILED',
      meta.error.message || 'runtime_config 조회 실패'
    );
  }

  return success(meta.data);
}

async function adminSetSafeModeDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args);
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(401, pinCheck.error.code || 'AUTH_FAILED', pinCheck.error.message || '관리자 PIN 확인 실패');
  }

  const mode = normalizeYn(args.mode || args.safe_mode || args.safeMode || 'N');
  const message = String(args.message || args.safe_message || '').trim().slice(0, 200);

  const beforeMeta = await readRuntimeMeta(true);
  if (!beforeMeta.ok) {
    return fail(
      500,
      beforeMeta.error.code || 'DB_SELECT_FAILED',
      beforeMeta.error.message || 'runtime_config 조회 실패'
    );
  }

  const { error } = await writeRuntimeConfig(
    'safe_mode',
    { mode, message },
    auth.me.staff_id
  );

  if (error) {
    return fail(500, 'DB_UPSERT_FAILED', error.message || 'runtime_config safe_mode 저장 실패');
  }

  const audit = await appendRuntimeConfigAudit({
    key: 'safe_mode',
    before_json: beforeMeta.data?.safe || {},
    after_json: { mode, message },
    changed_by: auth.me.staff_id
  });

  if (!audit.ok) {
    await writeRuntimeConfig(
      'safe_mode',
      {
        mode: beforeMeta.data?.safe?.mode || 'N',
        message: beforeMeta.data?.safe?.message || ''
      },
      auth.me.staff_id
    );

    return fail(500, 'DB_AUDIT_FAILED', audit.error?.message || 'runtime_config_audit 저장 실패');
  }

  const meta = await readRuntimeMeta(true);
  if (!meta.ok) {
    return fail(
      500,
      meta.error.code || 'DB_SELECT_FAILED',
      meta.error.message || 'runtime_config 조회 실패'
    );
  }

  return success(meta.data);
}

async function teacherSetExceptionDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const yn =
    String(args.is_exception || args.isException || 'N').trim().toUpperCase() === 'Y'
      ? 'Y'
      : 'N';
  const note = String(args.exception_note || args.note || '').trim().slice(0, 200);

  if (!sid) {
    return fail(400, 'INVALID_INPUT', '학번 4자리가 필요합니다.');
  }

  const supabase = getSupabaseAdmin();

  const { data: found, error: readErr } = await supabase
    .from('students')
    .select('*')
    .eq('student_id', sid)
    .maybeSingle();

  if (readErr) {
    return fail(500, 'DB_SELECT_FAILED', readErr.message || 'students 조회 실패');
  }

  if (!found) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
  }

  if (normalizeRole(auth.me.role) === 'teacher' && !teacherOwnsStudent(auth.me, found)) {
    return fail(403, 'NO_PERMISSION', '담당 학생만 예외 설정을 변경할 수 있습니다.');
  }

  const { data: patched, error: updateErr } = await supabase
    .from('students')
    .update({
      is_exception: yn,
      exception_note: yn === 'Y' ? note : ''
    })
    .eq('student_id', sid)
    .select('student_id, student_name, is_exception, exception_note')
    .maybeSingle();

  if (updateErr) {
    return fail(500, 'DB_UPDATE_FAILED', updateErr.message || 'students update 실패');
  }

  return success({
    student_id: sid,
    student_name: String(patched?.student_name || found.student_name || '').trim(),
    is_exception: String(patched?.is_exception || yn).trim().toUpperCase(),
    exception_note: String(patched?.exception_note || '').trim(),
    updated_by: auth.me.staff_id,
    updated_role: auth.me.role
  });
}
function envReady(name) {
  return !!String(process.env[name] || '').trim();
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

function nowIso() {
  return new Date().toISOString();
}

function isStrictYmd(value) {
  return /^\d{8}$/.test(String(value || '').trim());
}

function normalizeActionType(raw) {
  const action = String(raw || '').trim().toUpperCase();
  const allowed = new Set([
    'CHECK_IN',
    'CHECK_OUT',
    'MOVE',
    'OUTING_OUT',
    'OUTING_BACK',
    'MANUAL_CHECK_IN',
    'MANUAL_CHECK_OUT'
  ]);

  return allowed.has(action) ? action : '';
}

async function metaDiagDirect(sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const meta = await readRuntimeMeta(true);
  if (!meta.ok) {
    return fail(
      500,
      meta.error.code || 'DB_SELECT_FAILED',
      meta.error.message || '운영 메타 정보를 읽지 못했습니다.'
    );
  }

  return success({
    version: 'vercel-direct',
    pepperReady: envReady('AUTH_PEPPER') || envReady('SYS_PEPPER'),
    supabaseReady: envReady('SUPABASE_URL') && envReady('SUPABASE_SERVICE_ROLE_KEY'),
    studentQrVerifySecretSet: envReady('STUDENT_QR_VERIFY_SHARED_SECRET') || envReady('VERIFY_SHARED_SECRET'),
    studentQrHmacSecretSet: envReady('STUDENT_QR_HMAC_SECRET') || envReady('QR_HMAC_SECRET'),
    studentQrFrameStepMs: String(process.env.STUDENT_QR_FRAME_STEP_MS || '4000').trim(),
    studentQrGraceMs: String(process.env.STUDENT_QR_GRACE_MS || '12000').trim(),
    studentQrSessionTtlSec: String(process.env.STUDENT_QR_SESSION_TTL_SEC || '90').trim(),
    verifySecretSet: envReady('STUDENT_QR_VERIFY_SHARED_SECRET') || envReady('VERIFY_SHARED_SECRET'),
    staffQrVerifySecretSet: envReady('STAFF_QR_VERIFY_SHARED_SECRET'),
    attendanceTemplateSet: envReady('TPL_ATTENDANCE'),
    classAbsentTemplateSet: envReady('TPL_CLASS_ABSENT') || envReady('TPL_CLASS_ABSENT_PARENTS'),
    absentNotifyParentsOn: String(process.env.ABSENT_NOTIFY_PARENTS || 'Y').trim().toUpperCase() === 'Y',
    cronSecretSet: envReady('CRON_SECRET'),
    absentStageMinutes: String(process.env.ABSENT_STAGE_MINUTES || '10,30').trim(),
    absentCronWorkerLimit: String(process.env.ABSENT_CRON_WORKER_LIMIT || '20').trim(),
    alimtalkServiceSet: envReady('NCP_ALIMTALK_SERVICE_ID'),
    smsServiceSet: envReady('NCP_SMS_SERVICE_ID'),
    plusFriendSet: envReady('NCP_PLUS_FRIEND_ID'),
    fromNumberSet: envReady('NCP_SENS_FROM') || envReady('NCP_CALLER'),
    kioskFloor: meta.data?.kiosk_floor || '',
    safe: meta.data?.safe || {},
    runtimeSource: meta.data?.source || ''
  });
}

function formatSupabaseCheckError(error) {
  if (!error) return '';

  const parts = [
    error.code,
    error.message,
    error.details,
    error.hint
  ]
    .map(x => String(x || '').trim())
    .filter(Boolean);

  return parts.length ? parts.join(' / ') : '조회 실패';
}

async function checkTableReadable(supabase, tableName, selectExpr = '*') {
  const { count, error } = await supabase
    .from(tableName)
    .select(selectExpr, { head: true, count: 'exact' });

  return {
    name: tableName,
    ok: !error,
    count: typeof count === 'number' ? count : null,
    columns: selectExpr,
    message: error ? formatSupabaseCheckError(error) : ''
  };
}

async function metaCheckCentralDirect(sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const tableChecks = [
    {
      name: 'students',
      columns: 'student_id, student_name, school, grade, parent_phone, status, qr_id, is_exception'
    },
    {
      name: 'staff',
      columns: 'staff_id, name, role, revoked, status, pw_hash, pw_salt, pin_hash, pin_salt'
    },
    {
      name: 'staff_sessions',
      columns: 'session_token_hash, staff_id, expires_at, created_at, last_seen_at, revoked_at'
    },
    {
      name: 'classes',
      columns: 'class_id, name, teacher, start, end, status'
    },
    {
      name: 'class_students',
      columns: 'class_id, student_id'
    },
    {
      name: 'class_schedule',
      columns: 'yyyymmdd, class_id, class_name, teacher, start, end, status'
    },
    {
      name: 'absence_excuses',
      columns: 'excuse_id, class_id, yyyymmdd, student_id, reason, until_ts, created_at, created_by, updated_at, updated_by'
    },
    {
      name: 'attendance_logs',
      columns: 'record_id, ts, yyyymmdd, student_id, action_type, kiosk_floor, meta_json, result, deny_reason, qr_id, trace_id'
    },
    {
      name: 'staff_clock_logs',
      columns: 'ts, staff_id, name, role, action, input_mode, note, trace_id'
    },
    {
      name: 'staff_daily',
      columns: 'yyyymmdd, staff_id, name, role, first_in_ts, last_out_ts, worked_minutes, worked_hours, pair_count, status, note, updated_at'
    },
    {
      name: 'staff_monthly',
      columns: 'yyyymm, staff_id, name, role, total_minutes, total_hours, work_days, missing_days, updated_at'
    },
    {
      name: 'runtime_config',
      columns: 'key, value_json, updated_at, updated_by'
    },
    {
      name: 'runtime_config_audit',
      columns: 'audit_id, key, before_json, after_json, changed_by, changed_at'
    },
    {
      name: 'kiosk_pin_approvals',
      columns: 'student_id, approved_by, approved_at, expires_at'
    },
    {
      name: 'kiosk_pin_attempts',
      columns: 'staff_id, student_id, fail_count, locked_until, updated_at'
    },
    {
      name: 'attendance_notify_queue',
      columns: 'queue_id, trace_id, student_id, action_type, parent_phone, school, grade, student_name, occurred_at, status, attempts, sent_channel, last_error, claimed_at, processed_at, created_at'
    },
    {
      name: 'absence_detection_runs',
      columns: 'run_id, created_at, source, status, run_by, yyyymmdd, started_at, finished_at, scheduled_class_count, candidate_count, queued_count, duplicate_count, failed_count, sent_count, worker_done, worker_failed, worker_requeued, detail_json, error'
    },
    {
      name: 'student_qr_sessions',
      columns: 'token, student_id, public_session_id, exp_ms, anchor_ms, student_name'
    },
    {
      name: 'student_qr_nonces',
      columns: 'nonce, student_id, public_session_id, exp_ms, used'
    },
    {
      name: 'staff_qr_sessions',
      columns: 'token, staff_id, public_session_id, exp_ms'
    },
    {
      name: 'staff_qr_nonces',
      columns: 'nonce, staff_id, public_session_id, exp_ms, used'
    }
  ];

  const checks = [];
  for (const item of tableChecks) {
    checks.push(await checkTableReadable(supabase, item.name, item.columns));
  }

  return success({
    ok: checks.every(x => x.ok),
    checked_at: nowIso(),
    checks
  });
}

async function metaLogoErrorDirect(args = {}) {
  console.warn('[LOGO_ERROR]', {
    src: String(args.src || '').slice(0, 300),
    currentView: String(args.currentView || '').slice(0, 50),
    userAgent: String(args.userAgent || '').slice(0, 300)
  });

  return success({
    recorded: false,
    reason: 'SERVER_LOG_ONLY'
  });
}

async function adminTestNcpDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const phone = String(args.phone || args.to || '').replace(/[^0-9]/g, '');
  if (!phone) {
    return fail(400, 'INVALID_INPUT', '테스트 번호가 필요합니다.');
  }

  const result = await sendNcpTestMessageDirect(phone, 'ADMIN_NCP_TEST');

  return success({
    ...result,
    tested_by: auth.me.staff_id
  });
}

async function adminListNotifyQueueDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const result = await listAttendanceNotifyQueueDirect({
    status: args.status || '',
    action_prefix: args.action_prefix || args.actionPrefix || '',
    limit: args.limit || 100
  });

  if (!result.ok) {
    return fail(
      500,
      result.error?.code || 'QUEUE_READ_FAILED',
      result.error?.message || '알림 queue 조회 실패'
    );
  }

  return success(result.data || {});
}

async function adminRetryNotifyQueueDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args);
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(
      401,
      pinCheck.error.code || 'AUTH_FAILED',
      pinCheck.error.message || '관리자 PIN 확인 실패'
    );
  }

  const result = await retryAttendanceNotifyQueueDirect({
    status: args.status || 'FAILED',
    action_prefix: args.action_prefix || args.actionPrefix || '',
    limit: args.limit || 50,
    reset_attempts: args.reset_attempts || args.resetAttempts || 'N',
    worker_limit: args.worker_limit || args.workerLimit || 20
  });

  if (!result.ok) {
    return fail(
      500,
      result.error?.code || 'QUEUE_RETRY_FAILED',
      result.error?.message || '알림 queue 재처리 실패'
    );
  }

  return success({
    ...(result.data || {}),
    run_by: auth.me.staff_id
  });
}

async function adminFlushCacheDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args);
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(
      401,
      pinCheck.error.code || 'AUTH_FAILED',
      pinCheck.error.message || '관리자 PIN 확인 실패'
    );
  }

  invalidateRuntimeMetaCache();

  return success({
    ok: true,
    flushed: ['runtime_meta'],
    flushed_at: nowIso()
  });
}

function notImplementedDirect(message) {
  return fail(501, 'NOT_IMPLEMENTED_DIRECT', message);
}

async function absentRunNowDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args);
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(
      401,
      pinCheck.error.code || 'AUTH_FAILED',
      pinCheck.error.message || '관리자 PIN 확인 실패'
    );
  }

  const startedAt = new Date();

  const detection = await runAbsenceDetectionDirect({
    yyyymmdd: args.yyyymmdd || args.ymd || '',
    now: args.now || '',
    stages: args.stages || '',
    dry_run: args.dry_run || args.dryRun || 'N'
  });

  if (!detection.ok) {
    const finishedAt = new Date();
    const errorMessage = detection.error?.message || '미등원 감지 실패';

    await recordAbsenceRunDirect({
      source: 'MANUAL',
      status: 'FAILED',
      run_by: auth.me.staff_id,
      detection: {},
      worker: null,
      error: errorMessage,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      meta: {
        stage: 'DETECTION'
      }
    });

    return fail(
      500,
      detection.error?.code || 'ABSENT_RUN_FAILED',
      errorMessage
    );
  }

  const data = detection.data || {};
  const dryRun = String(args.dry_run || args.dryRun || 'N').trim().toUpperCase() === 'Y';

  const shouldProcessQueue =
    String(args.process_queue || args.processQueue || 'Y').trim().toUpperCase() === 'Y' &&
    !dryRun &&
    Number(data.queuedCount || 0) > 0;

  let workerOut = null;
  if (shouldProcessQueue) {
    workerOut = await runAttendanceNotifyWorker({
      limit: Math.max(1, Math.min(20, Number(data.queuedCount || 1)))
    });
  }

  const workerData = workerOut && workerOut.ok ? (workerOut.data || {}) : null;
  const finishedAt = new Date();
  const sentCount = workerData ? Number(workerData.done || 0) : Number(data.sentCount || 0);

  const audit = await recordAbsenceRunDirect({
    source: dryRun ? 'MANUAL_DRY_RUN' : 'MANUAL',
    status: workerOut && !workerOut.ok ? 'FAILED' : 'OK',
    run_by: auth.me.staff_id,
    detection: data,
    worker: workerOut,
    sentCount,
    error: workerOut && !workerOut.ok ? (workerOut.error?.message || '알림 queue worker 실패') : '',
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    meta: {
      processQueue: shouldProcessQueue
    }
  });

  return success({
    ...data,
    sentCount,
    notifyWorker: workerOut || null,
    audit,
    run_by: auth.me.staff_id
  });
}

async function assertAbsenceExcuseTarget(supabase, classId, yyyymmdd, studentId) {
  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('student_id, status')
    .eq('student_id', studentId)
    .maybeSingle();

  if (studentErr) {
    return fail(500, 'DB_SELECT_FAILED', studentErr.message || 'students 조회 실패');
  }

  if (!student) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
  }

  const { data: relation, error: relationErr } = await supabase
    .from('class_students')
    .select('class_id, student_id')
    .eq('class_id', classId)
    .eq('student_id', studentId)
    .maybeSingle();

  if (relationErr) {
    return fail(500, 'DB_SELECT_FAILED', relationErr.message || 'class_students 조회 실패');
  }

  if (!relation) {
    return fail(400, 'INVALID_INPUT', '해당 학생은 이 반에 배정되어 있지 않습니다.');
  }

  const { data: schedule, error: scheduleErr } = await supabase
    .from('class_schedule')
    .select('class_id, yyyymmdd, status')
    .eq('class_id', classId)
    .eq('yyyymmdd', yyyymmdd)
    .maybeSingle();

  if (scheduleErr) {
    return fail(500, 'DB_SELECT_FAILED', scheduleErr.message || 'class_schedule 조회 실패');
  }

  if (!schedule) {
    return fail(404, 'NOT_FOUND', '해당 날짜의 스케줄이 없습니다. 중앙DB replica sync를 먼저 확인하세요.');
  }

  const status = String(schedule.status || '').trim().toUpperCase();
  if (status !== 'SCHEDULED') {
    return fail(400, 'INVALID_INPUT', '휴강일 또는 비수업일에는 미등원 예외를 등록할 수 없습니다.');
  }

  return null;
}

async function assistantListAbsenceExcusesDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const classId = String(args.class_id || '').trim();
  const sid = args.student_id ? normalizeStudentId(args.student_id) : '';

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('absence_excuses')
    .select('*')
    .order('yyyymmdd', { ascending: false })
    .limit(300);

  if (yyyymmdd) query = query.eq('yyyymmdd', yyyymmdd);
  if (classId) query = query.eq('class_id', classId);
  if (sid) query = query.eq('student_id', sid);

  const { data, error } = await query;
  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'absence_excuses 조회 실패');
  }

  return success({
    count: Array.isArray(data) ? data.length : 0,
    items: data || []
  });
}

async function assistantAddAbsenceExcuseDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const classId = String(args.class_id || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const reason = String(args.reason || '').trim().slice(0, 300);
  const untilMin = Number(args.until_min || args.untilMin || 0);

  if (!classId || classId === '*') {
    return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  }

  if (!isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd 8자리가 필요합니다.');
  }

  if (!sid) {
    return fail(400, 'INVALID_INPUT', '학번 4자리가 필요합니다.');
  }

  const today = kstYmd(new Date());
  if (yyyymmdd < today) {
    return fail(403, 'NO_PERMISSION', '과거 날짜에는 미등원 예외를 등록할 수 없습니다.');
  }

  const supabase = getSupabaseAdmin();
  const targetError = await assertAbsenceExcuseTarget(supabase, classId, yyyymmdd, sid);
  if (targetError) return targetError;

  const untilTs = Number.isFinite(untilMin) && untilMin > 0
    ? new Date(Date.now() + Math.floor(untilMin) * 60 * 1000).toISOString()
    : new Date(
        Number(yyyymmdd.slice(0, 4)),
        Number(yyyymmdd.slice(4, 6)) - 1,
        Number(yyyymmdd.slice(6, 8)),
        23,
        59,
        59
      ).toISOString();

  const now = nowIso();

  const { data: existing, error: existingErr } = await supabase
    .from('absence_excuses')
    .select('excuse_id')
    .eq('class_id', classId)
    .eq('yyyymmdd', yyyymmdd)
    .eq('student_id', sid)
    .limit(1)
    .maybeSingle();

  if (existingErr) {
    return fail(500, 'DB_SELECT_FAILED', existingErr.message || 'absence_excuses 기존 데이터 조회 실패');
  }

  if (existing?.excuse_id) {
    const { data, error } = await supabase
      .from('absence_excuses')
      .update({
        reason,
        until_ts: untilTs,
        updated_at: now,
        updated_by: auth.me.staff_id
      })
      .eq('excuse_id', existing.excuse_id)
      .select('*')
      .maybeSingle();

    if (error) {
      return fail(500, 'DB_UPDATE_FAILED', error.message || 'absence_excuses update 실패');
    }

    return success({
      item: data,
      updated: true
    });
  }

  const row = {
    excuse_id: randomUUID(),
    class_id: classId,
    yyyymmdd,
    student_id: sid,
    reason,
    until_ts: untilTs,
    created_at: now,
    created_by: auth.me.staff_id,
    updated_at: now,
    updated_by: auth.me.staff_id
  };

  const { data, error } = await supabase
    .from('absence_excuses')
    .insert([row])
    .select('*')
    .single();

  if (error) {
    return fail(500, 'DB_INSERT_FAILED', error.message || 'absence_excuses insert 실패');
  }

  return success({
    item: data,
    updated: false
  });
}

async function assistantRemoveAbsenceExcuseDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const classId = String(args.class_id || '').trim();
  const sid = args.student_id ? normalizeStudentId(args.student_id) : '';

  if (!classId || !yyyymmdd || !sid) {
    return fail(400, 'INVALID_INPUT', 'class_id / yyyymmdd / student_id가 모두 필요합니다.');
  }

  const supabase = getSupabaseAdmin();
  const { count, error } = await supabase
    .from('absence_excuses')
    .delete({ count: 'exact' })
    .eq('class_id', classId)
    .eq('yyyymmdd', yyyymmdd)
    .eq('student_id', sid);

  if (error) {
    return fail(500, 'DB_DELETE_FAILED', error.message || 'absence_excuses delete 실패');
  }

  return success({
    removed: typeof count === 'number' ? count : 0
  });
}

async function assistantManualAttendanceDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const pin = pickAdminPin(args) || String(args.pin || '').trim();
  const pinCheck = await verifyAdminPinByStaffId(auth.me.staff_id, pin);
  if (!pinCheck.ok) {
    return fail(
      401,
      pinCheck.error.code || 'AUTH_FAILED',
      pinCheck.error.message || '직원 PIN 확인 실패'
    );
  }

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const action = normalizeActionType(args.action_type || args.action || '');
  const reason = String(args.reason || '').trim().slice(0, 500);
  const sourceTraceId = String(args.source_trace_id || args.sourceTraceId || '').trim();

  if (!sid) return fail(400, 'INVALID_INPUT', '학번 4자리가 필요합니다.');
  if (!action) return fail(400, 'INVALID_INPUT', '허용되지 않는 action_type입니다.');
  if (!reason) return fail(400, 'INVALID_INPUT', '정정 사유가 필요합니다.');
  if (!sourceTraceId) return fail(400, 'INVALID_INPUT', '원본 trace_id가 필요합니다.');

  const supabase = getSupabaseAdmin();

  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('student_id, student_name, qr_id')
    .eq('student_id', sid)
    .maybeSingle();

  if (studentErr) {
    return fail(500, 'DB_SELECT_FAILED', studentErr.message || 'students 조회 실패');
  }

  if (!student) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
  }

  const meta = await readRuntimeMeta();
  const kioskFloor = meta.ok && meta.data?.kiosk_floor ? meta.data.kiosk_floor : '5F';
  const traceId = 'MANUAL_' + randomUUID();
  const now = new Date();

  const record = {
    record_id: 'M' + Date.now().toString(36) + randomUUID().replace(/-/g, '').slice(0, 6),
    ts: now.toISOString(),
    yyyymmdd: kstYmd(now),
    student_id: sid,
    action_type: action,
    kiosk_floor: kioskFloor,
    meta_json: {
      input_mode: 'MANUAL',
      correction: 'Y',
      reason,
      source_trace_id: sourceTraceId,
      actor: auth.me.staff_id,
      actor_role: auth.me.role
    },
    result: 'OK',
    deny_reason: '',
    qr_id: String(student.qr_id || ''),
    trace_id: traceId
  };

  const { data, error } = await supabase
    .from('attendance_logs')
    .insert([record])
    .select('*')
    .single();

  if (error) {
    return fail(500, 'DB_INSERT_FAILED', error.message || 'attendance_logs 수동 정정 insert 실패');
  }

  return success({
    record: data,
    student,
    trace_id: traceId
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  const contentLength = toPositiveInt(req.headers['content-length'], 0);
  if (contentLength > MAX_BODY_BYTES) {
    return send(res, 413, {
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `요청 크기가 너무 큽니다. 최대 ${MAX_BODY_BYTES} bytes`
      }
    });
  }

  let payload = {};
  try {
    payload = await readBody(req);
  } catch (_) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' }
    });
  }

  if (!isPlainObject(payload)) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_PAYLOAD', message: '요청 본문은 JSON 객체여야 합니다.' }
    });
  }

  const op = String(payload.op || '').trim();
  if (!op) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_OP', message: 'op 값이 필요합니다.' }
    });
  }

  if (payload.args != null && !isPlainObject(payload.args)) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'args는 JSON 객체여야 합니다.' }
    });
  }

  const sessionToken =
    (payload.args && payload.args.sessionToken) ||
    payload.sessionToken ||
    '';

  if (op === 'meta.ping') {
    const meta = await readRuntimeMeta();
    if (!meta.ok) {
      return send(res, 503, {
        ok: false,
        error: {
          code: meta.error.code || 'DB_SELECT_FAILED',
          message: meta.error.message || '운영 메타 정보를 읽지 못했습니다.'
        }
      });
    }
    return send(res, 200, { ok: true, data: meta.data });
  }

  if (op === 'auth.login') {
    const result = await authLoginDirect(payload.args || {});
    return send(res, result.status, result.body);
  }

  if (op === 'auth.me') {
    const me = await authMeDirect(sessionToken, { touch: true });
    return send(res, 200, { ok: true, data: me });
  }

  if (op === 'auth.logout') {
    const result = await authLogoutDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'kiosk.approvePin') {
    const result = await handleKioskApprovePin(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'kiosk.mark') {
    const result = await handleKioskMark(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'staff.clock') {
    const result = await handleStaffClock(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'staff.clock.qr') {
    const result = await handleStaffClockQr(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.getLogs') {
    const result = await assistantGetLogsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.getLogByTrace') {
    const result = await assistantGetLogByTraceDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getStaffMonthlySummary') {
    const result = await adminGetStaffMonthlySummaryDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getStaffDailyDetail') {
    const result = await adminGetStaffDailyDetailDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'meta.diag') {
    const result = await metaDiagDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'meta.checkCentral') {
    const result = await metaCheckCentralDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'meta.logoError') {
    const result = await metaLogoErrorDirect(payload.args || {});
    return send(res, result.status, result.body);
  }

  if (op === 'admin.testNcp') {
    const result = await adminTestNcpDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.listNotifyQueue') {
    const result = await adminListNotifyQueueDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.retryNotifyQueue') {
    const result = await adminRetryNotifyQueueDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.flushCache') {
    const result = await adminFlushCacheDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.listAbsenceExcuses') {
    const result = await assistantListAbsenceExcusesDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.addAbsenceExcuse') {
    const result = await assistantAddAbsenceExcuseDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.removeAbsenceExcuse') {
    const result = await assistantRemoveAbsenceExcuseDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.manualAttendance') {
    const result = await assistantManualAttendanceDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'absent.installTrigger') {
    const result = notImplementedDirect('GAS 트리거 설치는 Vercel 운영본에서 사용하지 않습니다. Vercel Cron으로 설정해야 합니다.');
    return send(res, result.status, result.body);
  }

  if (op === 'admin.installDailyTrigger') {
    const result = notImplementedDirect('GAS 데일리 트리거 설치는 Vercel 운영본에서 사용하지 않습니다. Vercel Cron으로 설정해야 합니다.');
    return send(res, result.status, result.body);
  }

  if (op === 'admin.generateSchedule') {
    const result = notImplementedDirect('스케줄 재생성은 중앙DB SSOT → Supabase replica sync worker 구현 후 활성화해야 합니다.');
    return send(res, result.status, result.body);
  }

  if (op === 'absent.runNow') {
    const result = await absentRunNowDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getRuntimeConfig') {
    const result = await adminGetRuntimeConfigDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.setKioskFloor') {
    const result = await adminSetKioskFloorDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.toggleSafe') {
    const result = await adminSetSafeModeDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }
  
  if (op === 'admin.setSafeMode') {
    const result = await adminSetSafeModeDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'teacher.setException') {
    const result = await teacherSetExceptionDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  return send(res, 400, {
    ok: false,
    error: {
      code: 'BAD_OP',
      message: '지원하지 않는 op 입니다: ' + op
    }
  });
}