import { randomUUID } from 'node:crypto';
import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  sendNcpTestMessageDirect,
  previewAttendanceNotifyPayloadDirect,
  previewAbsenceNotifyPayloadDirect
} from '../lib/attendance-notify.js';
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
  adminSetStudentExceptionHybrid,
  assistantUpsertAbsenceExcuseHybrid,
  assistantRemoveAbsenceExcuseHybrid
} from '../lib/rpc-hybrid-write.js';
import { proxyRpcToGas } from '../lib/gas-rpc-proxy.js';
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

function envReady(name) {
  return !!String(process.env[name] || '').trim();
}

function toPositiveIntBounded(value, fallback, min = 1, max = 10080) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function minutesSinceIso(isoText) {
  const ms = Date.parse(String(isoText || '').trim());
  if (!Number.isFinite(ms)) return null;
  return Math.floor((Date.now() - ms) / 60000);
}

async function readCentralReplicaDiag() {
  const maxStaleMin = toPositiveIntBounded(
    process.env.CENTRAL_REPLICA_MAX_STALE_MIN,
    1560,
    10,
    10080
  );

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('replica_sync_status')
      .select('sync_key, synced_at, status, trace_id, error, updated_at, counts_json')
      .eq('sync_key', 'central_db')
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        exists: false,
        status: 'ERROR',
        syncedAt: '',
        ageMin: null,
        maxStaleMin,
        stale: true,
        traceId: '',
        error: error.message || 'replica_sync_status 조회 실패'
      };
    }

    if (!data) {
      return {
        ok: false,
        exists: false,
        status: 'MISSING',
        syncedAt: '',
        ageMin: null,
        maxStaleMin,
        stale: true,
        traceId: '',
        error: '중앙DB sync 상태 기록이 없습니다.'
      };
    }

    const status = String(data.status || '').trim().toUpperCase();
    const ageMin = minutesSinceIso(data.synced_at);
    const stale = ageMin == null || ageMin > maxStaleMin;
    const ok = status === 'OK' && !stale;

    return {
      ok,
      exists: true,
      status,
      syncedAt: String(data.synced_at || ''),
      ageMin,
      maxStaleMin,
      stale,
      traceId: String(data.trace_id || ''),
      countsJson: data.counts_json && typeof data.counts_json === 'object' ? data.counts_json : {},
      error: String(data.error || '')
    };
  } catch (e) {
    return {
      ok: false,
      exists: false,
      status: 'ERROR',
      syncedAt: '',
      ageMin: null,
      maxStaleMin,
      stale: true,
      traceId: '',
      error: e?.message || '중앙DB sync 상태 확인 실패'
    };
  }
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

function manualStateAction(raw) {
  const action = String(raw || '').trim().toUpperCase();

  if (action === 'MANUAL_CHECK_IN') return 'CHECK_IN';
  if (action === 'MANUAL_CHECK_OUT') return 'CHECK_OUT';

  return action;
}

function manualStateIsoToMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function manualStateMsToIso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function emptyManualTodayState() {
  return {
    checkedIn: false,
    checkedOut: false,
    outingActive: false,
    lastActionType: '',
    lastActionTs: 0,
    lastMoveTs: 0,
    lastMoveFloor: '',
    lastCheckInTs: 0,
    lastCheckOutTs: 0
  };
}

function manualTodayStateFromRow(row) {
  if (!row) return emptyManualTodayState();

  return {
    checkedIn: row.checked_in === true,
    checkedOut: row.checked_out === true,
    outingActive: row.outing_active === true,
    lastActionType: String(row.last_action_type || '').trim().toUpperCase(),
    lastActionTs: manualStateIsoToMs(row.last_action_ts),
    lastMoveTs: manualStateIsoToMs(row.last_move_ts),
    lastMoveFloor: String(row.last_move_floor || '').trim().toUpperCase(),
    lastCheckInTs: manualStateIsoToMs(row.last_check_in_ts),
    lastCheckOutTs: manualStateIsoToMs(row.last_check_out_ts)
  };
}

function buildManualTodayStateFromLogs(rows, nowMs = Date.now()) {
  const state = emptyManualTodayState();
  const logs = Array.isArray(rows) ? rows.slice() : [];

  logs.sort((a, b) => {
    const ams = manualStateIsoToMs(a.ts);
    const bms = manualStateIsoToMs(b.ts);
    return ams - bms;
  });

  for (const row of logs) {
    const tsMs = manualStateIsoToMs(row.ts);
    if (!tsMs || tsMs > nowMs) continue;

    const rawAction = String(row.action_type || '').trim().toUpperCase();
    const action = manualStateAction(rawAction);

    state.lastActionType = rawAction || action || state.lastActionType;
    state.lastActionTs = tsMs;

    if (action === 'CHECK_IN') {
      state.checkedIn = true;
      state.checkedOut = false;
      state.outingActive = false;
      state.lastCheckInTs = tsMs;
      continue;
    }

    if (action === 'CHECK_OUT') {
      state.checkedOut = true;
      state.outingActive = false;
      state.lastCheckOutTs = tsMs;
      continue;
    }

    if (action === 'MOVE') {
      state.lastMoveTs = tsMs;
      state.lastMoveFloor = String(row.kiosk_floor || '').trim().toUpperCase();
      continue;
    }

    if (action === 'OUTING_OUT') {
      state.outingActive = true;
      continue;
    }

    if (action === 'OUTING_BACK') {
      state.outingActive = false;
    }
  }

  return state;
}

function applyManualActionToTodayState(currentState, rawAction, kioskFloor, now) {
  const nowMs = now.getTime();
  const action = manualStateAction(rawAction);
  const raw = String(rawAction || '').trim().toUpperCase();

  const next = {
    checkedIn: !!currentState?.checkedIn,
    checkedOut: !!currentState?.checkedOut,
    outingActive: !!currentState?.outingActive,
    lastActionType: raw || action,
    lastActionTs: nowMs,
    lastMoveTs: Number(currentState?.lastMoveTs || 0),
    lastMoveFloor: String(currentState?.lastMoveFloor || '').trim().toUpperCase(),
    lastCheckInTs: Number(currentState?.lastCheckInTs || 0),
    lastCheckOutTs: Number(currentState?.lastCheckOutTs || 0)
  };

  if (action === 'CHECK_IN') {
    next.checkedIn = true;
    next.checkedOut = false;
    next.outingActive = false;
    next.lastCheckInTs = nowMs;
  }

  if (action === 'CHECK_OUT') {
    next.checkedOut = true;
    next.outingActive = false;
    next.lastCheckOutTs = nowMs;
  }

  if (action === 'MOVE') {
    next.lastMoveTs = nowMs;
    next.lastMoveFloor = String(kioskFloor || '').trim().toUpperCase();
  }

  if (action === 'OUTING_OUT') {
    next.outingActive = true;
  }

  if (action === 'OUTING_BACK') {
    next.outingActive = false;
  }

  return next;
}

async function loadManualTodayState(supabase, sid, yyyymmdd) {
  const { data: stateRow, error: stateErr } = await supabase
    .from('today_student_state')
    .select(
      'yyyymmdd, student_id, checked_in, checked_out, outing_active, last_action_type, last_action_ts, last_move_ts, last_move_floor, last_check_in_ts, last_check_out_ts'
    )
    .eq('yyyymmdd', yyyymmdd)
    .eq('student_id', sid)
    .maybeSingle();

  if (!stateErr && stateRow) {
    return {
      ok: true,
      state: manualTodayStateFromRow(stateRow),
      source: 'today_student_state'
    };
  }

  const { data: logs, error: logsErr } = await supabase
    .from('attendance_logs')
    .select('ts, action_type, kiosk_floor, result')
    .eq('yyyymmdd', yyyymmdd)
    .eq('student_id', sid)
    .eq('result', 'OK')
    .in('action_type', [
      'CHECK_IN',
      'CHECK_OUT',
      'MOVE',
      'OUTING_OUT',
      'OUTING_BACK',
      'MANUAL_CHECK_IN',
      'MANUAL_CHECK_OUT'
    ])
    .order('ts', { ascending: true });

  if (logsErr) {
    return {
      ok: false,
      state: emptyManualTodayState(),
      source: stateErr ? 'state_error_then_logs_error' : 'logs_error',
      error: logsErr.message || 'attendance_logs 상태 조회 실패'
    };
  }

  return {
    ok: true,
    state: buildManualTodayStateFromLogs(logs || []),
    source: stateErr ? 'logs_fallback_after_state_error' : 'logs_fallback'
  };
}

async function upsertManualTodayState({
  supabase,
  yyyymmdd,
  sid,
  currentState,
  actionType,
  kioskFloor,
  now,
  actor,
  reason,
  sourceTraceId,
  stateSource
}) {
  const next = applyManualActionToTodayState(currentState, actionType, kioskFloor, now);

  const row = {
    yyyymmdd,
    student_id: sid,
    checked_in: next.checkedIn,
    checked_out: next.checkedOut,
    outing_active: next.outingActive,
    last_action_type: next.lastActionType,
    last_action_ts: manualStateMsToIso(next.lastActionTs),
    last_move_ts: manualStateMsToIso(next.lastMoveTs),
    last_move_floor: next.lastMoveFloor,
    last_check_in_ts: manualStateMsToIso(next.lastCheckInTs),
    last_check_out_ts: manualStateMsToIso(next.lastCheckOutTs),
    updated_at: now.toISOString(),
    meta_json: {
      source: 'assistant.manualAttendance',
      state_source: stateSource || '',
      actor: String(actor || ''),
      reason: String(reason || '').slice(0, 300),
      source_trace_id: String(sourceTraceId || '')
    }
  };

  const { error } = await supabase
    .from('today_student_state')
    .upsert([row], { onConflict: 'yyyymmdd,student_id' });

  if (error) {
    return {
      ok: false,
      error: error.message || 'today_student_state 수동정정 upsert 실패'
    };
  }

  return {
    ok: true,
    state: next
  };
}

function rebuildStateAction(raw) {
  const action = String(raw || '').trim().toUpperCase();
  if (action === 'MANUAL_CHECK_IN') return 'CHECK_IN';
  if (action === 'MANUAL_CHECK_OUT') return 'CHECK_OUT';
  return action;
}

function rebuildStateFromLogRows(rows) {
  const byStudent = new Map();

  for (const row of rows || []) {
    const sid = normalizeStudentId(row.student_id);
    if (!sid) continue;

    if (!byStudent.has(sid)) {
      byStudent.set(sid, {
        yyyymmdd: String(row.yyyymmdd || '').trim(),
        student_id: sid,
        checked_in: false,
        checked_out: false,
        outing_active: false,
        last_action_type: '',
        last_action_ts: null,
        last_move_ts: null,
        last_move_floor: '',
        last_check_in_ts: null,
        last_check_out_ts: null,
        updated_at: new Date().toISOString(),
        meta_json: {
          source: 'admin.rebuildTodayState'
        }
      });
    }

    const state = byStudent.get(sid);
    const rawAction = String(row.action_type || '').trim().toUpperCase();
    const action = rebuildStateAction(rawAction);
    const ts = String(row.ts || '').trim();

    state.last_action_type = rawAction || action;
    state.last_action_ts = ts || null;

    if (action === 'CHECK_IN') {
      state.checked_in = true;
      state.checked_out = false;
      state.outing_active = false;
      state.last_check_in_ts = ts || null;
      continue;
    }

    if (action === 'CHECK_OUT') {
      state.checked_out = true;
      state.outing_active = false;
      state.last_check_out_ts = ts || null;
      continue;
    }

    if (action === 'MOVE') {
      state.last_move_ts = ts || null;
      state.last_move_floor = String(row.kiosk_floor || '').trim().toUpperCase();
      continue;
    }

    if (action === 'OUTING_OUT') {
      state.outing_active = true;
      continue;
    }

    if (action === 'OUTING_BACK') {
      state.outing_active = false;
    }
  }

  return Array.from(byStudent.values());
}

async function adminRebuildTodayStateDirect(args = {}, sessionToken = '') {
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

  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  if (!isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd 8자리가 필요합니다.');
  }

  const sid = args.student_id ? normalizeStudentId(args.student_id) : '';
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('attendance_logs')
    .select('yyyymmdd, ts, student_id, action_type, kiosk_floor, result')
    .eq('yyyymmdd', yyyymmdd)
    .eq('result', 'OK')
    .in('action_type', [
      'CHECK_IN',
      'CHECK_OUT',
      'MOVE',
      'OUTING_OUT',
      'OUTING_BACK',
      'MANUAL_CHECK_IN',
      'MANUAL_CHECK_OUT'
    ])
    .order('ts', { ascending: true })
    .limit(5000);

  if (sid) {
    query = query.eq('student_id', sid);
  }

  const { data: logs, error: readErr } = await query;
  if (readErr) {
    return fail(500, 'DB_SELECT_FAILED', readErr.message || 'attendance_logs 조회 실패');
  }

  const rows = rebuildStateFromLogRows(logs || []);
  if (!rows.length) {
    return success({
      yyyymmdd,
      student_id: sid,
      log_count: Array.isArray(logs) ? logs.length : 0,
      rebuilt_count: 0
    });
  }

  const { data, error } = await supabase
    .from('today_student_state')
    .upsert(rows, { onConflict: 'yyyymmdd,student_id' })
    .select('yyyymmdd, student_id');

  if (error) {
    return fail(500, 'DB_UPSERT_FAILED', error.message || 'today_student_state 재빌드 실패');
  }

  return success({
    yyyymmdd,
    student_id: sid,
    log_count: Array.isArray(logs) ? logs.length : 0,
    rebuilt_count: Array.isArray(data) ? data.length : rows.length,
    run_by: auth.me.staff_id
  });
}


function boolText(value) {
  return value === true ? 'Y' : 'N';
}

function normalizeStateForCompare(row) {
  return {
    checked_in: row?.checked_in === true,
    checked_out: row?.checked_out === true,
    outing_active: row?.outing_active === true,
    last_action_type: String(row?.last_action_type || '').trim().toUpperCase()
  };
}

function buildStateMismatchItems(expectedRows, actualRows) {
  const expectedMap = new Map();
  const actualMap = new Map();

  for (const row of expectedRows || []) {
    const sid = normalizeStudentId(row.student_id);
    if (!sid) continue;
    expectedMap.set(sid, row);
  }

  for (const row of actualRows || []) {
    const sid = normalizeStudentId(row.student_id);
    if (!sid) continue;
    actualMap.set(sid, row);
  }

  const items = [];

  for (const [sid, expected] of expectedMap.entries()) {
    const actual = actualMap.get(sid) || null;
    const e = normalizeStateForCompare(expected);
    const a = normalizeStateForCompare(actual);

    const diffs = [];

    if (!actual) {
      diffs.push('STATE_ROW_MISSING');
    }

    if (e.checked_in !== a.checked_in) {
      diffs.push('checked_in expected=' + boolText(e.checked_in) + ' actual=' + boolText(a.checked_in));
    }

    if (e.checked_out !== a.checked_out) {
      diffs.push('checked_out expected=' + boolText(e.checked_out) + ' actual=' + boolText(a.checked_out));
    }

    if (e.outing_active !== a.outing_active) {
      diffs.push('outing_active expected=' + boolText(e.outing_active) + ' actual=' + boolText(a.outing_active));
    }

    if (e.last_action_type && e.last_action_type !== a.last_action_type) {
      diffs.push('last_action_type expected=' + e.last_action_type + ' actual=' + (a.last_action_type || ''));
    }

    if (diffs.length) {
      items.push({
        student_id: sid,
        kind: actual ? 'MISMATCH' : 'MISSING_STATE',
        expected: e,
        actual: actual ? a : null,
        diffs
      });
    }
  }

  for (const [sid, actual] of actualMap.entries()) {
    if (expectedMap.has(sid)) continue;

    const a = normalizeStateForCompare(actual);
    items.push({
      student_id: sid,
      kind: 'ORPHAN_STATE_ROW',
      expected: null,
      actual: a,
      diffs: ['ORPHAN_STATE_ROW: attendance_logs 원본 없이 today_student_state만 존재']
    });
  }

  return items;
}

async function adminScanTodayStateMismatchDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  if (!isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd 8자리가 필요합니다.');
  }

  const supabase = getSupabaseAdmin();

  const { data: logs, error: logErr } = await supabase
    .from('attendance_logs')
    .select('yyyymmdd, ts, student_id, action_type, kiosk_floor, result')
    .eq('yyyymmdd', yyyymmdd)
    .eq('result', 'OK')
    .in('action_type', [
      'CHECK_IN',
      'CHECK_OUT',
      'MOVE',
      'OUTING_OUT',
      'OUTING_BACK',
      'MANUAL_CHECK_IN',
      'MANUAL_CHECK_OUT'
    ])
    .order('ts', { ascending: true })
    .limit(10000);

  if (logErr) {
    return fail(500, 'DB_SELECT_FAILED', logErr.message || 'attendance_logs 조회 실패');
  }

  const expectedRows = rebuildStateFromLogRows(logs || []);

  const { data: actualRows, error: stateErr } = await supabase
    .from('today_student_state')
    .select('yyyymmdd, student_id, checked_in, checked_out, outing_active, last_action_type')
    .eq('yyyymmdd', yyyymmdd)
    .limit(10000);

  if (stateErr) {
    return fail(500, 'DB_SELECT_FAILED', stateErr.message || 'today_student_state 조회 실패');
  }

  const items = buildStateMismatchItems(expectedRows, actualRows);
  const studentNameMap = await readStudentNameMap(
    supabase,
    items.map(item => item?.student_id)
  );
  const enrichedItems = items.map(item => {
    const studentId = normalizeStudentId(item?.student_id);
    return {
      ...item,
      student_id: studentId,
      student_name: studentNameMap[studentId] || ''
    };
  });

  return success({
    yyyymmdd,
    log_count: Array.isArray(logs) ? logs.length : 0,
    expected_student_count: expectedRows.length,
    actual_state_count: Array.isArray(actualRows) ? actualRows.length : 0,
    mismatch_count: enrichedItems.length,
    items: enrichedItems
  });
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

  const centralReplica = await readCentralReplicaDiag();

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
    absentStageMinutes: String(process.env.ABSENT_STAGE_MINUTES || '5,20').trim(),
    absentStageCatchupGraceMin: String(process.env.ABSENT_STAGE_CATCHUP_GRACE_MIN || '15').trim(),
    absentQueueMaxAgeMin: String(process.env.ABSENT_QUEUE_MAX_AGE_MIN || '20').trim(),
    absentCronWorkerLimit: String(process.env.ABSENT_CRON_WORKER_LIMIT || '20').trim(),
    centralReplicaOk: !!centralReplica.ok,
    centralReplicaStatus: centralReplica.status || '',
    centralReplicaSyncedAt: centralReplica.syncedAt || '',
    centralReplicaAgeMin: centralReplica.ageMin == null ? '' : String(centralReplica.ageMin),
    centralReplicaMaxStaleMin: String(centralReplica.maxStaleMin || ''),
    centralReplicaStale: !!centralReplica.stale,
    centralReplicaTraceId: centralReplica.traceId || '',
    centralReplicaCountsJson: centralReplica.countsJson || {},
    centralReplicaError: centralReplica.error || '',
    alimtalkServiceSet: envReady('NCP_ALIMTALK_SERVICE_ID'),
    smsServiceSet: envReady('NCP_SMS_SERVICE_ID'),
    ncpSmsFailoverOn:
      String(process.env.USE_SMS_FAILOVER || 'N').trim().toUpperCase() === 'Y',
    attendanceDirectSmsFallbackOn:
      String(
        process.env.ATT_NOTIFY_SMS_AFTER_ALIM_FAIL ||
        process.env.USE_SMS_FAILOVER ||
        'N'
      ).trim().toUpperCase() === 'Y',
    absenceDirectSmsFallbackOn:
      String(
        process.env.ABSENT_NOTIFY_SMS_AFTER_ALIM_FAIL ||
        process.env.USE_SMS_FAILOVER ||
        'N'
      ).trim().toUpperCase() === 'Y',
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

async function checkTableReadable(supabase, tableName, selectExpr = '*', options = {}) {
  const required = options.required !== false;

  const { data, error } = await supabase
    .from(tableName)
    .select(selectExpr)
    .limit(1);

  return {
    name: tableName,
    ok: !error,
    required,
    count: Array.isArray(data) ? data.length : null,
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
      name: 'staff_snapshot',
      required: false,
      columns: 'staff_id, name, role, revoked, status, pw_hash, pw_salt, pin_hash, pin_salt'
    },
    {
      name: 'class_students',
      columns: 'class_id, student_id'
    },
    {
      name: 'class_exceptions',
      columns: 'class_id, yyyymmdd, reason, created_at, created_by, updated_at, updated_by'
    },
    {
      name: 'holidays',
      columns: 'yyyymmdd, name, note, created_at, actor'
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
      name: 'today_student_state',
      columns: 'yyyymmdd, student_id, checked_in, checked_out, outing_active, last_action_type, last_action_ts, last_move_ts, last_move_floor, last_check_in_ts, last_check_out_ts, updated_at, meta_json'
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
      name: 'notify_worker_runs',
      columns: 'run_id, created_at, source, status, scanned, claimed, done, failed, requeued, skipped, detail_json, error'
    },
    {
      name: 'absence_detection_runs',
      columns: 'run_id, created_at, source, status, run_by, yyyymmdd, started_at, finished_at, scheduled_class_count, candidate_count, queued_count, duplicate_count, failed_count, sent_count, worker_done, worker_failed, worker_requeued, detail_json, error'
    },
    {
      name: 'replica_sync_status',
      columns: 'sync_key, synced_at, status, trace_id, counts_json, error, updated_at'
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
      columns: 'token, staff_id, public_session_id, exp_ms, staff_name, role'
    },
    {
      name: 'staff_qr_nonces',
      columns: 'nonce, staff_id, public_session_id, exp_ms, used'
    }
  ];

  const checks = [];
  for (const item of tableChecks) {
    checks.push(await checkTableReadable(supabase, item.name, item.columns, {
      required: item.required !== false
    }));
  }

  const allRequiredOk = checks.every(x => x.ok || x.required === false);

  return success({
    ok: allRequiredOk,
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

async function adminListAbsenceRunsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const limit = Math.max(1, Math.min(100, Number(args.limit || 30)));
  const source = String(args.source || '').trim().toUpperCase();
  const status = String(args.status || '').trim().toUpperCase();

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('absence_detection_runs')
    .select(
      'run_id, created_at, source, status, run_by, yyyymmdd, scheduled_class_count, candidate_count, queued_count, duplicate_count, failed_count, sent_count, worker_done, worker_failed, worker_requeued, error'
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (source) query = query.eq('source', source);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'absence_detection_runs 조회 실패');
  }

  return success({
    count: Array.isArray(data) ? data.length : 0,
    items: data || []
  });
}

async function adminListNotifyWorkerRunsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const limit = Math.max(1, Math.min(100, Number(args.limit || 30)));
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('notify_worker_runs')
    .select('run_id, created_at, source, status, scanned, claimed, done, failed, requeued, skipped, error')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'notify_worker_runs 조회 실패');
  }

  return success({
    count: Array.isArray(data) ? data.length : 0,
    items: data || []
  });
}

async function deleteExpiredQrRows(supabase, tableName, selectExpr, nowMs) {
  const { data, error } = await supabase
    .from(tableName)
    .delete()
    .lt('exp_ms', nowMs)
    .select(selectExpr);

  if (error) {
    return {
      ok: false,
      table: tableName,
      deleted: 0,
      error: error.message || tableName + ' 만료 row 삭제 실패'
    };
  }

  return {
    ok: true,
    table: tableName,
    deleted: Array.isArray(data) ? data.length : 0,
    error: ''
  };
}

async function deleteExpiredIsoRows(supabase, tableName, selectExpr, columnName, nowIsoText) {
  const { data, error } = await supabase
    .from(tableName)
    .delete()
    .lt(columnName, nowIsoText)
    .select(selectExpr);

  if (error) {
    return {
      ok: false,
      table: tableName,
      deleted: 0,
      error: error.message || tableName + ' 만료 row 삭제 실패'
    };
  }

  return {
    ok: true,
    table: tableName,
    deleted: Array.isArray(data) ? data.length : 0,
    error: ''
  };
}

async function deleteOldRowsByColumn(supabase, tableName, selectExpr, columnName, cutoffIso, filter = null) {
  let query = supabase
    .from(tableName)
    .delete()
    .lt(columnName, cutoffIso);

  if (filter && filter.column && filter.value != null) {
    query = query.eq(filter.column, filter.value);
  }

  const { data, error } = await query.select(selectExpr);

  if (error) {
    return {
      ok: false,
      table: tableName,
      deleted: 0,
      error: error.message || tableName + ' 오래된 row 삭제 실패'
    };
  }

  return {
    ok: true,
    table: tableName,
    deleted: Array.isArray(data) ? data.length : 0,
    error: ''
  };
}

async function countRowsByColumn(supabase, tableName, columnName, cutoffValue, filter = null) {
  let query = supabase
    .from(tableName)
    .select('*', { count: 'exact', head: true })
    .lt(columnName, cutoffValue);

  if (filter && filter.column && filter.value != null) {
    query = query.eq(filter.column, filter.value);
  }

  const { count, error } = await query;

  if (error) {
    return {
      ok: false,
      table: tableName,
      count: 0,
      error: error.message || tableName + ' count 실패'
    };
  }

  return {
    ok: true,
    table: tableName,
    count: Number(count || 0),
    error: ''
  };
}

function daysAgoIso(days) {
  return new Date(Date.now() - (Number(days || 0) * 24 * 60 * 60 * 1000)).toISOString();
}

async function adminCleanupQrExpiredDirect(args = {}, sessionToken = '') {
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

  const dryRun = String(args.dry_run || args.dryRun || 'N').trim().toUpperCase() === 'Y';
  const supabase = getSupabaseAdmin();
  const nowMs = Date.now();
  const nowText = nowIso();

  const auditKeepDays = Math.max(30, Math.min(365, Number(args.audit_keep_days || 180)));
  const pinAttemptKeepDays = Math.max(7, Math.min(180, Number(args.pin_attempt_keep_days || 30)));

  if (dryRun) {
    const previewItems = [];

    previewItems.push(await countRowsByColumn(supabase, 'student_qr_nonces', 'exp_ms', nowMs));
    previewItems.push(await countRowsByColumn(supabase, 'student_qr_sessions', 'exp_ms', nowMs));
    previewItems.push(await countRowsByColumn(supabase, 'staff_qr_nonces', 'exp_ms', nowMs));
    previewItems.push(await countRowsByColumn(supabase, 'staff_qr_sessions', 'exp_ms', nowMs));
    previewItems.push(await countRowsByColumn(supabase, 'staff_sessions', 'expires_at', nowText));
    previewItems.push(await countRowsByColumn(supabase, 'kiosk_pin_approvals', 'expires_at', nowText));
    previewItems.push(await countRowsByColumn(
      supabase,
      'kiosk_pin_attempts',
      'updated_at',
      daysAgoIso(pinAttemptKeepDays)
    ));
    previewItems.push(await countRowsByColumn(
      supabase,
      'attendance_notify_queue',
      'created_at',
      daysAgoIso(auditKeepDays),
      { column: 'status', value: 'DONE' }
    ));
    previewItems.push(await countRowsByColumn(
      supabase,
      'notify_worker_runs',
      'created_at',
      daysAgoIso(auditKeepDays)
    ));
    previewItems.push(await countRowsByColumn(
      supabase,
      'absence_detection_runs',
      'created_at',
      daysAgoIso(auditKeepDays)
    ));

    const failedPreview = previewItems.filter(x => !x.ok);

    return success({
      dry_run: true,
      cleaned_at: nowIso(),
      run_by: auth.me.staff_id,
      audit_keep_days: auditKeepDays,
      pin_attempt_keep_days: pinAttemptKeepDays,
      total_would_delete: previewItems.reduce((sum, x) => sum + Number(x.count || 0), 0),
      failed_count: failedPreview.length,
      ok: failedPreview.length === 0,
      items: previewItems,
      message: failedPreview.length
        ? 'dry_run=Y: 일부 테이블 count에 실패했습니다. 실제 삭제 전 오류를 확인하세요.'
        : 'dry_run=Y: 실제 삭제는 수행하지 않았습니다.'
    });
  }

  const results = [];

  results.push(await deleteExpiredQrRows(supabase, 'student_qr_nonces', 'nonce', nowMs));
  results.push(await deleteExpiredQrRows(supabase, 'student_qr_sessions', 'token', nowMs));
  results.push(await deleteExpiredQrRows(supabase, 'staff_qr_nonces', 'nonce', nowMs));
  results.push(await deleteExpiredQrRows(supabase, 'staff_qr_sessions', 'token', nowMs));

  results.push(await deleteExpiredIsoRows(
    supabase,
    'staff_sessions',
    'session_token_hash, expires_at',
    'expires_at',
    nowText
  ));
  results.push(await deleteExpiredIsoRows(supabase, 'kiosk_pin_approvals', 'student_id, expires_at', 'expires_at', nowText));

  results.push(await deleteOldRowsByColumn(
    supabase,
    'kiosk_pin_attempts',
    'staff_id, student_id, updated_at',
    'updated_at',
    daysAgoIso(pinAttemptKeepDays)
  ));

  results.push(await deleteOldRowsByColumn(
    supabase,
    'attendance_notify_queue',
    'queue_id, created_at, status',
    'created_at',
    daysAgoIso(auditKeepDays),
    { column: 'status', value: 'DONE' }
  ));

  results.push(await deleteOldRowsByColumn(
    supabase,
    'notify_worker_runs',
    'run_id, created_at',
    'created_at',
    daysAgoIso(auditKeepDays)
  ));

  results.push(await deleteOldRowsByColumn(
    supabase,
    'absence_detection_runs',
    'run_id, created_at',
    'created_at',
    daysAgoIso(auditKeepDays)
  ));

  const failed = results.filter(x => !x.ok);
  if (failed.length) {
    return fail(
      500,
      'CLEANUP_PARTIAL_FAILED',
      '운영 만료 정리 중 일부 테이블에서 실패했습니다.',
      {
        failed,
        items: results
      }
    );
  }

  return success({
    dry_run: false,
    cleaned_at: nowIso(),
    run_by: auth.me.staff_id,
    total_deleted: results.reduce((sum, x) => sum + Number(x.deleted || 0), 0),
    failed_count: 0,
    audit_keep_days: auditKeepDays,
    pin_attempt_keep_days: pinAttemptKeepDays,
    items: results
  });
}

async function adminPreviewNotifyPayloadDirect(args = {}, sessionToken = '') {
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

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  if (!sid) {
    return fail(400, 'INVALID_INPUT', '학번 4자리가 필요합니다.');
  }

  const supabase = getSupabaseAdmin();
  const { data: student, error } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, parent_phone')
    .eq('student_id', sid)
    .maybeSingle();

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'students 조회 실패');
  }

  if (!student) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
  }

  return success({
    student,
    attendance_check_in: previewAttendanceNotifyPayloadDirect(student, 'CHECK_IN'),
    attendance_check_out: previewAttendanceNotifyPayloadDirect(student, 'CHECK_OUT'),
    absence: previewAbsenceNotifyPayloadDirect(student)
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

async function adminRunCentralReplicaSyncDirect(args = {}, sessionToken = '') {
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

  const requestedTimeoutMs = Number(process.env.CENTRAL_SYNC_TIMEOUT_MS || 55000);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? requestedTimeoutMs
    : 55000;

  const result = await proxyRpcToGas(
    'bridge.replica.sync.run',
    {
      actor_staff_id: auth.me.staff_id,
      actor_role: normalizeRole(auth.me.role),
      actor_name: String(auth.me.name || '')
    },
    '',
    { timeoutMs }
  );

  return result;
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
      limit: Math.max(1, Math.min(20, Number(data.queuedCount || 1))),
      source: 'MANUAL_ABSENT_RUN'
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

async function readStudentNameMap(supabase, studentIds = []) {
  const ids = Array.from(new Set(
    (studentIds || [])
      .map(normalizeStudentId)
      .filter(Boolean)
  ));

  if (!ids.length) return {};

  const { data, error } = await supabase
    .from('students')
    .select('student_id, student_name')
    .in('student_id', ids);

  if (error) return {};

  return (Array.isArray(data) ? data : []).reduce((acc, row) => {
    const sid = normalizeStudentId(row?.student_id);
    if (sid) acc[sid] = String(row?.student_name || '').trim();
    return acc;
  }, {});
}

async function readClassNameMap(supabase, classIds = []) {
  const ids = Array.from(new Set(
    (classIds || [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  ));

  if (!ids.length) return {};

  const { data, error } = await supabase
    .from('classes')
    .select('class_id, name')
    .in('class_id', ids);

  if (error) return {};

  return (Array.isArray(data) ? data : []).reduce((acc, row) => {
    const classId = String(row?.class_id || '').trim();
    if (classId) acc[classId] = String(row?.name || '').trim();
    return acc;
  }, {});
}

async function readStaffNameMap(supabase, staffIds = []) {
  const ids = Array.from(new Set(
    (staffIds || [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  ));

  if (!ids.length) return {};

  const { data, error } = await supabase
    .from('staff')
    .select('staff_id, name')
    .in('staff_id', ids);

  if (error) return {};

  return (Array.isArray(data) ? data : []).reduce((acc, row) => {
    const staffId = String(row?.staff_id || '').trim().toLowerCase();
    if (staffId) acc[staffId] = String(row?.name || '').trim();
    return acc;
  }, {});
}

async function assistantSearchStudentsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const raw = String(args.q || args.keyword || '').trim().slice(0, 40);
  const keyword = raw.replace(/[%_]/g, '').trim();
  const classId = String(args.class_id || args.classId || '').trim();
  const limit = Math.max(1, Math.min(40, toPositiveInt(args.limit, 20)));

  if (!keyword) {
    return success({ count: 0, items: [] });
  }

  const supabase = getSupabaseAdmin();
  let scopedStudentIds = [];

  if (classId) {
    const { data: relations, error: relationError } = await supabase
      .from('class_students')
      .select('student_id')
      .eq('class_id', classId)
      .limit(1200);

    if (relationError) {
      return fail(500, 'DB_SELECT_FAILED', relationError.message || '반별 학생 관계 조회 실패');
    }

    scopedStudentIds = Array.from(new Set(
      (Array.isArray(relations) ? relations : [])
        .map(row => normalizeStudentId(row?.student_id))
        .filter(Boolean)
    ));

    if (!scopedStudentIds.length) {
      return success({ count: 0, items: [] });
    }
  }

  const digits = keyword.replace(/[^0-9]/g, '');
  let query = supabase
    .from('students')
    .select('student_id, student_name, school, grade, status')
    .order('student_name', { ascending: true })
    .limit(limit);

  if (scopedStudentIds.length) {
    query = query.in('student_id', scopedStudentIds);
  }

  if (/^\d{1,4}$/.test(digits) && digits.length === keyword.length) {
    query = query.ilike('student_id', `%${digits}%`);
  } else {
    query = query.ilike('student_name', `%${keyword}%`);
  }

  const { data, error } = await query;
  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || '학생 검색 실패');
  }

  const items = (Array.isArray(data) ? data : []).map(row => ({
    student_id: normalizeStudentId(row?.student_id),
    student_name: String(row?.student_name || '').trim(),
    school: String(row?.school || '').trim(),
    grade: String(row?.grade || '').trim(),
    status: String(row?.status || '').trim()
  })).filter(item => item.student_id);

  return success({
    count: items.length,
    items
  });
}


async function assistantListClassOptionsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const limit = Math.max(1, Math.min(1000, toPositiveInt(args.limit, 500)));
  const includeInactive = args.include_inactive === true || args.includeInactive === true;
  const supabase = getSupabaseAdmin();

  if (yyyymmdd && !isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd는 8자리 숫자여야 합니다.');
  }

  if (yyyymmdd) {
    let scheduleQuery = supabase
      .from('class_schedule')
      .select('yyyymmdd, class_id, class_name, teacher, start, end, status')
      .eq('yyyymmdd', yyyymmdd)
      .order('start', { ascending: true })
      .limit(limit);

    if (!includeInactive) {
      scheduleQuery = scheduleQuery.eq('status', 'SCHEDULED');
    }

    const { data: scheduleRows, error: scheduleErr } = await scheduleQuery;
    if (scheduleErr) {
      return fail(500, 'DB_SELECT_FAILED', scheduleErr.message || 'class_schedule 조회 실패');
    }

    const schedules = Array.isArray(scheduleRows) ? scheduleRows : [];
    const classIds = Array.from(new Set(
      schedules
        .map(row => String(row?.class_id || '').trim())
        .filter(Boolean)
    ));

    const classMap = new Map();
    if (classIds.length) {
      const { data: classRows, error: classErr } = await supabase
        .from('classes')
        .select('class_id, name, teacher, start, end, room, alert_delay, alert_to, status')
        .in('class_id', classIds)
        .limit(classIds.length);

      if (classErr) {
        return fail(500, 'DB_SELECT_FAILED', classErr.message || 'classes 조회 실패');
      }

      for (const row of Array.isArray(classRows) ? classRows : []) {
        const classId = String(row?.class_id || '').trim();
        if (classId) classMap.set(classId, row);
      }
    }

    const staffNameMap = await readStaffNameMap(
      supabase,
      schedules.map(row => row?.teacher).filter(Boolean)
    );

    const items = schedules.map(row => {
      const classId = String(row?.class_id || '').trim();
      const classRow = classMap.get(classId) || {};
      const teacher = String(row?.teacher || classRow.teacher || '').trim();

      return {
        yyyymmdd,
        class_id: classId,
        name: String(row?.class_name || classRow.name || '').trim(),
        class_name: String(row?.class_name || classRow.name || '').trim(),
        teacher,
        teacher_name: staffNameMap[String(teacher).toLowerCase()] || teacher,
        start: String(row?.start || classRow.start || '').trim(),
        end: String(row?.end || classRow.end || '').trim(),
        room: String(classRow.room || '').trim(),
        alert_delay: String(classRow.alert_delay || '').trim(),
        alert_to: String(classRow.alert_to || '').trim(),
        status: String(row?.status || classRow.status || '').trim()
      };
    }).filter(item => item.class_id);

    return success({
      yyyymmdd,
      count: items.length,
      items
    });
  }

  let classQuery = supabase
    .from('classes')
    .select('class_id, name, teacher, start, end, room, alert_delay, alert_to, status')
    .order('start', { ascending: true })
    .limit(limit);
  const { data: classRows, error: classErr } = await classQuery;
  if (classErr) {
    return fail(500, 'DB_SELECT_FAILED', classErr.message || 'classes 조회 실패');
  }

  const rows = Array.isArray(classRows) ? classRows : [];
  const staffNameMap = await readStaffNameMap(
    supabase,
    rows.map(row => row?.teacher).filter(Boolean)
  );

  const items = rows.map(row => {
    const teacher = String(row?.teacher || '').trim();
    const classId = String(row?.class_id || '').trim();
    const name = String(row?.name || '').trim();

    return {
      class_id: classId,
      name,
      class_name: name,
      teacher,
      teacher_name: staffNameMap[String(teacher).toLowerCase()] || teacher,
      start: String(row?.start || '').trim(),
      end: String(row?.end || '').trim(),
      room: String(row?.room || '').trim(),
      alert_delay: String(row?.alert_delay || '').trim(),
      alert_to: String(row?.alert_to || '').trim(),
      status: String(row?.status || '').trim()
    };
  }).filter(item => item.class_id);

  return success({
    count: items.length,
    items
  });
}

async function assistantListClassRosterDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const classId = String(args.class_id || args.classId || '').trim();
  if (!classId) {
    return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  }

  const supabase = getSupabaseAdmin();
  const { data: relRows, error: relErr } = await supabase
    .from('class_students')
    .select('student_id')
    .eq('class_id', classId)
    .limit(2000);

  if (relErr) {
    return fail(500, 'DB_SELECT_FAILED', relErr.message || '반별 학생 관계 조회 실패');
  }

  const studentIds = Array.from(new Set(
    (Array.isArray(relRows) ? relRows : [])
      .map(row => normalizeStudentId(row?.student_id))
      .filter(Boolean)
  ));

  if (!studentIds.length) {
    return success({ class_id: classId, count: 0, items: [] });
  }

  const { data: students, error: stuErr } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, status')
    .in('student_id', studentIds)
    .order('student_name', { ascending: true })
    .limit(2000);

  if (stuErr) {
    return fail(500, 'DB_SELECT_FAILED', stuErr.message || 'students 조회 실패');
  }

  const items = (Array.isArray(students) ? students : [])
    .map(row => ({
      student_id: normalizeStudentId(row?.student_id),
      student_name: String(row?.student_name || '').trim(),
      school: String(row?.school || '').trim(),
      grade: String(row?.grade || '').trim(),
      status: String(row?.status || '').trim()
    }))
    .filter(item => item.student_id);

  return success({
    class_id: classId,
    count: items.length,
    items
  });
}


function normalizeBool(raw, fallback = false) {
  if (typeof raw === 'boolean') return raw;
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return ['1', 'y', 'yes', 'true', 'on', '공개'].includes(v);
}

function normalizeLimitedText(raw, max = 500) {
  return String(raw ?? '').trim().slice(0, max);
}

function normalizeClinicStatus(raw, fallback = 'CANDIDATE') {
  const value = String(raw || '').trim().toUpperCase();
  const allowed = new Set(['CANDIDATE', 'PENDING', 'IN_PROGRESS', 'DONE', 'PARTIAL', 'REJECTED', 'CANCELLED']);
  return allowed.has(value) ? value : fallback;
}

function normalizeClinicTaskType(raw, fallback = 'GENERAL') {
  const value = String(raw || '').trim().toUpperCase();
  const allowed = new Set(['GENERAL', 'WORD', 'GRAMMAR', 'READING', 'WRITING', 'ATTENDANCE', 'HOMEWORK', 'MAKEUP']);
  return allowed.has(value) ? value : fallback;
}

function normalizeClinicSourceType(raw, fallback = 'MANUAL') {
  const value = String(raw || '').trim().toUpperCase();
  const allowed = new Set(['MANUAL', 'WORD_FAIL', 'ATTENDANCE', 'ABSENCE', 'HOMEWORK', 'REPORT']);
  return allowed.has(value) ? value : fallback;
}

function normalizeClinicPriority(raw, fallback = 'NORMAL') {
  const value = String(raw || '').trim().toUpperCase();
  const allowed = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
  return allowed.has(value) ? value : fallback;
}

function normalizeWordResultStatus(raw, score, passScore) {
  const value = String(raw || '').trim().toUpperCase();
  if (['PASS', 'FAIL', 'ABSENT', 'EXEMPT'].includes(value)) return value;
  const n = Number(score);
  const p = Number(passScore);
  if (Number.isFinite(n) && Number.isFinite(p)) return n >= p ? 'PASS' : 'FAIL';
  return 'PASS';
}

function normalizeScore(raw, fallback = null) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : fallback;
}

function terminalClinicStatus(status) {
  return ['DONE', 'PARTIAL', 'REJECTED', 'CANCELLED'].includes(normalizeClinicStatus(status));
}

function mapClinicTaskRow(row, studentNameMap = {}, classNameMap = {}) {
  const sid = normalizeStudentId(row?.student_id);
  const classId = String(row?.class_id || '').trim();
  return {
    clinic_task_id: String(row?.clinic_task_id || '').trim(),
    student_id: sid,
    student_name: studentNameMap[sid] || '',
    class_id: classId,
    class_name: classNameMap[classId] || '',
    title: String(row?.title || '').trim(),
    task_type: String(row?.task_type || '').trim(),
    source_type: String(row?.source_type || '').trim(),
    source_id: String(row?.source_id || '').trim(),
    status: String(row?.status || '').trim(),
    priority: String(row?.priority || '').trim(),
    due_date: String(row?.due_date || '').trim(),
    assigned_staff_id: String(row?.assigned_staff_id || '').trim(),
    internal_note: String(row?.internal_note || '').trim(),
    parent_note: String(row?.parent_note || '').trim(),
    parent_visible: row?.parent_visible === true,
    created_by: String(row?.created_by || '').trim(),
    created_at: String(row?.created_at || ''),
    updated_by: String(row?.updated_by || '').trim(),
    updated_at: String(row?.updated_at || ''),
    completed_at: String(row?.completed_at || '')
  };
}

function mapWordSessionRow(row) {
  return {
    session_id: String(row?.session_id || '').trim(),
    title: String(row?.title || '').trim(),
    yyyymmdd: String(row?.yyyymmdd || '').trim(),
    class_id: String(row?.class_id || '').trim(),
    scope_text: String(row?.scope_text || '').trim(),
    pass_score: Number(row?.pass_score ?? 90),
    max_score: Number(row?.max_score ?? 100),
    created_by: String(row?.created_by || '').trim(),
    created_at: String(row?.created_at || ''),
    updated_at: String(row?.updated_at || '')
  };
}

function mapWordResultRow(row, sessionMap = {}, studentNameMap = {}) {
  const sid = normalizeStudentId(row?.student_id);
  const sessionId = String(row?.session_id || '').trim();
  const session = sessionMap[sessionId] || {};
  return {
    result_id: String(row?.result_id || '').trim(),
    session_id: sessionId,
    session_title: String(session.title || '').trim(),
    yyyymmdd: String(session.yyyymmdd || '').trim(),
    class_id: String(session.class_id || '').trim(),
    student_id: sid,
    student_name: studentNameMap[sid] || '',
    score: row?.score == null ? null : Number(row.score),
    max_score: Number(row?.max_score ?? session.max_score ?? 100),
    pass_score: Number(row?.pass_score ?? session.pass_score ?? 90),
    result_status: String(row?.result_status || '').trim(),
    clinic_task_id: String(row?.clinic_task_id || '').trim(),
    note: String(row?.note || '').trim(),
    created_at: String(row?.created_at || ''),
    updated_at: String(row?.updated_at || '')
  };
}

async function appendPortalAuditLogDirect(supabase, auth, payload = {}) {
  try {
    const row = {
      audit_id: payload.audit_id || randomUUID(),
      actor_staff_id: String(auth?.me?.staff_id || auth?.staff_id || '').trim(),
      actor_role: normalizeRole(auth?.me?.role || auth?.role || ''),
      actor_name: String(auth?.me?.name || auth?.name || '').trim(),
      op: String(payload.op || '').trim(),
      target_type: String(payload.target_type || '').trim(),
      target_id: String(payload.target_id || '').trim(),
      action: String(payload.action || '').trim(),
      before_json: isPlainObject(payload.before_json) ? payload.before_json : {},
      after_json: isPlainObject(payload.after_json) ? payload.after_json : {},
      meta_json: isPlainObject(payload.meta_json) ? payload.meta_json : {},
      trace_id: String(payload.trace_id || randomUUID()).trim(),
      created_at: nowIso()
    };
    if (!row.op || !row.action) return { ok: false, error: 'audit op/action 누락' };
    const { error } = await supabase.from('portal_audit_logs').insert(row);
    if (error) return { ok: false, error: error.message || 'portal_audit_logs insert 실패' };
    return { ok: true, trace_id: row.trace_id };
  } catch (e) {
    return { ok: false, error: e?.message || 'audit 기록 실패' };
  }
}

async function appendClinicLogDirect(supabase, auth, payload = {}) {
  try {
    const row = {
      clinic_log_id: payload.clinic_log_id || randomUUID(),
      clinic_task_id: String(payload.clinic_task_id || '').trim(),
      event_type: String(payload.event_type || 'NOTE').trim().toUpperCase(),
      before_status: String(payload.before_status || '').trim() || null,
      after_status: String(payload.after_status || '').trim() || null,
      internal_note: String(payload.internal_note || '').trim(),
      parent_note: String(payload.parent_note || '').trim(),
      parent_visible: payload.parent_visible === true,
      actor_staff_id: String(auth?.me?.staff_id || auth?.staff_id || '').trim(),
      created_at: nowIso()
    };
    if (!row.clinic_task_id) return { ok: false, error: 'clinic_task_id 누락' };
    const { error } = await supabase.from('clinic_logs').insert(row);
    if (error) return { ok: false, error: error.message || 'clinic_logs insert 실패' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || 'clinic log 기록 실패' };
  }
}

async function hydrateClinicTasks(supabase, rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const studentNameMap = await readStudentNameMap(supabase, safeRows.map(row => row?.student_id).filter(Boolean));
  const classNameMap = await readClassNameMap(supabase, safeRows.map(row => row?.class_id).filter(Boolean));
  return safeRows.map(row => mapClinicTaskRow(row, studentNameMap, classNameMap));
}

async function clinicListTasksDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const status = String(args.status || '').trim().toUpperCase();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const classId = String(args.class_id || args.classId || '').trim();
  const limit = Math.max(1, Math.min(200, toPositiveInt(args.limit, 80)));

  let q = supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, source_id, status, priority, due_date, assigned_staff_id, internal_note, parent_note, parent_visible, created_by, created_at, updated_by, updated_at, completed_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', normalizeClinicStatus(status));
  if (sid) q = q.eq('student_id', sid);
  if (classId) q = q.eq('class_id', classId);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'clinic_tasks 조회 실패');

  const items = await hydrateClinicTasks(supabase, data || []);
  return success({ count: items.length, items });
}

async function clinicCreateTaskDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const title = normalizeLimitedText(args.title, 160);
  if (!sid || !title) return fail(400, 'INVALID_INPUT', 'student_id와 title이 필요합니다.');

  const supabase = getSupabaseAdmin();
  const row = {
    clinic_task_id: randomUUID(),
    student_id: sid,
    class_id: normalizeLimitedText(args.class_id || args.classId, 80) || null,
    title,
    task_type: normalizeClinicTaskType(args.task_type || args.taskType),
    source_type: normalizeClinicSourceType(args.source_type || args.sourceType),
    source_id: normalizeLimitedText(args.source_id || args.sourceId, 120) || null,
    status: normalizeClinicStatus(args.status, 'CANDIDATE'),
    priority: normalizeClinicPriority(args.priority),
    due_date: normalizeLimitedText(args.due_date || args.dueDate, 10) || null,
    assigned_staff_id: normalizeLimitedText(args.assigned_staff_id || args.assignedStaffId, 80) || null,
    internal_note: normalizeLimitedText(args.internal_note || args.internalNote, 2000),
    parent_note: normalizeLimitedText(args.parent_note || args.parentNote, 1000),
    parent_visible: normalizeBool(args.parent_visible ?? args.parentVisible, false),
    created_by: auth.me.staff_id,
    updated_by: auth.me.staff_id,
    created_at: nowIso(),
    updated_at: nowIso(),
    completed_at: terminalClinicStatus(args.status) ? nowIso() : null
  };

  const { data, error } = await supabase
    .from('clinic_tasks')
    .insert(row)
    .select('*')
    .single();

  if (error) return fail(500, 'DB_INSERT_FAILED', error.message || 'clinic_tasks 생성 실패');

  await appendClinicLogDirect(supabase, auth, {
    clinic_task_id: row.clinic_task_id,
    event_type: row.source_type === 'WORD_FAIL' ? 'AUTO_CREATED' : 'CREATE',
    after_status: row.status,
    internal_note: row.internal_note,
    parent_note: row.parent_note,
    parent_visible: row.parent_visible
  });
  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'clinic.createTask',
    target_type: 'clinic_task',
    target_id: row.clinic_task_id,
    action: 'CREATE',
    after_json: row,
    meta_json: { source_type: row.source_type }
  });

  const items = await hydrateClinicTasks(supabase, [data || row]);
  return success({ item: items[0] || mapClinicTaskRow(data || row), audit_warning: audit.ok ? '' : audit.error || '' });
}

async function clinicUpdateTaskStatusDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const taskId = String(args.clinic_task_id || args.clinicTaskId || '').trim();
  const nextStatus = normalizeClinicStatus(args.status, '');
  if (!taskId || !nextStatus) return fail(400, 'INVALID_INPUT', 'clinic_task_id와 status가 필요합니다.');

  const supabase = getSupabaseAdmin();
  const { data: before, error: beforeErr } = await supabase
    .from('clinic_tasks')
    .select('*')
    .eq('clinic_task_id', taskId)
    .maybeSingle();

  if (beforeErr) return fail(500, 'DB_SELECT_FAILED', beforeErr.message || 'clinic_tasks 조회 실패');
  if (!before) return fail(404, 'NOT_FOUND', '클리닉 task를 찾지 못했습니다.');

  const patch = {
    status: nextStatus,
    updated_by: auth.me.staff_id,
    updated_at: nowIso(),
    completed_at: terminalClinicStatus(nextStatus) ? nowIso() : null
  };

  if ('internal_note' in args || 'internalNote' in args) patch.internal_note = normalizeLimitedText(args.internal_note || args.internalNote, 2000);
  if ('parent_note' in args || 'parentNote' in args) patch.parent_note = normalizeLimitedText(args.parent_note || args.parentNote, 1000);
  if ('parent_visible' in args || 'parentVisible' in args) patch.parent_visible = normalizeBool(args.parent_visible ?? args.parentVisible, false);

  const { data: after, error } = await supabase
    .from('clinic_tasks')
    .update(patch)
    .eq('clinic_task_id', taskId)
    .select('*')
    .single();

  if (error) return fail(500, 'DB_UPDATE_FAILED', error.message || 'clinic_tasks 상태 변경 실패');

  await appendClinicLogDirect(supabase, auth, {
    clinic_task_id: taskId,
    event_type: 'STATUS_CHANGE',
    before_status: before.status,
    after_status: nextStatus,
    internal_note: patch.internal_note ?? before.internal_note ?? '',
    parent_note: patch.parent_note ?? before.parent_note ?? '',
    parent_visible: patch.parent_visible ?? before.parent_visible === true
  });
  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'clinic.updateTaskStatus',
    target_type: 'clinic_task',
    target_id: taskId,
    action: 'STATUS_CHANGE',
    before_json: before,
    after_json: after,
    meta_json: { from: before.status, to: nextStatus }
  });

  const items = await hydrateClinicTasks(supabase, [after]);
  return success({ item: items[0] || mapClinicTaskRow(after), audit_warning: audit.ok ? '' : audit.error || '' });
}

async function wordTestListSessionsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const classId = String(args.class_id || args.classId || '').trim();
  const limit = Math.max(1, Math.min(100, toPositiveInt(args.limit, 40)));

  let q = supabase
    .from('word_test_sessions')
    .select('session_id, title, yyyymmdd, class_id, scope_text, pass_score, max_score, created_by, created_at, updated_at')
    .order('yyyymmdd', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (yyyymmdd) q = q.eq('yyyymmdd', yyyymmdd);
  if (classId) q = q.eq('class_id', classId);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'word_test_sessions 조회 실패');

  const items = (Array.isArray(data) ? data : []).map(mapWordSessionRow);
  return success({ count: items.length, items });
}

async function wordTestCreateSessionDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const title = normalizeLimitedText(args.title, 160);
  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  const passScore = normalizeScore(args.pass_score || args.passScore, 90);
  const maxScore = normalizeScore(args.max_score || args.maxScore, 100);
  if (!title) return fail(400, 'INVALID_INPUT', '시험 제목이 필요합니다.');
  if (!isStrictYmd(yyyymmdd)) return fail(400, 'INVALID_INPUT', 'yyyymmdd는 8자리 숫자여야 합니다.');
  if (!(Number.isFinite(passScore) && Number.isFinite(maxScore) && passScore >= 0 && maxScore > 0 && passScore <= maxScore)) {
    return fail(400, 'INVALID_INPUT', '기준점수와 만점이 올바르지 않습니다.');
  }

  const supabase = getSupabaseAdmin();
  const row = {
    session_id: randomUUID(),
    title,
    yyyymmdd,
    class_id: normalizeLimitedText(args.class_id || args.classId, 80) || null,
    scope_text: normalizeLimitedText(args.scope_text || args.scopeText, 1000),
    pass_score: passScore,
    max_score: maxScore,
    created_by: auth.me.staff_id,
    created_at: nowIso(),
    updated_at: nowIso()
  };

  const { data, error } = await supabase
    .from('word_test_sessions')
    .insert(row)
    .select('*')
    .single();

  if (error) return fail(500, 'DB_INSERT_FAILED', error.message || 'word_test_sessions 생성 실패');

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'wordTest.createSession',
    target_type: 'word_test_session',
    target_id: row.session_id,
    action: 'CREATE',
    after_json: row
  });

  return success({ item: mapWordSessionRow(data || row), audit_warning: audit.ok ? '' : audit.error || '' });
}

async function wordTestEnterResultDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sessionId = String(args.session_id || args.sessionId || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  if (!sessionId || !sid) return fail(400, 'INVALID_INPUT', 'session_id와 student_id가 필요합니다.');

  const supabase = getSupabaseAdmin();
  const { data: session, error: sessionErr } = await supabase
    .from('word_test_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (sessionErr) return fail(500, 'DB_SELECT_FAILED', sessionErr.message || 'word_test_sessions 조회 실패');
  if (!session) return fail(404, 'NOT_FOUND', '단어시험 회차를 찾지 못했습니다.');

  const maxScore = normalizeScore(args.max_score || args.maxScore, Number(session.max_score || 100));
  const passScore = normalizeScore(args.pass_score || args.passScore, Number(session.pass_score || 90));
  const score = normalizeScore(args.score, null);
  const resultStatus = normalizeWordResultStatus(args.result_status || args.resultStatus, score, passScore);
  if ((resultStatus === 'PASS' || resultStatus === 'FAIL') && score === null) {
    return fail(400, 'INVALID_INPUT', '통과/불통과 결과에는 점수가 필요합니다.');
  }

  const { data: existing, error: existingErr } = await supabase
    .from('word_test_results')
    .select('*')
    .eq('session_id', sessionId)
    .eq('student_id', sid)
    .maybeSingle();

  if (existingErr) return fail(500, 'DB_SELECT_FAILED', existingErr.message || 'word_test_results 기존 결과 조회 실패');

  const resultId = existing?.result_id || randomUUID();
  const row = {
    result_id: resultId,
    session_id: sessionId,
    student_id: sid,
    score,
    max_score: maxScore,
    pass_score: passScore,
    result_status: resultStatus,
    clinic_task_id: existing?.clinic_task_id || null,
    note: normalizeLimitedText(args.note, 1000),
    created_by: existing?.created_by || auth.me.staff_id,
    created_at: existing?.created_at || nowIso(),
    updated_by: auth.me.staff_id,
    updated_at: nowIso()
  };

  let clinicTask = null;
  const shouldCreateClinic = resultStatus === 'FAIL' && normalizeBool(args.create_clinic ?? args.createClinic, true) && !row.clinic_task_id;
  if (shouldCreateClinic) {
    const clinicRow = {
      clinic_task_id: randomUUID(),
      student_id: sid,
      class_id: String(session.class_id || '').trim() || null,
      title: `단어시험 불통과: ${session.title}`.slice(0, 160),
      task_type: 'WORD',
      source_type: 'WORD_FAIL',
      source_id: resultId,
      status: 'CANDIDATE',
      priority: Number(score) < passScore - 20 ? 'HIGH' : 'NORMAL',
      due_date: null,
      assigned_staff_id: null,
      internal_note: `점수 ${score}/${maxScore}, 기준 ${passScore}. ${normalizeLimitedText(args.note, 700)}`.trim(),
      parent_note: '',
      parent_visible: false,
      created_by: auth.me.staff_id,
      created_at: nowIso(),
      updated_by: auth.me.staff_id,
      updated_at: nowIso(),
      completed_at: null
    };

    const { data: insertedClinic, error: clinicErr } = await supabase
      .from('clinic_tasks')
      .insert(clinicRow)
      .select('*')
      .single();

    if (clinicErr) return fail(500, 'DB_INSERT_FAILED', clinicErr.message || '불통과 클리닉 후보 생성 실패');

    row.clinic_task_id = clinicRow.clinic_task_id;
    await appendClinicLogDirect(supabase, auth, {
      clinic_task_id: clinicRow.clinic_task_id,
      event_type: 'AUTO_CREATED',
      after_status: 'CANDIDATE',
      internal_note: clinicRow.internal_note
    });
    const hydrated = await hydrateClinicTasks(supabase, [insertedClinic || clinicRow]);
    clinicTask = hydrated[0] || mapClinicTaskRow(insertedClinic || clinicRow);
  }

  const { data: saved, error } = await supabase
    .from('word_test_results')
    .upsert(row, { onConflict: 'session_id,student_id' })
    .select('*')
    .single();

  if (error) return fail(500, 'DB_UPSERT_FAILED', error.message || 'word_test_results 저장 실패');

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'wordTest.enterResult',
    target_type: 'word_test_result',
    target_id: resultId,
    action: existing ? 'UPDATE' : 'CREATE',
    before_json: existing || {},
    after_json: saved || row,
    meta_json: { clinic_task_id: row.clinic_task_id || '', result_status: resultStatus }
  });

  const item = mapWordResultRow(saved || row, { [sessionId]: session }, {});
  return success({ item, clinic_task: clinicTask, created_clinic: !!clinicTask, audit_warning: audit.ok ? '' : audit.error || '' });
}

async function auditSearchLogsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const opFilter = normalizeLimitedText(args.op, 120);
  const targetType = normalizeLimitedText(args.target_type || args.targetType, 120);
  const targetId = normalizeLimitedText(args.target_id || args.targetId, 160);
  const limit = Math.max(1, Math.min(200, toPositiveInt(args.limit, 80)));

  let q = supabase
    .from('portal_audit_logs')
    .select('audit_id, actor_staff_id, actor_role, actor_name, op, target_type, target_id, action, before_json, after_json, meta_json, trace_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (opFilter) q = q.eq('op', opFilter);
  if (targetType) q = q.eq('target_type', targetType);
  if (targetId) q = q.eq('target_id', targetId);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'portal_audit_logs 조회 실패');

  return success({ count: Array.isArray(data) ? data.length : 0, items: Array.isArray(data) ? data : [] });
}


function parseProfileMetaJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function mapProfileLogRow(row) {
  const meta = parseProfileMetaJson(row?.meta_json);
  return {
    ts: String(row?.ts || ''),
    yyyymmdd: String(row?.yyyymmdd || ''),
    student_id: normalizeStudentId(row?.student_id),
    action_type: String(row?.action_type || ''),
    kiosk_floor: String(row?.kiosk_floor || ''),
    result: String(row?.result || ''),
    input_mode: String(meta.input_mode || ''),
    exception: String(meta.exception || ''),
    deny_reason: String(row?.deny_reason || ''),
    trace_id: String(row?.trace_id || '')
  };
}

async function assistantGetStudentProfileDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  const logLimit = Math.max(1, Math.min(40, toPositiveInt(args.log_limit || args.logLimit, 10)));

  if (!sid) {
    return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');
  }
  if (!isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd는 8자리 숫자여야 합니다.');
  }

  const supabase = getSupabaseAdmin();
  const warnings = [];

  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('*')
    .eq('student_id', sid)
    .maybeSingle();

  if (studentErr) {
    return fail(500, 'DB_SELECT_FAILED', studentErr.message || 'students 조회 실패');
  }
  if (!student) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
  }

  const todayOut = await loadManualTodayState(supabase, sid, yyyymmdd);
  if (!todayOut.ok) {
    warnings.push({ area: 'today_state', message: todayOut.error || 'today_student_state 조회 실패' });
  }

  let recentLogs = [];
  const { data: logs, error: logErr } = await supabase
    .from('attendance_logs')
    .select('ts, yyyymmdd, student_id, action_type, kiosk_floor, meta_json, result, deny_reason, trace_id')
    .eq('student_id', sid)
    .order('ts', { ascending: false })
    .limit(logLimit);

  if (logErr) {
    warnings.push({ area: 'attendance_logs', message: logErr.message || 'recent attendance_logs 조회 실패' });
  } else {
    recentLogs = (Array.isArray(logs) ? logs : []).map(mapProfileLogRow);
  }

  let classes = [];
  const { data: relRows, error: relErr } = await supabase
    .from('class_students')
    .select('class_id')
    .eq('student_id', sid)
    .limit(200);

  if (relErr) {
    warnings.push({ area: 'class_students', message: relErr.message || 'class_students 조회 실패' });
  } else {
    const classIds = Array.from(new Set(
      (Array.isArray(relRows) ? relRows : [])
        .map(row => String(row?.class_id || '').trim())
        .filter(Boolean)
    ));

    if (classIds.length) {
      const { data: classRows, error: classErr } = await supabase
        .from('classes')
        .select('class_id, name, teacher, start, end, room, alert_delay, alert_to, status')
        .in('class_id', classIds)
        .limit(200);

      if (classErr) {
        warnings.push({ area: 'classes', message: classErr.message || 'classes 조회 실패' });
        classes = classIds.map(classId => ({ class_id: classId, name: '', teacher: '', start: '', end: '', room: '', status: '' }));
      } else {
        const classMap = new Map();
        for (const row of Array.isArray(classRows) ? classRows : []) {
          const classId = String(row?.class_id || '').trim();
          if (classId) classMap.set(classId, row);
        }
        const staffNameMap = await readStaffNameMap(
          supabase,
          (Array.isArray(classRows) ? classRows : []).map(row => row?.teacher).filter(Boolean)
        );
        classes = classIds.map(classId => {
          const row = classMap.get(classId) || {};
          const teacher = String(row?.teacher || '').trim();
          return {
            class_id: classId,
            name: String(row?.name || '').trim(),
            teacher,
            teacher_name: staffNameMap[String(teacher).toLowerCase()] || teacher,
            start: String(row?.start || '').trim(),
            end: String(row?.end || '').trim(),
            room: String(row?.room || '').trim(),
            alert_delay: String(row?.alert_delay || '').trim(),
            alert_to: String(row?.alert_to || '').trim(),
            status: String(row?.status || '').trim()
          };
        });
      }
    }
  }

  let absenceExcuses = [];
  const { data: excuseRows, error: excuseErr } = await supabase
    .from('absence_excuses')
    .select('excuse_id, yyyymmdd, class_id, student_id, reason, until_ts, created_at, updated_at')
    .eq('student_id', sid)
    .order('yyyymmdd', { ascending: false })
    .limit(20);

  if (excuseErr) {
    warnings.push({ area: 'absence_excuses', message: excuseErr.message || 'absence_excuses 조회 실패' });
  } else {
    const classNameMap = await readClassNameMap(
      supabase,
      (Array.isArray(excuseRows) ? excuseRows : []).map(row => row?.class_id).filter(Boolean)
    );
    absenceExcuses = (Array.isArray(excuseRows) ? excuseRows : []).map(row => {
      const classId = String(row?.class_id || '').trim();
      return {
        excuse_id: String(row?.excuse_id || '').trim(),
        yyyymmdd: String(row?.yyyymmdd || '').trim(),
        class_id: classId,
        class_name: classNameMap[classId] || '',
        reason: String(row?.reason || '').trim(),
        until_ts: String(row?.until_ts || ''),
        created_at: String(row?.created_at || ''),
        updated_at: String(row?.updated_at || '')
      };
    });
  }

  const studentOut = {
    student_id: sid,
    student_name: String(student?.student_name || '').trim(),
    school: String(student?.school || '').trim(),
    grade: String(student?.grade || '').trim(),
    status: String(student?.status || '').trim(),
    is_exception: String(student?.is_exception || '').trim(),
    exception_note: String(student?.exception_note || '').trim(),
    teacher: String(student?.teacher || student?.teacher_id || student?.teacher_name || '').trim()
  };

  let clinicTasks = [];
  const { data: clinicRows, error: clinicErr } = await supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, source_id, status, priority, due_date, assigned_staff_id, internal_note, parent_note, parent_visible, created_by, created_at, updated_by, updated_at, completed_at')
    .eq('student_id', sid)
    .order('updated_at', { ascending: false })
    .limit(10);

  if (clinicErr) {
    warnings.push({ area: 'clinic_tasks', message: clinicErr.message || 'clinic_tasks 조회 실패' });
  } else {
    clinicTasks = await hydrateClinicTasks(supabase, clinicRows || []);
  }

  let wordResults = [];
  const { data: wordRows, error: wordErr } = await supabase
    .from('word_test_results')
    .select('result_id, session_id, student_id, score, max_score, pass_score, result_status, clinic_task_id, note, created_at, updated_at')
    .eq('student_id', sid)
    .order('updated_at', { ascending: false })
    .limit(10);

  if (wordErr) {
    warnings.push({ area: 'word_test_results', message: wordErr.message || 'word_test_results 조회 실패' });
  } else {
    const sessionIds = Array.from(new Set((Array.isArray(wordRows) ? wordRows : []).map(row => String(row?.session_id || '').trim()).filter(Boolean)));
    let sessionMap = {};
    if (sessionIds.length) {
      const { data: sessions, error: sessionErr } = await supabase
        .from('word_test_sessions')
        .select('session_id, title, yyyymmdd, class_id, scope_text, pass_score, max_score')
        .in('session_id', sessionIds)
        .limit(100);
      if (sessionErr) {
        warnings.push({ area: 'word_test_sessions', message: sessionErr.message || 'word_test_sessions 조회 실패' });
      } else {
        sessionMap = (Array.isArray(sessions) ? sessions : []).reduce((acc, row) => {
          const sessionId = String(row?.session_id || '').trim();
          if (sessionId) acc[sessionId] = row;
          return acc;
        }, {});
      }
    }
    wordResults = (Array.isArray(wordRows) ? wordRows : []).map(row => mapWordResultRow(row, sessionMap, {}));
  }

  return success({
    yyyymmdd,
    student: studentOut,
    today_state: todayOut.ok ? todayOut.state : null,
    today_state_source: todayOut.source || '',
    classes,
    recent_logs: recentLogs,
    absence_excuses: absenceExcuses,
    clinic_tasks: clinicTasks,
    word_test_results: wordResults,
    warnings
  });
}

function bulkEndOfKstDayIso(yyyymmdd) {
  const y = Number(String(yyyymmdd || '').slice(0, 4));
  const m = Number(String(yyyymmdd || '').slice(4, 6));
  const d = Number(String(yyyymmdd || '').slice(6, 8));

  return new Date(Date.UTC(y, m - 1, d, 14, 59, 59, 999)).toISOString();
}

function bulkNormalizeUntilIso(raw, yyyymmdd) {
  const s = String(raw || '').trim();

  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  return bulkEndOfKstDayIso(yyyymmdd);
}

async function assistantBulkUpsertAbsenceExcusesDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const classId = String(args.class_id || args.classId || '').trim();
  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const reason = String(args.reason || '').trim().slice(0, 300);
  const untilMinRaw = Number(args.until_min || args.untilMin || 0);
  const untilMin = Number.isFinite(untilMinRaw)
    ? Math.max(0, Math.min(1440, Math.floor(untilMinRaw)))
    : 0;

  const rawIds = Array.isArray(args.student_ids)
    ? args.student_ids
    : Array.isArray(args.studentIds)
      ? args.studentIds
      : [];

  const studentIds = Array.from(new Set(
    rawIds
      .map(normalizeStudentId)
      .filter(Boolean)
  )).slice(0, 80);

  if (!classId || classId === '*') {
    return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  }

  if (!isStrictYmd(yyyymmdd)) {
    return fail(400, 'INVALID_INPUT', 'yyyymmdd 8자리가 필요합니다.');
  }

  if (!studentIds.length) {
    return fail(400, 'INVALID_INPUT', '일괄 등록할 학생을 1명 이상 선택하세요.');
  }

  const gasResult = await proxyRpcToGas(
    'bridge.absence_excuse.bulk_upsert',
    {
      class_id: classId,
      yyyymmdd,
      student_ids: studentIds,
      reason,
      until_min: untilMin,
      actor_staff_id: auth.me.staff_id,
      actor_role: normalizeRole(auth.me.role),
      actor_name: String(auth.me.name || '')
    },
    ''
  );

  if (!gasResult.body || gasResult.body.ok !== true) {
    return gasResult;
  }

  const gasData = gasResult.body?.data || {};
  const bridgeItems = Array.isArray(gasData.items) ? gasData.items : [];
  const successfulBridgeItems = bridgeItems.filter(item =>
    item && item.ok === true && item.item && item.item.student_id
  );

  let replicaPatched = false;
  let replicaPatchError = '';

  if (successfulBridgeItems.length) {
    try {
      const supabase = getSupabaseAdmin();
      const now = new Date().toISOString();

      const rows = successfulBridgeItems.map(item => {
        const saved = item.item || {};
        const sid = normalizeStudentId(saved.student_id || item.student_id || '');

        return {
          excuse_id: String(saved.excuse_id || '').trim(),
          class_id: classId,
          yyyymmdd,
          student_id: sid,
          reason: String(saved.reason || reason).trim(),
          until_ts: bulkNormalizeUntilIso(saved.until_ts, yyyymmdd),
          created_at: String(saved.created_at || now),
          created_by: String(saved.created_by || auth.me.staff_id),
          updated_at: String(saved.updated_at || now),
          updated_by: String(saved.updated_by || auth.me.staff_id),
          synced_at: now
        };
      }).filter(row =>
        row.excuse_id &&
        row.class_id &&
        row.yyyymmdd &&
        row.student_id
      );

      if (!rows.length) {
        replicaPatchError = 'bulk bridge 응답에 replica upsert 가능한 item이 없습니다.';
      } else {
        const { error } = await supabase
          .from('absence_excuses')
          .upsert(rows, {
            onConflict: 'class_id,yyyymmdd,student_id'
          });

        if (error) {
          replicaPatchError = error.message || 'absence_excuses bulk upsert 실패';
        } else {
          replicaPatched = true;
        }
      }
    } catch (e) {
      replicaPatchError = e?.message || 'absence_excuses bulk replica upsert 실패';
    }
  }

  const items = bridgeItems.map(item => {
    const saved = item && item.item ? item.item : {};
    const studentId = normalizeStudentId(
      item?.student_id ||
      saved.student_id ||
      ''
    );
    const ok = item && item.ok === true;

    return {
      student_id: studentId,
      ok,
      replicaPatched: ok ? replicaPatched : false,
      replicaPatchError: ok && !replicaPatched
        ? replicaPatchError
        : '',
      data: ok ? { item: saved } : {},
      error: ok
        ? null
        : (item?.error || {
            code: 'UNKNOWN',
            message: '일괄 결석예외 저장 실패'
          })
    };
  });

  const succeeded = items.filter(item => item.ok).length;
  const failed = items.length - succeeded;
  const replicaWarn = succeeded > 0 && !replicaPatched
    ? succeeded
    : 0;

  return success({
    requested: Number(gasData.requested || studentIds.length) || studentIds.length,
    succeeded,
    failed,
    replica_warn: replicaWarn,
    source: 'central_db_bulk_bridge',
    items
  });
}

async function countNotifyQueueRows(supabase, status = '', actionPrefix = '') {
  let query = supabase
    .from('attendance_notify_queue')
    .select('queue_id', { count: 'exact', head: true });

  const normStatus = String(status || '').trim().toUpperCase();
  if (normStatus) query = query.eq('status', normStatus);

  const prefix = String(actionPrefix || '').trim().toUpperCase();
  if (prefix === 'ABSENT') query = query.ilike('action_type', 'ABSENT_%');
  if (prefix === 'ATTENDANCE') query = query.ilike('action_type', 'CHECK_%');

  const { count, error } = await query;
  if (error) return { ok: false, count: 0, error: error.message || 'queue count 실패' };
  return { ok: true, count: Number(count || 0) || 0, error: '' };
}

async function adminGetOpsOverviewDirect(sessionToken = '') {
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

  const supabase = getSupabaseAdmin();
  const centralReplica = await readCentralReplicaDiag();

  const [
    failedAbsent,
    failedAttendance,
    pendingAll,
    latestAbsenceOut,
    latestWorkerOut,
    latestAbsenceCronOut,
    latestWorkerCronOut
  ] = await Promise.all([
    countNotifyQueueRows(supabase, 'FAILED', 'ABSENT'),
    countNotifyQueueRows(supabase, 'FAILED', 'ATTENDANCE'),
    countNotifyQueueRows(supabase, 'PENDING', ''),
    supabase
      .from('absence_detection_runs')
      .select('run_id, created_at, source, status, yyyymmdd, queued_count, failed_count, sent_count, error')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('notify_worker_runs')
      .select('run_id, created_at, source, status, done, failed, requeued, error')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('absence_detection_runs')
      .select('run_id, created_at, source, status, yyyymmdd, queued_count, failed_count, sent_count, error')
      .eq('source', 'CRON')
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('notify_worker_runs')
      .select('run_id, created_at, source, status, done, failed, requeued, error')
      .eq('source', 'CRON')
      .order('created_at', { ascending: false })
      .limit(1)
  ]);

  const errors = {};

  if (latestAbsenceOut?.error) {
    errors.latest_absence_run =
      latestAbsenceOut.error.message || 'absence_detection_runs 조회 실패';
  }

  if (latestWorkerOut?.error) {
    errors.latest_notify_worker_run =
      latestWorkerOut.error.message || 'notify_worker_runs 조회 실패';
  }

  if (latestAbsenceCronOut?.error) {
    errors.latest_absence_cron_run =
      latestAbsenceCronOut.error.message || 'CRON absence_detection_runs 조회 실패';
  }

  if (latestWorkerCronOut?.error) {
    errors.latest_notify_worker_cron_run =
      latestWorkerCronOut.error.message || 'CRON notify_worker_runs 조회 실패';
  }

  const latestAbsenceRun = latestAbsenceOut?.error
    ? null
    : Array.isArray(latestAbsenceOut?.data)
      ? latestAbsenceOut.data[0] || null
      : null;

  const latestNotifyWorkerRun = latestWorkerOut?.error
    ? null
    : Array.isArray(latestWorkerOut?.data)
      ? latestWorkerOut.data[0] || null
      : null;

  const latestAbsenceCronRun = latestAbsenceCronOut?.error
    ? null
    : Array.isArray(latestAbsenceCronOut?.data)
      ? latestAbsenceCronOut.data[0] || null
      : null;

  const latestNotifyWorkerCronRun = latestWorkerCronOut?.error
    ? null
    : Array.isArray(latestWorkerCronOut?.data)
      ? latestWorkerCronOut.data[0] || null
      : null;

  const absenceCronMaxStaleMin = toPositiveIntBounded(
    process.env.ABSENT_CRON_STALE_MIN,
    3,
    1,
    60
  );

  const notifyWorkerCronMaxStaleMin = toPositiveIntBounded(
    process.env.NOTIFY_WORKER_CRON_STALE_MIN,
    3,
    1,
    60
  );

  const absenceCronAgeMin = latestAbsenceCronRun?.created_at
    ? minutesSinceIso(latestAbsenceCronRun.created_at)
    : null;

  const notifyWorkerCronAgeMin = latestNotifyWorkerCronRun?.created_at
    ? minutesSinceIso(latestNotifyWorkerCronRun.created_at)
    : null;

  return success({
    safe: meta.data?.safe || {},
    kiosk_floor: meta.data?.kiosk_floor || '',
    central_replica: centralReplica,
    queue: {
      failed_absent: failedAbsent,
      failed_attendance: failedAttendance,
      pending_all: pendingAll
    },
    latest_absence_run: latestAbsenceRun,
    latest_notify_worker_run: latestNotifyWorkerRun,
    latest_absence_cron_run: latestAbsenceCronRun,
    latest_notify_worker_cron_run: latestNotifyWorkerCronRun,
    cron_health: {
      absence_age_min: absenceCronAgeMin,
      absence_max_stale_min: absenceCronMaxStaleMin,
      absence_stale: absenceCronAgeMin == null || absenceCronAgeMin > absenceCronMaxStaleMin,
      notify_worker_age_min: notifyWorkerCronAgeMin,
      notify_worker_max_stale_min: notifyWorkerCronMaxStaleMin,
      notify_worker_stale: notifyWorkerCronAgeMin == null || notifyWorkerCronAgeMin > notifyWorkerCronMaxStaleMin
    },
    errors,
    checked_at: nowIso()
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

  const rows = Array.isArray(data) ? data : [];
  const studentNameMap = await readStudentNameMap(
    supabase,
    rows.map(row => row?.student_id)
  );
  const classNameMap = await readClassNameMap(
    supabase,
    rows.map(row => row?.class_id)
  );

  const items = rows.map(row => {
    const studentId = normalizeStudentId(row?.student_id);
    const mappedClassId = String(row?.class_id || '').trim();

    return {
      ...row,
      student_id: studentId,
      student_name: studentNameMap[studentId] || '',
      class_id: mappedClassId,
      class_name: classNameMap[mappedClassId] || ''
    };
  });

  return success({
    count: items.length,
    items
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

  const stateOut = await loadManualTodayState(supabase, sid, record.yyyymmdd);
  let stateWrite = {
    ok: false,
    source: stateOut.source || '',
    error: ''
  };

  if (stateOut.ok) {
    const updatedState = await upsertManualTodayState({
      supabase,
      yyyymmdd: record.yyyymmdd,
      sid,
      currentState: stateOut.state,
      actionType: action,
      kioskFloor,
      now,
      actor: auth.me.staff_id,
      reason,
      sourceTraceId,
      stateSource: stateOut.source || ''
    });

    stateWrite = {
      ok: !!updatedState.ok,
      source: stateOut.source || '',
      error: updatedState.ok ? '' : String(updatedState.error || '')
    };
  } else {
    stateWrite = {
      ok: false,
      source: stateOut.source || '',
      error: String(stateOut.error || 'today_student_state 보정 실패')
    };
  }

  return success({
    record: data,
    student,
    trace_id: traceId,
    state: {
      write_ok: !!stateWrite.ok,
      source: stateWrite.source || '',
      error: stateWrite.error || ''
    }
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

  if (op === 'assistant.searchStudents') {
    const result = await assistantSearchStudentsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.getStudentProfile') {
    const result = await assistantGetStudentProfileDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.listTasks') {
    const result = await clinicListTasksDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.createTask') {
    const result = await clinicCreateTaskDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.updateTaskStatus') {
    const result = await clinicUpdateTaskStatusDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordTest.listSessions') {
    const result = await wordTestListSessionsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordTest.createSession') {
    const result = await wordTestCreateSessionDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordTest.enterResult') {
    const result = await wordTestEnterResultDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'audit.searchLogs') {
    const result = await auditSearchLogsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.listClassOptions') {
    const result = await assistantListClassOptionsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.listClassRoster') {
    const result = await assistantListClassRosterDirect(payload.args || {}, sessionToken);
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

  if (op === 'admin.listAbsenceRuns') {
    const result = await adminListAbsenceRunsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.listNotifyWorkerRuns') {
    const result = await adminListNotifyWorkerRunsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }
  
  if (op === 'admin.listNotifyQueue') {
    const result = await adminListNotifyQueueDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.scanTodayStateMismatch') {
    const result = await adminScanTodayStateMismatchDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.rebuildTodayState') {
    const result = await adminRebuildTodayStateDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.retryNotifyQueue') {
    const result = await adminRetryNotifyQueueDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.previewNotifyPayload') {
    const result = await adminPreviewNotifyPayloadDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }


  if (op === 'admin.cleanupQrExpired') {
    const result = await adminCleanupQrExpiredDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.flushCache') {
    const result = await adminFlushCacheDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.runCentralReplicaSync') {
    const result = await adminRunCentralReplicaSyncDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getOpsOverview') {
    const result = await adminGetOpsOverviewDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.listAbsenceExcuses') {
    const result = await assistantListAbsenceExcusesDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.addAbsenceExcuse') {
    const result = await assistantUpsertAbsenceExcuseHybrid(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.bulkAddAbsenceExcuses') {
    const result = await assistantBulkUpsertAbsenceExcusesDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.removeAbsenceExcuse') {
    const result = await assistantRemoveAbsenceExcuseHybrid(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.manualAttendance') {
    const result = await assistantManualAttendanceDirect(payload.args || {}, sessionToken);
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

  if (op === 'admin.setStudentException' || op === 'teacher.setException') {
    const result = await adminSetStudentExceptionHybrid(payload.args || {}, sessionToken);
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