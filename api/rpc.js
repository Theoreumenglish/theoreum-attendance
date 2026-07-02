import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { listSeedWordCatalog } from '../lib/word-catalog-seed.js';
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
import {
  adminListStaffClockLogsDirect,
  adminSaveStaffClockManualDirect
} from '../lib/staff-clock-admin.js';

const MAX_BODY_BYTES = 64 * 1024;

const RPC_FAST_CACHE = new Map();

const QA_FEATURE_MATRIX = Object.freeze({
  release_tag: 'production-qa-parity-megapatch-v1',
  generated_at: '2026-06-27',
  static_pages: ['/', '/student-qr.html', '/student-today.html'],
  required_ops: [
    'meta.ping',
    'meta.supportedOps',
    'auth.login',
    'auth.me',
    'auth.logout',
    'admin.finalReadiness',
    'admin.phoneIdentity.audit',
    'admin.central.staff.list',
    'admin.central.staff.phoneOnly',
    'assistant.listClassOptions',
    'admin.master.searchStudents',
    'admin.studentTodayLink.create',
    'studentToday.publicGet',
    'admin.lectureAssignment.list',
    'admin.lectureAssignment.save',
    'wordCatalog.list',
    'wordRecord.list',
    'clinic.todayBoard'
  ],
  features: {
    phone_identity_quality: true,
    student_today_public_page: true,
    online_lecture_assignment: true,
    staff_phone_management: true,
    student_parent_phone_fallback: true,
    staff_phone_only_assignment: true,
    production_qa_runner: true,
    deployment_parity_check: true
  }
});

function buildSupportedOpsMeta() {
  return {
    ...QA_FEATURE_MATRIX,
    runtime: {
      node: process.version,
      vercel: Boolean(process.env.VERCEL),
      vercel_env: process.env.VERCEL_ENV || '',
      vercel_url: process.env.VERCEL_URL || '',
      public_base_url: process.env.PUBLIC_BASE_URL || ''
    }
  };
}



function fastCacheSec(name, fallback = 20, max = 300) {
  const envName = 'RPC_CACHE_' + String(name || '').toUpperCase() + '_SEC';
  const n = Number(process.env[envName] || fallback);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : fallback;
}

function fastCacheStaleSec(name, fallback = 600, max = 3600) {
  const envName = 'RPC_CACHE_' + String(name || '').toUpperCase() + '_STALE_SEC';
  const n = Number(process.env[envName] || fallback);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : fallback;
}

function fastCacheEntry(key, allowStale = false) {
  const hit = RPC_FAST_CACHE.get(key);
  if (!hit) return null;
  const now = Date.now();
  const staleExpire = Number(hit.stale_expire_ms || hit.expire_ms || 0);
  if (now > staleExpire) {
    RPC_FAST_CACHE.delete(key);
    return null;
  }
  if (now > Number(hit.expire_ms || 0)) {
    if (!allowStale) return null;
    return { value: hit.value, fresh: false, stale: true };
  }
  return { value: hit.value, fresh: true, stale: false };
}

function fastCacheGet(key) {
  const hit = fastCacheEntry(key, false);
  return hit ? hit.value : null;
}

function fastCacheGetStale(key) {
  const hit = fastCacheEntry(key, true);
  return hit ? hit.value : null;
}

function fastCacheSet(key, value, ttlSec, staleSec = 0) {
  if (!ttlSec || ttlSec <= 0) return value;
  const now = Date.now();
  const staleMs = Math.max(Number(ttlSec || 0), Number(ttlSec || 0) + Math.max(0, Number(staleSec || 0))) * 1000;
  RPC_FAST_CACHE.set(key, {
    value,
    expire_ms: now + ttlSec * 1000,
    stale_expire_ms: now + staleMs
  });
  if (RPC_FAST_CACHE.size > 500) {
    const now2 = Date.now();
    for (const [k, v] of RPC_FAST_CACHE.entries()) {
      if (now2 > Number(v.stale_expire_ms || v.expire_ms || 0)) RPC_FAST_CACHE.delete(k);
    }
  }
  return value;
}

function fastCacheDelPrefix(prefix) {
  for (const key of RPC_FAST_CACHE.keys()) {
    if (String(key).startsWith(prefix)) RPC_FAST_CACHE.delete(key);
  }
}

function normalizeYmdInput(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  return digits.length === 8 ? digits : '';
}

function isActiveLikeClassStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return true;
  return !['deleted', 'delete', 'inactive', 'disabled', 'cancelled', 'canceled', '휴강', '삭제', '비활성'].includes(v);
}

function isActiveLikeScheduleStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return true;
  return !['deleted', 'delete', 'inactive', 'disabled', 'cancelled', 'canceled', '휴강', '삭제', '비활성'].includes(v);
}

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

function publicTokenHash(raw) {
  return createHash('sha256').update(String(raw || '').trim()).digest('hex');
}

function makePublicToken() {
  return randomBytes(32).toString('base64url');
}

function normalizePublicBaseUrl(raw) {
  const fallback = process.env.PUBLIC_BASE_URL || 'https://theoreum-attendance.vercel.app';
  const v = String(raw || fallback).trim() || fallback;
  return v.replace(/\/+$/, '');
}

function publicTodayStateLabel(state) {
  if (!state) return '기록 없음';
  if (state.outingActive) return '외출중';
  if (state.checkedOut) return '하원';
  if (state.checkedIn) return '등원중';
  return '미등원';
}

function publicActionLabel(raw) {
  const v = String(raw || '').trim().toUpperCase();
  const map = {
    CHECK_IN: '등원',
    CHECK_OUT: '하원',
    MOVE: '이동',
    OUTING_OUT: '외출',
    OUTING_BACK: '복귀',
    MANUAL_CHECK_IN: '등원 정정',
    MANUAL_CHECK_OUT: '하원 정정'
  };
  return map[v] || v || '-';
}

async function requireRole(sessionToken, needRole) {
  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: false });

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


function mapClassOptionRow(row = {}, staffNameMap = {}, extra = {}) {
  const classId = String(row?.class_id || '').trim();
  const teacher = String(row?.teacher || '').trim();
  const name = String(row?.class_name || row?.name || '').trim();
  return {
    ...extra,
    class_id: classId,
    name,
    class_name: name,
    teacher,
    teacher_name: staffNameMap[String(teacher).toLowerCase()] || teacher,
    start: String(row?.start || '').trim(),
    end: String(row?.end || row?.['end'] || '').trim(),
    room: String(row?.room || '').trim(),
    alert_delay: String(row?.alert_delay || '').trim(),
    alert_to: String(row?.alert_to || '').trim(),
    status: String(row?.status || '').trim()
  };
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
    .select('student_id, student_name, school, grade, student_phone, parent_phone')
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
  fastCacheDelPrefix('adminOpsOverview');
  fastCacheDelPrefix('classOptions');

  return success({
    ok: true,
    flushed: ['runtime_meta', 'rpc_fast_cache'],
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

  fastCacheDelPrefix('classOptions');
  fastCacheDelPrefix('adminOpsOverview');
  return result;
}


function normalizePhoneDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '').trim();
}

function normalizeClassDays(raw) {
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\s,]+/);
  const allowed = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
  return Array.from(new Set(
    values
      .map(x => String(x || '').trim().toUpperCase())
      .filter(x => allowed.has(x))
  ));
}

async function proxyCentralMasterBridge(op, args = {}, auth, options = {}) {
  const result = await proxyRpcToGas(
    op,
    {
      ...(args || {}),
      actor_staff_id: auth.me.staff_id,
      actor_role: normalizeRole(auth.me.role),
      actor_name: String(auth.me.name || '')
    },
    '',
    { timeoutMs: options.timeoutMs || 55000 }
  );

  if (result.body && result.body.ok === true) {
    fastCacheDelPrefix('classOptions');
    fastCacheDelPrefix('adminOpsOverview');
    fastCacheDelPrefix('masterStudentSearch');
  }

  return result;
}

async function adminMasterGetClassDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;
  const classId = String(args.class_id || args.classId || '').trim();
  if (!classId) return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  return proxyCentralMasterBridge('bridge.class.get', { class_id: classId }, auth, { timeoutMs: 30000 });
}

async function adminMasterUpsertClassDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;
  const input = args.class || args || {};
  const data = {
    class_id: String(input.class_id || input.classId || '').trim(),
    name: String(input.name || input.class_name || '').trim().slice(0, 100),
    teacher: String(input.teacher || input.teacher_id || '').trim().toLowerCase().slice(0, 80),
    start: String(input.start || '').trim().slice(0, 5),
    end: String(input.end || '').trim().slice(0, 5),
    room: String(input.room || '').trim().slice(0, 80),
    days: normalizeClassDays(input.days || input.days_json || input.daysJson),
    alert_delay: String(input.alert_delay || '5,20').trim().slice(0, 40),
    alert_to: String(input.alert_to || 'parent').trim().toLowerCase().slice(0, 20)
  };
  return proxyCentralMasterBridge('bridge.class.upsert', { class: data }, auth, { timeoutMs: 65000 });
}

async function adminMasterDeleteClassDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;
  const classId = String(args.class_id || args.classId || '').trim();
  if (!classId) return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  return proxyCentralMasterBridge('bridge.class.delete', { class_id: classId }, auth, { timeoutMs: 65000 });
}

async function adminMasterAddClassStudentsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;
  const classId = String(args.class_id || args.classId || '').trim();
  const raw = Array.isArray(args.student_ids)
    ? args.student_ids
    : Array.isArray(args.studentIds)
      ? args.studentIds
      : String(args.student_ids_text || args.studentIdsText || '').split(/[\s,]+/);
  const studentIds = Array.from(new Set(raw.map(normalizeStudentId).filter(Boolean))).slice(0, 100);
  if (!classId || !studentIds.length) return fail(400, 'INVALID_INPUT', 'class_id와 student_ids가 필요합니다.');
  return proxyCentralMasterBridge('bridge.class.students.add', { class_id: classId, student_ids: studentIds }, auth, { timeoutMs: 65000 });
}

async function adminMasterRemoveClassStudentDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;
  const classId = String(args.class_id || args.classId || '').trim();
  const studentId = normalizeStudentId(args.student_id || args.studentId || args.sid || '');
  if (!classId || !studentId) return fail(400, 'INVALID_INPUT', 'class_id와 student_id가 필요합니다.');
  return proxyCentralMasterBridge('bridge.class.students.remove', { class_id: classId, student_id: studentId }, auth, { timeoutMs: 65000 });
}

async function adminMasterSearchStudentsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;
  const q = String(args.q || args.query || '').trim();
  if (!q) return success({ count: 0, items: [] });
  const limit = Math.max(1, Math.min(80, toPositiveInt(args.limit, 30)));
  const cacheKey = ['masterStudentSearch', q.toLowerCase(), limit].join('|');
  const cached = fastCacheGet(cacheKey);
  if (cached) return success({ ...cached, cache: { hit: true, ttl_sec: fastCacheSec('master_student_search', 20, 120) } });

  const supabase = getSupabaseAdmin();
  const digits = q.replace(/[^0-9]/g, '');
  let query = supabase
    .from('students')
    .select('student_id, student_name, school, grade, student_phone, parent_phone, teacher, status, qr_id, is_exception, exception_note')
    .limit(limit);

  if (digits) {
    const sid = normalizeStudentId(digits);
    query = query.or(`student_id.ilike.%${digits}%,student_id.eq.${sid},student_phone.ilike.%${digits}%,parent_phone.ilike.%${digits}%`);
  } else {
    const safe = q.replace(/[%_,]/g, '');
    query = query.or(`student_name.ilike.%${safe}%,school.ilike.%${safe}%,grade.ilike.%${safe}%`);
  }

  const { data, error } = await query;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || '학생DB 검색 실패');
  const items = (Array.isArray(data) ? data : [])
    .map(row => ({
      student_id: normalizeStudentId(row?.student_id),
      student_name: String(row?.student_name || '').trim(),
      school: String(row?.school || '').trim(),
      grade: String(row?.grade || '').trim(),
      student_phone: String(row?.student_phone || '').trim(),
      parent_phone: String(row?.parent_phone || '').trim(),
      teacher: String(row?.teacher || '').trim(),
      status: String(row?.status || '').trim(),
      qr_id: String(row?.qr_id || '').trim(),
      is_exception: String(row?.is_exception || '').trim(),
      exception_note: String(row?.exception_note || '').trim()
    }))
    .filter(item => item.student_id);
  const out = { count: items.length, items };
  fastCacheSet(cacheKey, out, fastCacheSec('master_student_search', 20, 120));
  return success(out);
}

async function adminMasterUpsertStudentDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;
  const input = args.student || args || {};
  const student = {
    student_id: normalizeStudentId(input.student_id || input.studentId || input.sid || ''),
    student_name: String(input.student_name || input.name || '').trim().slice(0, 80),
    school: String(input.school || '').trim().slice(0, 80),
    grade: String(input.grade || '').trim().slice(0, 40),
    student_phone: normalizePhoneDigits(input.student_phone || input.studentPhone || ''),
    parent_phone: normalizePhoneDigits(input.parent_phone || input.parentPhone || ''),
    teacher: String(input.teacher || '').trim().toLowerCase().slice(0, 80),
    status: String(input.status || 'ACTIVE').trim().slice(0, 40),
    qr_id: String(input.qr_id || input.qrId || '').trim().slice(0, 100),
    is_exception: String(input.is_exception || input.isException || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
    exception_note: String(input.exception_note || input.exceptionNote || '').trim().slice(0, 300)
  };
  if (!student.student_name) return fail(400, 'INVALID_INPUT', '학생 이름은 필수입니다.');
  return proxyCentralMasterBridge('bridge.student.upsert', { student }, auth, { timeoutMs: 65000 });
}


async function proxyCentralBridgeManaged(bridgeOp, args = {}, sessionToken = '', needRole = 'assistant', options = {}) {
  const auth = await requireRole(sessionToken, needRole);
  if (!auth.ok) return auth.out;

  const cacheKey = options.cacheKey ? `${options.cacheKey}|${JSON.stringify(args || {})}` : '';
  const ttlSec = Number(options.cacheTtlSec || 0);
  const staleSec = Number(options.cacheStaleSec || fastCacheStaleSec(options.cacheName || 'central_bridge', 600, 3600));
  if (cacheKey && ttlSec && !args.force && !args.refresh) {
    const cached = fastCacheGet(cacheKey);
    if (cached) return success({ ...cached, cache: { hit: true, ttl_sec: ttlSec, source: 'memory_fresh' } });
  }

  const result = await proxyRpcToGas(
    bridgeOp,
    {
      ...(args || {}),
      actor_staff_id: auth.me.staff_id,
      actor_role: normalizeRole(auth.me.role),
      actor_name: String(auth.me.name || '')
    },
    '',
    { timeoutMs: options.timeoutMs || 55000 }
  );

  if (result.body && result.body.ok === true) {
    if (cacheKey && ttlSec) fastCacheSet(cacheKey, result.body.data || {}, ttlSec, staleSec);
    if (options.mutate) {
      fastCacheDelPrefix('central.');
      fastCacheDelPrefix('classOptions');
      fastCacheDelPrefix('adminOpsOverview');
      fastCacheDelPrefix('masterStudentSearch');
      fastCacheDelPrefix('absenceExcuses');
    }
  } else if (cacheKey && ttlSec && options.allowStaleOnError !== false) {
    const stale = fastCacheGetStale(cacheKey);
    if (stale) {
      return success({
        ...stale,
        cache: { hit: true, stale: true, source: 'memory_stale' },
        upstream_error: result.body?.error || { code: 'UPSTREAM_ERROR', message: '중앙DB 응답 실패' }
      });
    }
  }

  return result;
}

function normalizedClassIdFromArgs(args = {}) {
  return String(args.class_id || args.classId || '').trim();
}

async function adminCentralClassHolidaysListDirect(args = {}, sessionToken = '') {
  const classId = normalizedClassIdFromArgs(args);
  if (!classId) return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.class.holidays.list', { class_id: classId }, sessionToken, 'assistant', {
    timeoutMs: 30000,
    cacheKey: `central.class.holidays.${classId}`,
    cacheTtlSec: fastCacheSec('central_class_holidays', 30, 180)
  });
}
async function adminCentralClassHolidayAddDirect(args = {}, sessionToken = '') {
  const classId = normalizedClassIdFromArgs(args);
  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || '');
  const reason = String(args.reason || '').trim().slice(0, 200);
  if (!classId || !yyyymmdd) return fail(400, 'INVALID_INPUT', 'class_id와 yyyymmdd가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.class.holidays.add', { class_id: classId, yyyymmdd, reason }, sessionToken, 'teacher', { timeoutMs: 65000, mutate: true });
}
async function adminCentralClassHolidayRemoveDirect(args = {}, sessionToken = '') {
  const classId = normalizedClassIdFromArgs(args);
  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || '');
  if (!classId || !yyyymmdd) return fail(400, 'INVALID_INPUT', 'class_id와 yyyymmdd가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.class.holidays.remove', { class_id: classId, yyyymmdd }, sessionToken, 'teacher', { timeoutMs: 65000, mutate: true });
}
async function adminCentralGlobalHolidaysListDirect(args = {}, sessionToken = '') {
  const from = normalizeYmdInput(args.from || args.fromYmd || '');
  const to = normalizeYmdInput(args.to || args.toYmd || '');
  return proxyCentralBridgeManaged('bridge.global_holidays.list', { from, to }, sessionToken, 'assistant', {
    timeoutMs: 30000,
    cacheKey: 'central.global_holidays',
    cacheTtlSec: fastCacheSec('central_global_holidays', 30, 180)
  });
}
async function adminCentralGlobalHolidayAddDirect(args = {}, sessionToken = '') {
  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || '');
  const name = String(args.name || '').trim().slice(0, 120);
  const note = String(args.note || '').trim().slice(0, 300);
  if (!yyyymmdd || !name) return fail(400, 'INVALID_INPUT', 'yyyymmdd와 name이 필요합니다.');
  return proxyCentralBridgeManaged('bridge.global_holidays.add', { yyyymmdd, name, note }, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
}
async function adminCentralGlobalHolidayRemoveDirect(args = {}, sessionToken = '') {
  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || '');
  if (!yyyymmdd) return fail(400, 'INVALID_INPUT', 'yyyymmdd가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.global_holidays.remove', { yyyymmdd }, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
}
async function adminCentralScheduleListDirect(args = {}, sessionToken = '') {
  const classId = normalizedClassIdFromArgs(args);
  if (!classId) return fail(400, 'INVALID_INPUT', 'class_id가 필요합니다.');
  const from = normalizeYmdInput(args.from || args.fromYmd || '');
  const to = normalizeYmdInput(args.to || args.toYmd || '');
  return proxyCentralBridgeManaged('bridge.schedule.list', { class_id: classId, from, to }, sessionToken, 'assistant', {
    timeoutMs: 35000,
    cacheKey: `central.schedule.${classId}`,
    cacheTtlSec: fastCacheSec('central_schedule', 20, 120)
  });
}
async function adminCentralScheduleUpdateDirect(args = {}, sessionToken = '') {
  const classId = normalizedClassIdFromArgs(args);
  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || '');
  const status = String(args.status || '').trim().toUpperCase();
  const reason = String(args.reason || '').trim().slice(0, 200);
  if (!classId || !yyyymmdd || !status) return fail(400, 'INVALID_INPUT', 'class_id, yyyymmdd, status가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.schedule.update', { class_id: classId, yyyymmdd, status, reason }, sessionToken, 'teacher', { timeoutMs: 65000, mutate: true });
}
async function adminCentralScheduleRebuildDirect(args = {}, sessionToken = '') {
  return proxyCentralBridgeManaged('bridge.schedule.rebuild', {}, sessionToken, 'admin', { timeoutMs: 90000, mutate: true });
}

function normalizeCentralStaffPhoneForStorage(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (/^010\d{8}$/.test(digits)) return digits;
  if (/^\d{8}$/.test(digits)) return '010' + digits;
  return null;
}

function pickCentralStaffPhone(row = {}) {
  const candidates = [
    row?.staff_phone,
    row?.phone,
    row?.mobile,
    row?.mobile_phone,
    row?.phone_number,
    row?.tel,
    row?.contact,
    row?.contact_phone
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCentralStaffPhoneForStorage(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function centralStaffPhoneWasProvided(input = {}) {
  return Object.prototype.hasOwnProperty.call(input, 'staff_phone') ||
    Object.prototype.hasOwnProperty.call(input, 'phone') ||
    Object.prototype.hasOwnProperty.call(input, 'mobile') ||
    Object.prototype.hasOwnProperty.call(input, 'mobile_phone') ||
    Object.prototype.hasOwnProperty.call(input, 'phone_number');
}

function normalizeDirectoryStaffId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._\-\u3131-\u318E\uAC00-\uD7A3]/g, '')
    .slice(0, 80);
}

function normalizeDirectoryStaffStatus(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return 'active';
  if (['active', '재직', '활성', 'enabled', '1', 'y', 'yes', 'true'].includes(v)) return 'active';
  if (['inactive', '비활성', '퇴사', 'disabled', '0', 'n', 'no', 'false'].includes(v)) return 'inactive';
  return v.slice(0, 30) || 'active';
}

function normalizeDirectoryStaffRevoked(input) {
  const v = String(input || '').trim().toLowerCase();
  return ['y', 'yes', '1', 'true', 'revoked', '중지', '해지', '퇴사'].includes(v) ? 'Y' : 'N';
}

async function upsertStaffPhoneDirectory(staff = {}, actor = '') {
  const staffId = normalizeDirectoryStaffId(staff.staff_id || staff.staffId || staff.id || '');
  const staffPhone = normalizeCentralStaffPhoneForStorage(
    staff.staff_phone || staff.phone || staff.mobile || staff.mobile_phone || staff.phone_number || ''
  );

  if (!staffId || !staffPhone) {
    return { ok: false, skipped: true, reason: !staffId ? 'missing_staff_id' : 'missing_or_invalid_phone' };
  }

  const supabase = getSupabaseAdmin();
  const row = {
    staff_id: staffId,
    name: String(staff.name || staff.staff_name || '').trim().slice(0, 80),
    role: normalizeRole(staff.role || 'assistant'),
    status: normalizeDirectoryStaffStatus(staff.status || 'active'),
    revoked: normalizeDirectoryStaffRevoked(staff.revoked || 'N'),
    staff_phone: staffPhone,
    source: String(staff.source || 'central_staff_upsert').trim().slice(0, 80) || 'central_staff_upsert',
    updated_by: String(actor || '').trim().slice(0, 80),
    updated_at: nowIso(),
    meta_json: {
      source: 'central_staff_phone_management',
      written_at: nowIso()
    }
  };

  try {
    const { data, error } = await supabase
      .from('staff_phone_directory')
      .upsert(row, { onConflict: 'staff_id' })
      .select('staff_id, staff_phone, updated_at')
      .maybeSingle();

    if (error) {
      return { ok: false, skipped: false, reason: error.message || 'directory_upsert_failed', code: String(error.code || '') };
    }

    return { ok: true, row: data || row };
  } catch (e) {
    return { ok: false, skipped: false, reason: e?.message || String(e) };
  }
}

async function readStaffPhoneDirectoryMap() {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase
      .from('staff_phone_directory')
      .select('staff_id, name, role, status, revoked, staff_phone, updated_at')
      .limit(1000);

    if (error) {
      if (phoneIdentityMissingTable(error, 'staff_phone_directory')) {
        return { ok: true, missing: true, map: new Map(), items: [] };
      }
      return { ok: false, missing: false, map: new Map(), items: [], error };
    }

    const items = (Array.isArray(data) ? data : [])
      .map(row => ({
        staff_id: normalizeDirectoryStaffId(row?.staff_id),
        name: String(row?.name || '').trim(),
        role: normalizeRole(row?.role || 'assistant'),
        status: normalizeDirectoryStaffStatus(row?.status || 'active'),
        revoked: normalizeDirectoryStaffRevoked(row?.revoked || 'N'),
        staff_phone: pickCentralStaffPhone(row),
        phone: pickCentralStaffPhone(row),
        updated_at: String(row?.updated_at || ''),
        _source_table: 'staff_phone_directory'
      }))
      .filter(row => row.staff_id && row.staff_phone);

    return { ok: true, missing: false, items, map: new Map(items.map(row => [row.staff_id, row])) };
  } catch (e) {
    return { ok: false, missing: false, map: new Map(), items: [], error: e };
  }
}

function mergeStaffPhoneDirectoryItems(items = [], directory = { map: new Map(), items: [] }) {
  const out = Array.isArray(items) ? items.map(item => ({ ...item })) : [];
  const map = directory && directory.map instanceof Map ? directory.map : new Map();
  const seen = new Set();

  for (const item of out) {
    const id = normalizeDirectoryStaffId(item.staff_id || item.id || '');
    if (!id) continue;
    seen.add(id);
    const dir = map.get(id);
    if (!dir) continue;
    const dirPhone = pickCentralStaffPhone(dir);
    if (dirPhone && !pickCentralStaffPhone(item)) {
      item.staff_phone = dirPhone;
      item.phone = dirPhone;
      item.phone_source = 'staff_phone_directory';
    }
  }

  for (const dir of directory.items || []) {
    const id = normalizeDirectoryStaffId(dir.staff_id || '');
    if (!id || seen.has(id)) continue;
    out.push({
      staff_id: id,
      name: dir.name || id,
      role: dir.role || 'assistant',
      revoked: dir.revoked || 'N',
      status: dir.status || 'active',
      has_password: false,
      has_pin: false,
      staff_phone: dir.staff_phone,
      phone: dir.staff_phone,
      source: 'staff_phone_directory',
      phone_source: 'staff_phone_directory'
    });
  }

  return out;
}

async function patchCentralStaffPhoneMirror(staffId, staffPhone) {
  const sid = String(staffId || '').trim().toLowerCase();
  if (!sid) return { ok: false, updated: [], skipped: [], error: 'missing staff_id' };
  const supabase = getSupabaseAdmin();
  const tables = ['staff', 'staff_snapshot'];
  const columns = ['staff_phone', 'phone', 'mobile', 'mobile_phone', 'phone_number'];
  const updated = [];
  const skipped = [];

  for (const table of tables) {
    let tableDone = false;
    for (const column of columns) {
      try {
        const { data, error } = await supabase
          .from(table)
          .update({ [column]: staffPhone })
          .eq('staff_id', sid)
          .select(`staff_id, ${column}`)
          .limit(1);

        if (!error) {
          const hit = Array.isArray(data) && data.length > 0;
          updated.push({ table, column, matched: hit });
          tableDone = true;
          break;
        }

        const code = String(error?.code || '').trim();
        const message = String(error?.message || '').toLowerCase();
        if (code === 'PGRST205' || message.includes('could not find the table')) {
          skipped.push({ table, column, reason: 'missing_table' });
          tableDone = true;
          break;
        }
        if (code === 'PGRST204' || message.includes('column') || message.includes('schema cache')) {
          skipped.push({ table, column, reason: 'missing_column' });
          continue;
        }
        skipped.push({ table, column, reason: error.message || 'update_failed' });
      } catch (e) {
        skipped.push({ table, column, reason: e?.message || String(e) });
      }
    }
    if (!tableDone) skipped.push({ table, column: '', reason: 'no_supported_phone_column' });
  }

  return {
    ok: updated.some(item => item.matched),
    updated,
    skipped,
    note: updated.some(item => item.matched)
      ? '직원 휴대폰 번호가 Supabase 직원 mirror에 반영되었습니다.'
      : '직원 mirror row가 아직 없거나 phone 컬럼이 없습니다. docs/supabase-staff-phone-v1.sql 적용 및 중앙DB 최신화를 확인하세요.'
  };
}

async function readCentralStaffListReplicaDirect() {
  const supabase = getSupabaseAdmin();
  const readFrom = async (table) => {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('staff_id', { ascending: true })
      .limit(500);
    if (error) return { ok: false, error, table, items: [] };
    const items = (Array.isArray(data) ? data : [])
      .map(row => {
        const staffId = String(row?.staff_id || '').trim().toLowerCase();
        if (!staffId) return null;
        const revoked = String(row?.revoked || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N';
        const status = String(row?.status || (revoked === 'Y' ? 'inactive' : 'active')).trim().toLowerCase();
        return {
          staff_id: staffId,
          name: String(row?.name || '').trim(),
          role: normalizeRole(row?.role || 'assistant'),
          revoked,
          status,
          has_password: !!String(row?.password_hash || row?.pw_hash || '').trim(),
          has_pin: !!String(row?.pin_hash || '').trim(),
          staff_phone: pickCentralStaffPhone(row),
          phone: pickCentralStaffPhone(row),
          last_login_at: String(row?.last_login_at || ''),
          created_at: String(row?.created_at || ''),
          updated_at: String(row?.updated_at || '')
        };
      })
      .filter(Boolean);
    return { ok: true, table, items };
  };

  let out = await readFrom('staff');
  if ((!out.ok || !out.items.length) && !(out.error && String(out.error?.code || '') !== 'PGRST205')) {
    out = await readFrom('staff_snapshot');
  }
  return out;
}

async function adminCentralStaffListDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const directory = await readStaffPhoneDirectoryMap();
  const cacheKey = 'central.staff.list.replica|{}';
  if (!args.force && !args.refresh && String(args.source || '').toLowerCase() !== 'central') {
    const cached = fastCacheGet(cacheKey);
    if (cached) {
      const merged = mergeStaffPhoneDirectoryItems(cached.staff || cached.items || [], directory);
      return success({ ...cached, staff: merged, items: merged, count: merged.length, cache: { hit: true, source: 'memory_fresh' } });
    }

    const replica = await readCentralStaffListReplicaDirect();
    if (replica.ok && replica.items.length) {
      const staffItems = mergeStaffPhoneDirectoryItems(replica.items, directory);
      const out = {
        staff: staffItems,
        items: staffItems,
        count: staffItems.length,
        source: 'supabase_replica',
        replica_table: replica.table,
        phone_directory: { ok: !!directory.ok, missing: !!directory.missing, count: directory.items?.length || 0 },
        fast: true,
        note: '중앙DB 직원 목록을 Supabase replica에서 우선 조회하고, staff_phone_directory로 휴대폰 번호를 보강했습니다. 강제 원본 확인은 force=true로 호출합니다.'
      };
      fastCacheSet(cacheKey, out, fastCacheSec('central_staff_list', 45, 300), fastCacheStaleSec('central_staff_list', 900, 3600));
      return success(out);
    }
  }

  const result = await proxyCentralBridgeManaged('bridge.staff.list', {}, sessionToken, 'admin', {
    timeoutMs: 35000,
    cacheKey: 'central.staff.list',
    cacheTtlSec: fastCacheSec('central_staff_list', 45, 300),
    cacheStaleSec: fastCacheStaleSec('central_staff_list', 900, 3600),
    cacheName: 'central_staff_list'
  });

  if (result.body?.ok === true && result.body.data) {
    const data = result.body.data;
    const baseItems = Array.isArray(data.staff) ? data.staff : (Array.isArray(data.items) ? data.items : []);
    const staffItems = mergeStaffPhoneDirectoryItems(baseItems, directory);
    result.body.data = {
      ...data,
      staff: staffItems,
      items: staffItems,
      count: staffItems.length,
      phone_directory: { ok: !!directory.ok, missing: !!directory.missing, count: directory.items?.length || 0 }
    };
  }

  return result;
}
async function adminCentralStaffUpsertDirect(args = {}, sessionToken = '') {
  const input = args.staff || args || {};
  const phoneProvided = centralStaffPhoneWasProvided(input);
  const normalizedPhone = normalizeCentralStaffPhoneForStorage(
    input.staff_phone || input.phone || input.mobile || input.mobile_phone || input.phone_number || ''
  );
  if (phoneProvided && normalizedPhone === null) {
    return fail(400, 'INVALID_INPUT', '직원 휴대폰 번호는 010으로 시작하는 11자리 또는 뒤 8자리로 입력하세요.');
  }
  const staff = {
    staff_id: String(input.staff_id || input.staffId || '').trim().toLowerCase().slice(0, 80),
    name: String(input.name || '').trim().slice(0, 80),
    role: String(input.role || 'assistant').trim().toLowerCase().slice(0, 30),
    revoked: String(input.revoked || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
    status: String(input.status || 'inactive').trim().toLowerCase().slice(0, 30),
    staff_phone: normalizedPhone || '',
    phone: normalizedPhone || '',
    password: String(input.password || '').slice(0, 200),
    pin: String(input.pin || '').replace(/[^0-9]/g, '').slice(0, 8)
  };
  if (!staff.staff_id) return fail(400, 'INVALID_INPUT', 'staff_id가 필요합니다.');

  const result = await proxyCentralBridgeManaged('bridge.staff.upsert', { staff }, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
  if (result.body?.ok === true && phoneProvided) {
    const auth = await authMeDirect(String(sessionToken || '').trim(), { touch: false }).catch(() => null);
    const actor = auth?.staff_id || '';
    const phoneDirectory = await upsertStaffPhoneDirectory({ ...staff, source: 'admin.central.staff.upsert' }, actor);
    const phonePatch = await patchCentralStaffPhoneMirror(staff.staff_id, normalizedPhone || '');
    result.body.data = {
      ...(result.body.data || {}),
      staff_phone: normalizedPhone || '',
      staff_phone_directory: phoneDirectory,
      staff_phone_patch: phonePatch
    };
    fastCacheDelPrefix('central.staff.list');
    fastCacheDelPrefix('central_staff_list');
  }
  return result;
}

async function adminCentralStaffPhoneOnlyDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const input = args.staff || args || {};
  const staffId = String(input.staff_id || input.staffId || '').trim().toLowerCase().slice(0, 80);
  const normalizedPhone = normalizeCentralStaffPhoneForStorage(
    input.staff_phone || input.phone || input.mobile || input.mobile_phone || input.phone_number || ''
  );

  if (!staffId) return fail(400, 'INVALID_INPUT', 'staff_id가 필요합니다.');
  if (!normalizedPhone) {
    return fail(400, 'INVALID_INPUT', '직원 휴대폰 번호는 010으로 시작하는 11자리 또는 뒤 8자리로 입력하세요.');
  }

  const phoneStaff = {
    staff_id: staffId,
    name: String(input.name || '').trim().slice(0, 80),
    role: String(input.role || 'assistant').trim().toLowerCase().slice(0, 30),
    revoked: String(input.revoked || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
    status: String(input.status || 'active').trim().toLowerCase().slice(0, 30),
    staff_phone: normalizedPhone,
    phone: normalizedPhone,
    source: 'admin.central.staff.phoneOnly'
  };

  const phoneDirectory = await upsertStaffPhoneDirectory(phoneStaff, auth.me?.staff_id || '');
  const phonePatch = await patchCentralStaffPhoneMirror(staffId, normalizedPhone);
  fastCacheDelPrefix('central.staff.list');
  fastCacheDelPrefix('central_staff_list');

  return success({
    staff_id: staffId,
    staff_phone: normalizedPhone,
    staff_phone_directory: phoneDirectory,
    staff_phone_patch: phonePatch,
    note: '기존 직원 계정의 비밀번호/PIN/권한을 건드리지 않고 휴대폰 번호만 출퇴근용으로 저장했습니다.'
  });
}

async function adminCentralStaffToggleDirect(args = {}, sessionToken = '') {
  const staffId = String(args.staff_id || args.staffId || '').trim().toLowerCase();
  if (!staffId) return fail(400, 'INVALID_INPUT', 'staff_id가 필요합니다.');
  return proxyCentralBridgeManaged('bridge.staff.toggle_status', { staff_id: staffId }, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
}
async function adminCentralStaffResetSecretDirect(args = {}, sessionToken = '') {
  const staffId = String(args.staff_id || args.staffId || '').trim().toLowerCase();
  const password = String(args.password || '').slice(0, 200);
  const pin = String(args.pin || '').replace(/[^0-9]/g, '').slice(0, 8);
  if (!staffId || (!password && !pin)) return fail(400, 'INVALID_INPUT', 'staff_id와 password 또는 pin이 필요합니다.');
  return proxyCentralBridgeManaged('bridge.staff.reset_secret', { staff_id: staffId, password, pin }, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
}
async function readCentralPropsSnapshotDirect(maxAgeSec = 3600) {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('runtime_config')
      .select('key, value_json, updated_at')
      .eq('key', 'central_props_snapshot')
      .maybeSingle();
    if (error || !data || !data.value_json) return null;
    const updatedAt = Date.parse(String(data.updated_at || data.value_json.updated_at || ''));
    const ageSec = Number.isFinite(updatedAt) ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : null;
    if (ageSec != null && maxAgeSec > 0 && ageSec > maxAgeSec) return null;
    return {
      ...(data.value_json.props || data.value_json),
      source: 'runtime_config_snapshot',
      snapshot_age_sec: ageSec
    };
  } catch (_) {
    return null;
  }
}

async function writeCentralPropsSnapshotDirect(props = {}, updatedBy = '') {
  try {
    await writeRuntimeConfig('central_props_snapshot', {
      props: props && typeof props === 'object' ? props : {},
      updated_at: nowIso()
    }, updatedBy);
  } catch (_) {
    // snapshot 저장 실패는 중앙DB 원본 작업을 막지 않습니다.
  }
}

async function adminCentralPropsGetDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const maxAgeSec = Math.max(60, Math.min(86400, toPositiveInt(args.max_age_sec || args.maxAgeSec || process.env.CENTRAL_PROPS_SNAPSHOT_SEC, 3600)));
  if (!args.force && !args.refresh) {
    const memory = fastCacheGet('central.props.snapshot|{}');
    if (memory) return success({ ...memory, cache: { hit: true, source: 'memory_fresh' } });
    const snapshot = await readCentralPropsSnapshotDirect(maxAgeSec);
    if (snapshot) {
      const out = { ...snapshot, fast: true };
      fastCacheSet('central.props.snapshot|{}', out, fastCacheSec('central_props', 120, 600), fastCacheStaleSec('central_props', 1800, 86400));
      return success(out);
    }
  }

  const result = await proxyCentralBridgeManaged('bridge.props.get', {}, sessionToken, 'admin', {
    timeoutMs: 30000,
    cacheKey: 'central.props',
    cacheTtlSec: fastCacheSec('central_props', 120, 600),
    cacheStaleSec: fastCacheStaleSec('central_props', 1800, 86400),
    cacheName: 'central_props'
  });

  if (result.body?.ok === true) {
    await writeCentralPropsSnapshotDirect(result.body.data || {}, auth.me.staff_id);
  }

  return result;
}
async function adminCentralPropsSetDirect(args = {}, sessionToken = '') {
  const props = args.props || args || {};
  const cleanProps = {
    STUDENTS_SHEET_NAME: String(props.STUDENTS_SHEET_NAME || '').trim(),
    CLASS_SYNC_CALENDAR: String(props.CLASS_SYNC_CALENDAR || 'N').trim().toUpperCase(),
    CLASS_CALENDAR_ID: String(props.CLASS_CALENDAR_ID || '').trim(),
    STUDENTS_CACHE_TTL: String(props.STUDENTS_CACHE_TTL || '').trim(),
    SESSION_TTL_SEC: String(props.SESSION_TTL_SEC || '').trim()
  };
  const result = await proxyCentralBridgeManaged('bridge.props.set', cleanProps, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
  if (result.body?.ok === true) {
    const me = await authMeDirect(String(sessionToken || '').trim(), { touch: false });
    await writeCentralPropsSnapshotDirect(result.body.data || cleanProps, me?.staff_id || '');
    fastCacheDelPrefix('central.props');
  }
  return result;
}
async function adminCentralSelfCheckDirect(args = {}, sessionToken = '') {
  return proxyCentralBridgeManaged('bridge.self_check.run', {}, sessionToken, 'admin', { timeoutMs: 65000, mutate: true });
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

  const rawYmd = String(args.yyyymmdd || args.ymd || '').trim();
  const yyyymmdd = normalizeYmdInput(rawYmd);
  const limit = Math.max(1, Math.min(1000, toPositiveInt(args.limit, 500)));
  const includeInactive = args.include_inactive === true || args.includeInactive === true;
  const allowFallback = args.fallback !== false;
  const supabase = getSupabaseAdmin();

  if (rawYmd && !yyyymmdd) {
    return fail(400, 'INVALID_INPUT', '날짜는 YYYYMMDD 또는 YYYY-MM-DD 형식으로 입력해 주세요.');
  }

  const cacheKey = [
    'classOptions',
    yyyymmdd || 'all',
    includeInactive ? 'Y' : 'N',
    limit,
    allowFallback ? 'fallback' : 'strict'
  ].join('|');
  const cached = fastCacheGet(cacheKey);
  if (cached) return success({ ...cached, cache: { hit: true, ttl_sec: fastCacheSec('class_options', 45, 180) } });

  const loadBaseClasses = async (reason = '') => {
    const { data: classRows, error: classErr } = await supabase
      .from('classes')
      .select('class_id, name, teacher, start, end, room, alert_delay, alert_to, status')
      .order('start', { ascending: true })
      .limit(limit);

    if (classErr) {
      return { ok: false, error: classErr, items: [] };
    }

    const rows = (Array.isArray(classRows) ? classRows : [])
      .filter(row => includeInactive || isActiveLikeClassStatus(row?.status));
    const staffNameMap = await readStaffNameMap(
      supabase,
      rows.map(row => row?.teacher).filter(Boolean)
    );

    const items = rows
      .map(row => mapClassOptionRow(row, staffNameMap, { source: reason ? 'classes_fallback' : 'classes' }))
      .filter(item => item.class_id);

    return { ok: true, items };
  };

  if (yyyymmdd) {
    const { data: scheduleRows, error: scheduleErr } = await supabase
      .from('class_schedule')
      .select('yyyymmdd, class_id, class_name, teacher, start, end, status')
      .eq('yyyymmdd', yyyymmdd)
      .order('start', { ascending: true })
      .limit(limit);

    if (scheduleErr && !allowFallback) {
      return fail(500, 'DB_SELECT_FAILED', scheduleErr.message || 'class_schedule 조회 실패');
    }

    const schedules = (Array.isArray(scheduleRows) ? scheduleRows : [])
      .filter(row => includeInactive || isActiveLikeScheduleStatus(row?.status));

    if (!scheduleErr && schedules.length) {
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
        return mapClassOptionRow(
          {
            ...classRow,
            ...row,
            name: row?.class_name || classRow?.name || '',
            room: classRow?.room || '',
            alert_delay: classRow?.alert_delay || '',
            alert_to: classRow?.alert_to || ''
          },
          staffNameMap,
          { yyyymmdd, source: 'class_schedule' }
        );
      }).filter(item => item.class_id);

      const out = { yyyymmdd, count: items.length, items, fallback: false };
      fastCacheSet(cacheKey, out, fastCacheSec('class_options', 45, 180));
      return success(out);
    }

    const base = await loadBaseClasses(scheduleErr ? 'schedule_error' : 'schedule_empty');
    if (!base.ok) {
      const message = scheduleErr?.message || base.error?.message || '클래스 조회 실패';
      return fail(500, 'DB_SELECT_FAILED', message);
    }

    const out = {
      yyyymmdd,
      count: base.items.length,
      items: base.items,
      fallback: true,
      fallback_reason: scheduleErr ? 'class_schedule 조회 실패로 전체 클래스 목록을 표시했습니다.' : '해당 날짜 수업 일정이 없어 전체 클래스 목록을 표시했습니다.'
    };
    fastCacheSet(cacheKey, out, fastCacheSec('class_options', 45, 180));
    return success(out);
  }

  const base = await loadBaseClasses('');
  if (!base.ok) {
    return fail(500, 'DB_SELECT_FAILED', base.error?.message || 'classes 조회 실패');
  }

  const out = { count: base.items.length, items: base.items, fallback: false };
  fastCacheSet(cacheKey, out, fastCacheSec('class_options', 45, 180));
  return success(out);
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

function normalizeClinicTaskType(raw, fallback = 'INDIVIDUAL_CLINIC') {
  const value = String(raw || '').trim().toUpperCase();
  const canonical = new Set(['CLASS_CLINIC', 'EXTRA_CLINIC', 'INDIVIDUAL_CLINIC']);
  if (canonical.has(value)) return value;
  const legacyMap = {
    GENERAL: 'INDIVIDUAL_CLINIC',
    WORD: 'EXTRA_CLINIC',
    GRAMMAR: 'CLASS_CLINIC',
    READING: 'CLASS_CLINIC',
    WRITING: 'CLASS_CLINIC',
    ATTENDANCE: 'INDIVIDUAL_CLINIC',
    HOMEWORK: 'EXTRA_CLINIC',
    MAKEUP: 'EXTRA_CLINIC',
    INDIVIDUAL_BASE: 'INDIVIDUAL_CLINIC'
  };
  if (legacyMap[value]) return legacyMap[value];
  return fallback;
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

function normalizeWordCount(raw, fallback = null) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

function normalizeWordTotal(raw, fallback = 100) {
  const n = normalizeWordCount(raw, fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeWordPassCount(raw, totalCount, fallback = null) {
  const total = normalizeWordTotal(totalCount, 100);
  const defaultValue = fallback === null || fallback === undefined ? Math.ceil(total * 0.9) : fallback;
  const n = normalizeWordCount(raw, defaultValue);
  return Math.max(0, Math.min(total, n));
}

function normalizeWordResultStatus(raw, correctCount, passCount) {
  const value = String(raw || '').trim().toUpperCase();
  if (['PASS', 'FAIL', 'ABSENT', 'EXEMPT'].includes(value)) return value;
  const n = Number(correctCount);
  const p = Number(passCount);
  if (Number.isFinite(n) && Number.isFinite(p)) return n >= p ? 'PASS' : 'FAIL';
  return 'PASS';
}

function normalizeScore(raw, fallback = null) {
  return normalizeWordCount(raw, fallback);
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
    due_time: String(row?.due_time || '').trim(),
    due_at: String(row?.due_at || '').trim(),
    clinic_mode: String(row?.clinic_mode || 'OFFLINE').trim().toUpperCase(),
    auto_notice_enabled: row?.auto_notice_enabled !== false,
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
    pass_count: Number(row?.pass_score ?? 90),
    total_count: Number(row?.max_score ?? 100),
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
    correct_count: row?.score == null ? null : Number(row.score),
    max_score: Number(row?.max_score ?? session.max_score ?? 100),
    total_count: Number(row?.max_score ?? session.max_score ?? 100),
    pass_score: Number(row?.pass_score ?? session.pass_score ?? 90),
    pass_count: Number(row?.pass_score ?? session.pass_score ?? 90),
    result_status: String(row?.result_status || '').trim(),
    clinic_task_id: String(row?.clinic_task_id || '').trim(),
    note: String(row?.note || '').trim(),
    created_at: String(row?.created_at || ''),
    updated_at: String(row?.updated_at || '')
  };
}


function isMissingWordRecordsTableError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || error?.details || error || '').toLowerCase();
  return code === '42P01'
    || code === 'PGRST116'
    || code === 'PGRST205'
    || message.includes('word_records')
    || message.includes('does not exist')
    || message.includes('schema cache');
}

function mapWordRecordRow(row = {}, studentNameMap = {}) {
  const sid = normalizeStudentId(row?.student_id);
  const totalCount = normalizeWordTotal(row?.word_total_count ?? row?.total_count ?? row?.max_score, 0);
  const correctRaw = row?.word_correct_count ?? row?.correct_count ?? row?.score;
  const correctCount = correctRaw == null ? null : normalizeWordCount(correctRaw, null);
  const passCount = normalizeWordPassCount(row?.word_pass_count ?? row?.pass_count ?? row?.pass_score, totalCount || 100, Math.ceil((totalCount || 100) * 0.9));
  const status = String(row?.result_status || '').trim().toUpperCase();
  const accuracy = row?.word_accuracy == null ? (correctCount === null || !totalCount ? null : Math.round((correctCount / totalCount) * 10000) / 100) : Number(row.word_accuracy);
  return {
    record_id: String(row?.record_id || '').trim(),
    academy_id: String(row?.academy_id || '').trim(),
    student_id: sid,
    student_name: studentNameMap[sid] || '',
    class_id: String(row?.class_id || '').trim(),
    session_id: String(row?.session_id || '').trim(),
    result_id: String(row?.result_id || '').trim(),
    book_id: String(row?.book_id || '').trim(),
    range_id: String(row?.range_id || '').trim(),
    word_book_title: String(row?.word_book_title || '').trim(),
    range_label: String(row?.range_label || '').trim(),
    scope_text: String(row?.scope_text || '').trim(),
    yyyymmdd: String(row?.yyyymmdd || '').trim(),
    word_total_count: totalCount,
    total_count: totalCount,
    word_correct_count: correctCount,
    correct_count: correctCount,
    word_pass_count: passCount,
    pass_count: passCount,
    word_accuracy: Number.isFinite(accuracy) ? accuracy : null,
    result_status: status,
    word_passed: row?.word_passed === true || status === 'PASS' || status === 'EXEMPT',
    word_needs_retest: row?.word_needs_retest === true || status === 'FAIL',
    word_needs_clinic: row?.word_needs_clinic === true || status === 'FAIL',
    clinic_task_id: String(row?.clinic_task_id || '').trim(),
    attempt_no: Number(row?.attempt_no || 1) || 1,
    source: String(row?.source || '').trim(),
    note: String(row?.note || '').trim(),
    created_by: String(row?.created_by || '').trim(),
    created_at: String(row?.created_at || ''),
    updated_by: String(row?.updated_by || '').trim(),
    updated_at: String(row?.updated_at || '')
  };
}

function buildWordRecordMirrorRow(result = {}, session = {}, auth = {}, source = 'wordTest.mirror') {
  const totalCount = normalizeWordTotal(result.max_score ?? session.max_score, 100);
  const correctCount = result.score == null ? null : normalizeWordCount(result.score, null);
  const passCount = normalizeWordPassCount(result.pass_score ?? session.pass_score, totalCount, Math.ceil(totalCount * 0.9));
  const resultStatus = normalizeWordResultStatus(result.result_status, correctCount, passCount);
  const wordAccuracy = correctCount === null ? null : Math.round((correctCount / totalCount) * 10000) / 100;
  return {
    record_id: String(result.record_id || '').trim() || randomUUID(),
    academy_id: String(session.academy_id || result.academy_id || '').trim() || null,
    student_id: normalizeStudentId(result.student_id),
    class_id: String(session.class_id || result.class_id || '').trim() || null,
    session_id: String(result.session_id || session.session_id || '').trim() || null,
    result_id: String(result.result_id || '').trim() || null,
    book_id: String(session.book_id || result.book_id || '').trim() || null,
    range_id: String(session.range_id || result.range_id || '').trim() || null,
    word_book_title: normalizeLimitedText(session.book_title || session.word_book_title || '', 200),
    range_label: normalizeLimitedText(session.range_label || '', 200),
    scope_text: normalizeLimitedText(session.scope_text || result.scope_text || '', 1000),
    yyyymmdd: String(session.yyyymmdd || result.yyyymmdd || kstYmd(new Date())).replace(/[^0-9]/g, '').slice(0, 8),
    word_total_count: totalCount,
    word_correct_count: correctCount,
    word_pass_count: passCount,
    word_accuracy: wordAccuracy,
    result_status: resultStatus,
    word_passed: resultStatus === 'PASS' || resultStatus === 'EXEMPT',
    word_needs_retest: resultStatus === 'FAIL',
    word_needs_clinic: resultStatus === 'FAIL',
    clinic_task_id: String(result.clinic_task_id || '').trim() || null,
    attempt_no: Number(result.attempt_no || 1) || 1,
    source,
    note: normalizeLimitedText(result.note, 1000),
    created_by: String(result.created_by || auth?.me?.staff_id || '').trim() || null,
    created_at: String(result.created_at || nowIso()),
    updated_by: String(auth?.me?.staff_id || result.updated_by || '').trim() || null,
    updated_at: nowIso(),
    deleted_at: null
  };
}

async function upsertWordRecordMirrorsIfAvailable(supabase, auth, results = [], session = {}, source = 'wordTest.mirror') {
  const rows = (Array.isArray(results) ? results : [results])
    .filter(Boolean)
    .map(row => buildWordRecordMirrorRow(row, session, auth, source))
    .filter(row => row.student_id && row.session_id);
  if (!rows.length) return { ok: true, mirrored_count: 0, skipped: true, warning: '' };

  const { data, error } = await supabase
    .from('word_records')
    .upsert(rows, { onConflict: 'session_id,student_id' })
    .select('record_id, session_id, student_id, result_status, word_needs_retest, word_needs_clinic, updated_at');

  if (error) {
    if (isMissingWordRecordsTableError(error)) {
      return { ok: true, mirrored_count: 0, skipped: true, warning: 'word_records 테이블이 없어 학생별 단어 누적 mirror를 건너뛰었습니다. docs/supabase-student-word-records-v1.sql 적용이 필요합니다.' };
    }
    return { ok: false, mirrored_count: 0, skipped: false, warning: error.message || 'word_records mirror 저장 실패' };
  }
  return { ok: true, mirrored_count: Array.isArray(data) ? data.length : rows.length, skipped: false, warning: '' };
}

async function wordRecordListDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const sessionId = String(args.session_id || args.sessionId || '').trim();
  const status = String(args.result_status || args.resultStatus || '').trim().toUpperCase();
  const startYmd = String(args.start_ymd || args.startYmd || args.period_start || args.periodStart || '').replace(/[^0-9]/g, '').slice(0, 8);
  const endYmd = String(args.end_ymd || args.endYmd || args.period_end || args.periodEnd || '').replace(/[^0-9]/g, '').slice(0, 8);
  const needsRetest = args.needs_retest ?? args.needsRetest;
  const needsClinic = args.needs_clinic ?? args.needsClinic;
  const limit = Math.max(1, Math.min(500, toPositiveInt(args.limit, 100)));

  if (startYmd && !isStrictYmd(startYmd)) return fail(400, 'INVALID_INPUT', '조회 시작일은 YYYYMMDD 형식이어야 합니다.');
  if (endYmd && !isStrictYmd(endYmd)) return fail(400, 'INVALID_INPUT', '조회 종료일은 YYYYMMDD 형식이어야 합니다.');
  if (startYmd && endYmd && startYmd > endYmd) return fail(400, 'INVALID_INPUT', '조회 시작일은 종료일보다 늦을 수 없습니다.');

  let q = supabase
    .from('word_records')
    .select('record_id, academy_id, student_id, class_id, session_id, result_id, book_id, range_id, word_book_title, range_label, scope_text, yyyymmdd, word_total_count, word_correct_count, word_pass_count, word_accuracy, result_status, word_passed, word_needs_retest, word_needs_clinic, clinic_task_id, attempt_no, source, note, created_by, created_at, updated_by, updated_at')
    .order('yyyymmdd', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (sid) q = q.eq('student_id', sid);
  if (sessionId) q = q.eq('session_id', sessionId);
  if (['PASS', 'FAIL', 'ABSENT', 'EXEMPT'].includes(status)) q = q.eq('result_status', status);
  if (startYmd) q = q.gte('yyyymmdd', startYmd);
  if (endYmd) q = q.lte('yyyymmdd', endYmd);
  if (needsRetest !== undefined && needsRetest !== null && String(needsRetest).trim() !== '') q = q.eq('word_needs_retest', normalizeBool(needsRetest, false));
  if (needsClinic !== undefined && needsClinic !== null && String(needsClinic).trim() !== '') q = q.eq('word_needs_clinic', normalizeBool(needsClinic, false));

  const { data, error } = await q;
  if (error) {
    if (isMissingWordRecordsTableError(error)) {
      return success({
        source: 'MISSING_TABLE',
        count: 0,
        pass_count: 0,
        fail_count: 0,
        retest_count: 0,
        clinic_candidate_count: 0,
        items: [],
        filter: { student_id: sid, session_id: sessionId, result_status: status, start_ymd: startYmd, end_ymd: endYmd, limit },
        warnings: ['word_records 테이블이 아직 없습니다. docs/supabase-student-word-records-v1.sql 적용 후 학생별 누적 기록을 사용할 수 있습니다.']
      });
    }
    return fail(500, 'DB_SELECT_FAILED', error.message || 'word_records 조회 실패');
  }

  const rows = Array.isArray(data) ? data : [];
  const studentIds = Array.from(new Set(rows.map(row => normalizeStudentId(row?.student_id)).filter(Boolean)));
  const studentNameMap = await readStudentNameMap(supabase, studentIds);
  const items = rows.map(row => mapWordRecordRow(row, studentNameMap));
  return success({
    source: 'SUPABASE',
    count: items.length,
    pass_count: items.filter(row => row.result_status === 'PASS').length,
    fail_count: items.filter(row => row.result_status === 'FAIL').length,
    retest_count: items.filter(row => row.word_needs_retest).length,
    clinic_candidate_count: items.filter(row => row.word_needs_clinic).length,
    items,
    filter: { student_id: sid, session_id: sessionId, result_status: status, start_ymd: startYmd, end_ymd: endYmd, limit },
    warnings: []
  });
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
  const taskType = normalizeClinicTaskType(args.task_type || args.taskType || '', '');
  const rawDue = String(args.due_date || args.dueDate || args.due_ymd || args.dueYmd || '').replace(/[^0-9]/g, '');
  const dueDate = rawDue.length === 8 ? `${rawDue.slice(0,4)}-${rawDue.slice(4,6)}-${rawDue.slice(6,8)}` : String(args.due_date || args.dueDate || '').trim();
  const openOnly = normalizeBool(args.open_only ?? args.openOnly, false);
  const limit = Math.max(1, Math.min(300, toPositiveInt(args.limit, 100)));

  let q = supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, source_id, status, priority, due_date, due_time, due_at, clinic_mode, auto_notice_enabled, assigned_staff_id, internal_note, parent_note, parent_visible, created_by, created_at, updated_by, updated_at, completed_at')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', normalizeClinicStatus(status));
  if (sid) q = q.eq('student_id', sid);
  if (classId) q = q.eq('class_id', classId);
  if (taskType) q = q.eq('task_type', taskType);
  if (dueDate) q = q.eq('due_date', dueDate);
  if (openOnly) q = q.not('status', 'in', '(DONE,PARTIAL,REJECTED,CANCELLED)');

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'clinic_tasks 조회 실패');

  const items = await hydrateClinicTasks(supabase, data || []);
  return success({ count: items.length, items });
}


async function insertClinicNoticeQueueDirect(supabase, auth, params = {}) {
  const task = params.task || {};
  const student = params.student || {};
  const actionType = normalizeClinicNoticeAction(params.action_type || params.actionType);
  const audience = clinicNoticeAudience(actionType);
  const clinicTaskId = String(task.clinic_task_id || '').trim();
  const sid = normalizeStudentId(task.student_id || student.student_id || '');
  if (!clinicTaskId || !sid) return { ok: false, skipped: true, reason: 'INVALID_TASK' };

  const parentPhone = String(student.parent_phone || '').replace(/[^0-9]/g, '').trim();
  const studentPhone = String(student.student_phone || '').replace(/[^0-9]/g, '').trim();
  const targetPhone = audience === 'STUDENT' ? studentPhone : parentPhone;
  if (!targetPhone) {
    return { ok: false, skipped: true, reason: audience === 'STUDENT' ? 'NO_STUDENT_PHONE' : 'NO_PARENT_PHONE', action_type: actionType };
  }

  const { data: existing, error: existingErr } = await supabase
    .from('attendance_notify_queue')
    .select('queue_id, status, attempts, last_error, created_at, processed_at')
    .eq('trace_id', clinicTaskId)
    .eq('action_type', actionType)
    .maybeSingle();
  if (existingErr) return { ok: false, reason: existingErr.message || 'QUEUE_SELECT_FAILED', action_type: actionType };
  if (existing) return { ok: true, duplicate: true, queue_id: existing.queue_id, status: existing.status, action_type: actionType };

  const row = {
    queue_id: randomUUID(),
    trace_id: clinicTaskId,
    student_id: sid,
    action_type: actionType,
    parent_phone: targetPhone,
    school: String(student.school || '').trim(),
    grade: String(student.grade || '').trim(),
    student_name: String(student.student_name || '').trim(),
    occurred_at: String(params.occurred_at || params.occurredAt || nowIso()).trim(),
    status: 'PENDING',
    attempts: 0,
    sent_channel: '',
    last_error: '',
    processed_at: null
  };
  const { data, error } = await supabase
    .from('attendance_notify_queue')
    .insert(row)
    .select('queue_id, status, action_type, occurred_at, created_at')
    .single();
  if (error) return { ok: false, reason: error.message || 'QUEUE_INSERT_FAILED', action_type: actionType };

  await appendPortalAuditLogDirect(supabase, auth, {
    op: clinicNoticeAuditOp(actionType),
    target_type: 'clinic_task',
    target_id: clinicTaskId,
    action: 'QUEUE_MESSAGE',
    after_json: { queue_id: row.queue_id, action_type: actionType, student_id: sid, audience, occurred_at: row.occurred_at },
    meta_json: {
      auto: params.auto === true,
      title: task.title || '',
      task_type: task.task_type || '',
      clinic_mode: task.clinic_mode || '',
      due_date: task.due_date || '',
      due_time: task.due_time || '',
      notice_label: clinicNoticeLabel(actionType)
    }
  });

  return { ok: true, duplicate: false, queue_id: data?.queue_id || row.queue_id, status: data?.status || 'PENDING', action_type: actionType, occurred_at: row.occurred_at };
}

async function enqueueOfflineClinicAutoNoticesDirect(supabase, auth, task = {}, student = {}) {
  if (String(task.clinic_mode || '').toUpperCase() !== 'OFFLINE') return { enabled: false, reason: 'NOT_OFFLINE', items: [] };
  if (task.auto_notice_enabled === false) return { enabled: false, reason: 'AUTO_NOTICE_OFF', items: [] };

  const dueDate = String(task.due_date || '').trim();
  const dueAt = String(task.due_at || '').trim() || (dueDate && task.due_time ? kstDateTimeFromYmdHhmm(dueDate, task.due_time) : '');
  const reminderAt = clinicMorningReminderIso(dueDate);
  const absenceDelayMin = toPositiveInt(process.env.CLINIC_ABSENCE_DELAY_MIN, 10);
  const absenceAt = dueAt ? addMinutesToIso(dueAt, absenceDelayMin) : '';

  const jobs = [
    { action_type: 'CLINIC_RESERVATION_PARENT', occurred_at: nowIso() },
    { action_type: 'CLINIC_RESERVATION_STUDENT', occurred_at: nowIso() }
  ];
  if (reminderAt) {
    jobs.push({ action_type: 'CLINIC_REMINDER_PARENT', occurred_at: reminderAt });
    jobs.push({ action_type: 'CLINIC_REMINDER_STUDENT', occurred_at: reminderAt });
  }
  if (absenceAt) {
    jobs.push({ action_type: 'CLINIC_ABSENCE_PARENT', occurred_at: absenceAt });
  }

  const items = [];
  for (const job of jobs) {
    // 예약 안내와 리마인드는 같은 템플릿을 쓰지만 action_type을 분리해서 즉시/오전 8시 중복을 구분한다.
    const result = await insertClinicNoticeQueueDirect(supabase, auth, {
      task,
      student,
      action_type: job.action_type,
      occurred_at: job.occurred_at,
      auto: true
    });
    items.push(result);
  }
  return { enabled: true, due_at: dueAt, reminder_at: reminderAt, absence_at: absenceAt, items };
}


function defaultClinicStatusForCreate(args = {}, taskType = 'INDIVIDUAL_CLINIC', sourceType = 'MANUAL') {
  if ('status' in args || 'clinic_status' in args || 'clinicStatus' in args) {
    return normalizeClinicStatus(args.status || args.clinic_status || args.clinicStatus, 'PENDING');
  }
  if (sourceType === 'WORD_FAIL') return 'CANDIDATE';
  return 'PENDING';
}

function defaultClinicModeForTaskType(taskType = 'INDIVIDUAL_CLINIC') {
  const type = normalizeClinicTaskType(taskType);
  return type === 'EXTRA_CLINIC' ? 'OFFLINE' : 'ONLINE';
}

function defaultClinicAutoNoticeForTaskType(taskType = 'INDIVIDUAL_CLINIC', clinicMode = 'ONLINE', sourceType = 'MANUAL') {
  const type = normalizeClinicTaskType(taskType);
  return sourceType === 'MANUAL' && type === 'EXTRA_CLINIC' && normalizeClinicMode(clinicMode, 'ONLINE') === 'OFFLINE';
}

async function readClassStudentIdsForClinic(supabase, classId) {
  const cid = String(classId || '').trim();
  if (!cid) return { ok: false, error: 'class_id가 필요합니다.', studentIds: [] };
  const { data, error } = await supabase
    .from('class_students')
    .select('student_id')
    .eq('class_id', cid)
    .limit(2000);
  if (error) return { ok: false, error: error.message || 'class_students 조회 실패', studentIds: [] };
  const studentIds = Array.from(new Set((Array.isArray(data) ? data : [])
    .map(row => normalizeStudentId(row?.student_id))
    .filter(Boolean)));
  return { ok: true, studentIds };
}

async function clinicCreateTaskDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const classId = normalizeLimitedText(args.class_id || args.classId, 80) || '';
  const title = normalizeLimitedText(args.title, 160);
  const taskType = normalizeClinicTaskType(args.task_type || args.taskType);
  const sourceTypeForAuto = normalizeClinicSourceType(args.source_type || args.sourceType);
  if (!title) return fail(400, 'INVALID_INPUT', '클리닉 제목이 필요합니다.');

  const safeDueDate = normalizeLimitedText(args.due_date || args.dueDate, 10) || null;
  const dueTimeText = normalizeHhmm(args.due_time || args.dueTime || args.clinic_time || args.clinicTime);
  const requestedMode = args.clinic_mode || args.clinicMode || defaultClinicModeForTaskType(taskType);
  const clinicMode = normalizeClinicMode(requestedMode, defaultClinicModeForTaskType(taskType));
  const dueAtText = String(args.due_at || args.dueAt || '').trim() || (safeDueDate && dueTimeText ? kstDateTimeFromYmdHhmm(safeDueDate, dueTimeText) : '');
  const autoNoticeEnabled = normalizeBool(
    args.auto_notice_enabled ?? args.autoNoticeEnabled,
    defaultClinicAutoNoticeForTaskType(taskType, clinicMode, sourceTypeForAuto)
  );
  const statusForCreate = defaultClinicStatusForCreate(args, taskType, sourceTypeForAuto);

  const baseRow = {
    class_id: classId || null,
    title,
    task_type: taskType,
    source_type: sourceTypeForAuto,
    source_id: normalizeLimitedText(args.source_id || args.sourceId, 120) || null,
    status: statusForCreate,
    priority: normalizeClinicPriority(args.priority),
    due_date: safeDueDate,
    due_time: dueTimeText,
    due_at: dueAtText || null,
    clinic_mode: clinicMode,
    auto_notice_enabled: autoNoticeEnabled,
    assigned_staff_id: normalizeLimitedText(args.assigned_staff_id || args.assignedStaffId, 80) || null,
    internal_note: normalizeLimitedText(args.internal_note || args.internalNote, 2000),
    parent_note: normalizeLimitedText(args.parent_note || args.parentNote, 1000),
    parent_visible: normalizeBool(args.parent_visible ?? args.parentVisible, false),
    created_by: auth.me.staff_id,
    updated_by: auth.me.staff_id,
    created_at: nowIso(),
    updated_at: nowIso(),
    completed_at: terminalClinicStatus(statusForCreate) ? nowIso() : null
  };

  if (taskType === 'CLASS_CLINIC') {
    if (!classId) return fail(400, 'INVALID_INPUT', '수업 클리닉은 class_id가 필요합니다.');
    const roster = await readClassStudentIdsForClinic(supabase, classId);
    if (!roster.ok) return fail(500, 'DB_SELECT_FAILED', roster.error || '반 명단 조회 실패');
    if (!roster.studentIds.length) return fail(400, 'EMPTY_ROSTER', '해당 클래스에 등록된 학생이 없습니다.');
    const groupId = normalizeLimitedText(args.source_id || args.sourceId, 120) || `CLASS_CLINIC_${randomUUID()}`;
    const rows = roster.studentIds.map(studentId => ({
      ...baseRow,
      clinic_task_id: randomUUID(),
      student_id: studentId,
      class_id: classId,
      source_id: groupId,
      clinic_mode: 'ONLINE',
      auto_notice_enabled: false,
      due_time: '',
      due_at: null,
      parent_visible: false
    }));
    const { data, error } = await supabase
      .from('clinic_tasks')
      .insert(rows)
      .select('*');
    if (error) return fail(500, 'DB_INSERT_FAILED', error.message || '수업 클리닉 일괄 생성 실패');
    await appendPortalAuditLogDirect(supabase, auth, {
      op: 'clinic.createClassTasks',
      target_type: 'class',
      target_id: classId,
      action: 'BULK_CREATE',
      after_json: { class_id: classId, count: rows.length, title, group_id: groupId, due_date: safeDueDate },
      meta_json: { task_type: 'CLASS_CLINIC', source_id: groupId }
    });
    const items = await hydrateClinicTasks(supabase, data || rows);
    return success({ bulk_created: true, count: items.length, items, class_id: classId, source_id: groupId, auto_notice: { enabled: false, reason: 'CLASS_CLINIC_NO_AUTO_NOTICE', items: [] } });
  }

  if (!sid) return fail(400, 'INVALID_INPUT', '개별/추가 클리닉은 student_id가 필요합니다.');

  const row = {
    ...baseRow,
    clinic_task_id: randomUUID(),
    student_id: sid
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
    meta_json: { source_type: row.source_type, clinic_mode: row.clinic_mode, auto_notice_enabled: row.auto_notice_enabled === true }
  });

  let auto_notice = { enabled: false, reason: 'NOT_REQUESTED', items: [] };
  if (row.auto_notice_enabled === true && row.clinic_mode === 'OFFLINE' && row.source_type === 'MANUAL' && row.task_type === 'EXTRA_CLINIC') {
    const { data: studentForNotice } = await supabase
      .from('students')
      .select('student_id, student_name, school, grade, student_phone, parent_phone')
      .eq('student_id', sid)
      .maybeSingle();
    auto_notice = await enqueueOfflineClinicAutoNoticesDirect(supabase, auth, data || row, studentForNotice || { student_id: sid });
  }

  const items = await hydrateClinicTasks(supabase, [data || row]);
  return success({ item: items[0] || mapClinicTaskRow(data || row), auto_notice, audit_warning: audit.ok ? '' : audit.error || '' });
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


function clinicOpenStatusFilter(q) {
  return q.not('status', 'in', '(DONE,PARTIAL,REJECTED,CANCELLED)');
}

function clinicDueDateFromArgs(args = {}) {
  const raw = String(args.due_date || args.dueDate || args.due_ymd || args.dueYmd || args.yyyymmdd || args.ymd || kstYmd(new Date())).replace(/[^0-9]/g, '');
  if (raw.length !== 8) return { ymd: kstYmd(new Date()), due_date: `${kstYmd(new Date()).slice(0,4)}-${kstYmd(new Date()).slice(4,6)}-${kstYmd(new Date()).slice(6,8)}` };
  return { ymd: raw, due_date: `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}` };
}

function clinicGroupKey(row = {}) {
  const taskType = normalizeClinicTaskType(row.task_type || 'INDIVIDUAL_CLINIC');
  const sourceId = String(row.source_id || '').trim();
  const classId = String(row.class_id || '').trim();
  const dueDate = String(row.due_date || '').trim();
  const title = String(row.title || '').trim();
  return [taskType, sourceId || '-', classId || '-', dueDate || '-', title || '-'].join('|');
}

function buildClinicBoardGroups(rows = [], studentNameMap = {}, classNameMap = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = clinicGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        group_key: key,
        task_type: normalizeClinicTaskType(row.task_type || ''),
        source_id: String(row.source_id || '').trim(),
        class_id: String(row.class_id || '').trim(),
        class_name: classNameMap[String(row.class_id || '').trim()] || '',
        title: String(row.title || '').trim(),
        due_date: String(row.due_date || '').trim(),
        due_time: String(row.due_time || '').trim(),
        clinic_mode: String(row.clinic_mode || '').trim(),
        priority: String(row.priority || '').trim(),
        total_count: 0,
        open_count: 0,
        candidate_count: 0,
        pending_count: 0,
        in_progress_count: 0,
        done_count: 0,
        partial_count: 0,
        closed_count: 0,
        first_task_id: '',
        student_ids: [],
        sample_students: []
      });
    }
    const group = groups.get(key);
    const status = normalizeClinicStatus(row.status || 'PENDING');
    const sid = normalizeStudentId(row.student_id || '');
    group.total_count += 1;
    if (!group.first_task_id) group.first_task_id = String(row.clinic_task_id || '').trim();
    if (sid) group.student_ids.push(sid);
    if (sid && group.sample_students.length < 5) {
      group.sample_students.push({ student_id: sid, student_name: studentNameMap[sid] || '' });
    }
    if (status === 'CANDIDATE') group.candidate_count += 1;
    if (status === 'PENDING') group.pending_count += 1;
    if (status === 'IN_PROGRESS') group.in_progress_count += 1;
    if (status === 'DONE') group.done_count += 1;
    if (status === 'PARTIAL') group.partial_count += 1;
    if (terminalClinicStatus(status)) group.closed_count += 1;
    else group.open_count += 1;
  }
  return Array.from(groups.values()).sort((a, b) => {
    const typeOrder = { CLASS_CLINIC: 0, INDIVIDUAL_CLINIC: 1, EXTRA_CLINIC: 2 };
    const ad = String(a.due_date || '9999-12-31');
    const bd = String(b.due_date || '9999-12-31');
    if (ad !== bd) return ad.localeCompare(bd);
    if ((typeOrder[a.task_type] ?? 9) !== (typeOrder[b.task_type] ?? 9)) return (typeOrder[a.task_type] ?? 9) - (typeOrder[b.task_type] ?? 9);
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

async function clinicTodayBoardDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const { ymd, due_date: dueDate } = clinicDueDateFromArgs(args);
  const openOnly = normalizeBool(args.open_only ?? args.openOnly, true);
  const limit = Math.max(1, Math.min(1000, toPositiveInt(args.limit, 500)));

  let q = supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, source_id, status, priority, due_date, due_time, due_at, clinic_mode, auto_notice_enabled, updated_at, created_at')
    .eq('due_date', dueDate)
    .order('task_type', { ascending: true })
    .order('class_id', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (openOnly) q = clinicOpenStatusFilter(q);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || '오늘 클리닉 업무판 조회 실패');

  const rows = Array.isArray(data) ? data : [];
  const studentNameMap = await readStudentNameMap(supabase, rows.map(row => row?.student_id).filter(Boolean));
  const classNameMap = await readClassNameMap(supabase, rows.map(row => row?.class_id).filter(Boolean));
  const groups = buildClinicBoardGroups(rows, studentNameMap, classNameMap);
  const items = rows.slice(0, 120).map(row => mapClinicTaskRow(row, studentNameMap, classNameMap));
  const summary = groups.reduce((acc, group) => {
    acc.total_count += group.total_count;
    acc.open_count += group.open_count;
    acc.class_count += group.task_type === 'CLASS_CLINIC' ? group.open_count : 0;
    acc.individual_count += group.task_type === 'INDIVIDUAL_CLINIC' ? group.open_count : 0;
    acc.extra_count += group.task_type === 'EXTRA_CLINIC' ? group.open_count : 0;
    acc.group_count += 1;
    return acc;
  }, { total_count: 0, open_count: 0, class_count: 0, individual_count: 0, extra_count: 0, group_count: 0 });

  return success({ yyyymmdd: ymd, due_date: dueDate, summary, groups, items });
}

async function clinicBulkUpdateStatusDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const nextStatus = normalizeClinicStatus(args.status, '');
  if (!nextStatus) return fail(400, 'INVALID_INPUT', '변경할 status가 필요합니다.');

  const rawIds = Array.isArray(args.clinic_task_ids) ? args.clinic_task_ids : Array.isArray(args.clinicTaskIds) ? args.clinicTaskIds : [];
  const taskIds = Array.from(new Set(rawIds.map(x => String(x || '').trim()).filter(Boolean))).slice(0, 500);
  const sourceId = normalizeLimitedText(args.source_id || args.sourceId, 120);
  const classId = normalizeLimitedText(args.class_id || args.classId, 80);
  const title = normalizeLimitedText(args.title, 160);
  const taskType = normalizeClinicTaskType(args.task_type || args.taskType || '', '');
  const { due_date: dueDate } = clinicDueDateFromArgs(args);
  const openOnly = normalizeBool(args.open_only ?? args.openOnly, true);

  if (!taskIds.length && !sourceId) {
    return fail(400, 'INVALID_INPUT', '일괄 변경은 clinic_task_ids 또는 source_id가 필요합니다.');
  }

  let selectQ = supabase
    .from('clinic_tasks')
    .select('*')
    .limit(500);
  if (taskIds.length) selectQ = selectQ.in('clinic_task_id', taskIds);
  if (sourceId) selectQ = selectQ.eq('source_id', sourceId);
  if (classId) selectQ = selectQ.eq('class_id', classId);
  if (taskType) selectQ = selectQ.eq('task_type', taskType);
  if (dueDate) selectQ = selectQ.eq('due_date', dueDate);
  if (title) selectQ = selectQ.eq('title', title);
  if (openOnly) selectQ = clinicOpenStatusFilter(selectQ);

  const { data: beforeRows, error: beforeErr } = await selectQ;
  if (beforeErr) return fail(500, 'DB_SELECT_FAILED', beforeErr.message || '일괄 변경 대상 조회 실패');
  const before = Array.isArray(beforeRows) ? beforeRows : [];
  if (!before.length) return success({ count: 0, items: [], message: '변경 대상이 없습니다.' });

  const ids = before.map(row => String(row.clinic_task_id || '').trim()).filter(Boolean);
  const patch = {
    status: nextStatus,
    updated_by: auth.me.staff_id,
    updated_at: nowIso(),
    completed_at: terminalClinicStatus(nextStatus) ? nowIso() : null
  };
  if ('internal_note' in args || 'internalNote' in args) patch.internal_note = normalizeLimitedText(args.internal_note || args.internalNote, 2000);
  if ('parent_note' in args || 'parentNote' in args) patch.parent_note = normalizeLimitedText(args.parent_note || args.parentNote, 1000);
  if ('parent_visible' in args || 'parentVisible' in args) patch.parent_visible = normalizeBool(args.parent_visible ?? args.parentVisible, false);

  const { data: afterRows, error } = await supabase
    .from('clinic_tasks')
    .update(patch)
    .in('clinic_task_id', ids)
    .select('*');
  if (error) return fail(500, 'DB_UPDATE_FAILED', error.message || '클리닉 일괄 상태 변경 실패');

  const logRows = before.map(row => ({
    clinic_log_id: randomUUID(),
    clinic_task_id: row.clinic_task_id,
    event_type: 'BULK_STATUS_CHANGE',
    before_status: row.status || '',
    after_status: nextStatus,
    internal_note: patch.internal_note ?? row.internal_note ?? '',
    parent_note: patch.parent_note ?? row.parent_note ?? '',
    parent_visible: patch.parent_visible ?? row.parent_visible === true,
    actor_staff_id: auth.me.staff_id,
    actor_role: auth.me.role,
    actor_name: auth.me.name || '',
    created_at: nowIso()
  }));
  if (logRows.length) {
    await supabase.from('clinic_logs').insert(logRows);
  }

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'clinic.bulkUpdateStatus',
    target_type: sourceId ? 'clinic_group' : 'clinic_tasks',
    target_id: sourceId || ids.slice(0, 5).join(','),
    action: 'BULK_STATUS_CHANGE',
    before_json: { count: before.length, status_from: Array.from(new Set(before.map(row => row.status || ''))) },
    after_json: { count: before.length, status: nextStatus },
    meta_json: { source_id: sourceId, class_id: classId, task_type: taskType, due_date: dueDate, title, open_only: openOnly }
  });

  const items = await hydrateClinicTasks(supabase, afterRows || []);
  return success({ count: items.length, items, audit_warning: audit.ok ? '' : audit.error || '' });
}


function normalizeClinicNoticeAction(raw) {
  const s = String(raw || '').trim().toUpperCase();
  const aliases = {
    CLINIC: 'CLINIC_RESERVATION_PARENT',
    CLINIC_NOTICE: 'CLINIC_RESERVATION_PARENT',
    CLINIC_RESERVATION: 'CLINIC_RESERVATION_PARENT',
    CLINIC_RESERVATION_PARENTS: 'CLINIC_RESERVATION_PARENT',
    CLINIC_RESERVATION_FOR_PARENTS: 'CLINIC_RESERVATION_PARENT',
    CLINIC_RESERVATION_STUDENTS: 'CLINIC_RESERVATION_STUDENT',
    CLINIC_RESERVATION_FOR_STUDENTS: 'CLINIC_RESERVATION_STUDENT',
    CLINIC_REMINDER: 'CLINIC_REMINDER_PARENT',
    CLINIC_REMINDER_PARENTS: 'CLINIC_REMINDER_PARENT',
    CLINIC_REMINDER_STUDENTS: 'CLINIC_REMINDER_STUDENT',
    CLINIC_MISSING: 'CLINIC_MISSING_PARENT',
    CLINIC_MISSING_PARENTS: 'CLINIC_MISSING_PARENT',
    CLINIC_MISSING_STUDENTS: 'CLINIC_MISSING_STUDENT',
    CLINIC_ABSENCE: 'CLINIC_ABSENCE_PARENT',
    CLINIC_OFFLINE_ABSENCE: 'CLINIC_ABSENCE_PARENT'
  };
  const normalized = aliases[s] || s || 'CLINIC_RESERVATION_PARENT';
  return [
    'CLINIC_RESERVATION_PARENT',
    'CLINIC_RESERVATION_STUDENT',
    'CLINIC_REMINDER_PARENT',
    'CLINIC_REMINDER_STUDENT',
    'CLINIC_MISSING_PARENT',
    'CLINIC_MISSING_STUDENT',
    'CLINIC_ABSENCE_PARENT'
  ].includes(normalized) ? normalized : 'CLINIC_RESERVATION_PARENT';
}

function clinicNoticeAudience(actionType) {
  return normalizeClinicNoticeAction(actionType).endsWith('_STUDENT') ? 'STUDENT' : 'PARENT';
}

function clinicNoticeAuditOp(actionType) {
  const action = normalizeClinicNoticeAction(actionType);
  if (action === 'CLINIC_RESERVATION_PARENT') return 'clinic.queueReservationParent';
  if (action === 'CLINIC_RESERVATION_STUDENT') return 'clinic.queueReservationStudent';
  if (action === 'CLINIC_REMINDER_PARENT') return 'clinic.queueReminderParent';
  if (action === 'CLINIC_REMINDER_STUDENT') return 'clinic.queueReminderStudent';
  if (action === 'CLINIC_MISSING_PARENT') return 'clinic.queueMissingParent';
  if (action === 'CLINIC_MISSING_STUDENT') return 'clinic.queueMissingStudent';
  if (action === 'CLINIC_ABSENCE_PARENT') return 'clinic.queueAbsenceParent';
  return 'clinic.queueParentNotice';
}

function clinicNoticeLabel(actionType) {
  const action = normalizeClinicNoticeAction(actionType);
  if (action === 'CLINIC_RESERVATION_PARENT') return '학부모 예약 안내';
  if (action === 'CLINIC_RESERVATION_STUDENT') return '학생 예약 안내';
  if (action === 'CLINIC_REMINDER_PARENT') return '학부모 오전 리마인드';
  if (action === 'CLINIC_REMINDER_STUDENT') return '학생 오전 리마인드';
  if (action === 'CLINIC_MISSING_PARENT') return '학부모 미제출 안내';
  if (action === 'CLINIC_MISSING_STUDENT') return '학생 미제출 안내';
  if (action === 'CLINIC_ABSENCE_PARENT') return '학부모 미등원 안내';
  return '클리닉 안내';
}

function kstDateTimeFromYmdHhmm(ymdLike, hhmmRaw) {
  const hhmm = String(hhmmRaw || '').trim();
  if (!hhmm) return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';
  const raw = String(ymdLike || '').replace(/[^0-9]/g, '');
  let ymd = raw.length === 8 ? raw : kstYmd(new Date());
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;
}

function normalizeClinicMode(raw, fallback = 'OFFLINE') {
  const value = String(raw || '').trim().toUpperCase();
  if (['OFFLINE', 'ONLINE'].includes(value)) return value;
  if (['등원', '오프라인', '현장'].includes(String(raw || '').trim())) return 'OFFLINE';
  if (['온라인', '과제', '제출'].includes(String(raw || '').trim())) return 'ONLINE';
  return fallback;
}

function normalizeHhmm(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function addMinutesToIso(iso, minutes) {
  const ms = Date.parse(String(iso || '').trim());
  const n = Number(minutes);
  if (!Number.isFinite(ms) || !Number.isFinite(n)) return '';
  return new Date(ms + n * 60 * 1000).toISOString();
}

function clinicMorningReminderIso(dueDate) {
  const raw = String(dueDate || '').replace(/[^0-9]/g, '');
  if (raw.length !== 8) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T08:00:00+09:00`;
}

function normalizeClinicNotifyAction(raw) {
  return normalizeClinicNoticeAction(raw);
}

async function clinicQueueNoticeDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const clinicTaskId = String(args.clinic_task_id || args.clinicTaskId || '').trim();
  if (!clinicTaskId) return fail(400, 'INVALID_INPUT', 'clinic_task_id가 필요합니다.');

  const actionType = normalizeClinicNoticeAction(args.notice_type || args.noticeType || args.action_type || args.actionType);
  const audience = clinicNoticeAudience(actionType);

  const supabase = getSupabaseAdmin();
  const { data: task, error: taskErr } = await supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, title, task_type, source_type, status, parent_note, parent_visible, due_date, due_time, due_at, clinic_mode')
    .eq('clinic_task_id', clinicTaskId)
    .maybeSingle();
  if (taskErr) return fail(500, 'DB_SELECT_FAILED', taskErr.message || 'clinic_tasks 조회 실패');
  if (!task) return fail(404, 'NOT_FOUND', '클리닉을 찾지 못했습니다.');

  const sid = normalizeStudentId(task.student_id);
  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, student_phone, parent_phone')
    .eq('student_id', sid)
    .maybeSingle();
  if (studentErr) return fail(500, 'DB_SELECT_FAILED', studentErr.message || 'students 조회 실패');
  if (!student) return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');

  const parentPhone = String(student.parent_phone || '').replace(/[^0-9]/g, '').trim();
  const studentPhone = String(student.student_phone || '').replace(/[^0-9]/g, '').trim();
  const directTargetPhone = String(args.target_phone || args.targetPhone || args.to_phone || args.toPhone || args.student_phone || args.studentPhone || '').replace(/[^0-9]/g, '').trim();
  const targetPhone = audience === 'STUDENT' ? (directTargetPhone || studentPhone) : (directTargetPhone || parentPhone);
  if (!targetPhone) {
    return fail(
      400,
      audience === 'STUDENT' ? 'NO_STUDENT_PHONE' : 'NO_PARENT_PHONE',
      audience === 'STUDENT'
        ? '학생 휴대폰 번호가 없어 알림을 예약할 수 없습니다. 중앙DB 학생전화 동기화 상태를 확인하세요.'
        : '학부모 전화번호가 없어 문자를 예약할 수 없습니다.'
    );
  }

  const clinicAt = String(args.clinic_at || args.clinicAt || '').trim();
  const clinicTimeHhmm = String(args.clinic_time_hhmm || args.clinicTimeHhmm || args.clinic_time || args.clinicTime || '').trim();
  const occurredAt = clinicAt || kstDateTimeFromYmdHhmm(task.due_date || '', clinicTimeHhmm) || null;

  const { data: existing, error: existingErr } = await supabase
    .from('attendance_notify_queue')
    .select('queue_id, status, attempts, last_error, created_at, processed_at')
    .eq('trace_id', clinicTaskId)
    .eq('action_type', actionType)
    .maybeSingle();
  if (existingErr) return fail(500, 'DB_SELECT_FAILED', existingErr.message || '문자 queue 중복 조회 실패');
  if (existing) {
    return success({
      queued: true,
      duplicate: true,
      queue_id: existing.queue_id,
      status: existing.status,
      action_type: actionType,
      notice_label: clinicNoticeLabel(actionType),
      message: '이미 예약된 클리닉 알림이 있습니다.'
    });
  }

  const row = {
    queue_id: randomUUID(),
    trace_id: clinicTaskId,
    student_id: sid,
    action_type: actionType,
    parent_phone: targetPhone,
    school: String(student.school || '').trim(),
    grade: String(student.grade || '').trim(),
    student_name: String(student.student_name || '').trim(),
    occurred_at: occurredAt,
    status: 'PENDING',
    attempts: 0,
    sent_channel: '',
    last_error: '',
    processed_at: null
  };

  const { data, error } = await supabase
    .from('attendance_notify_queue')
    .insert(row)
    .select('queue_id, status, action_type, created_at')
    .single();
  if (error) return fail(500, 'DB_INSERT_FAILED', error.message || '클리닉 알림 queue 생성 실패');

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: clinicNoticeAuditOp(actionType),
    target_type: 'clinic_task',
    target_id: clinicTaskId,
    action: 'QUEUE_MESSAGE',
    after_json: { queue_id: row.queue_id, action_type: actionType, student_id: sid, audience, occurred_at: occurredAt },
    meta_json: {
      title: task.title || '',
      task_type: task.task_type || '',
      source_type: task.source_type || '',
      parent_visible: task.parent_visible === true,
      notice_label: clinicNoticeLabel(actionType)
    }
  });

  return success({
    queued: true,
    duplicate: false,
    queue_id: data?.queue_id || row.queue_id,
    status: data?.status || 'PENDING',
    action_type: actionType,
    notice_label: clinicNoticeLabel(actionType),
    audience,
    message: `${clinicNoticeLabel(actionType)}를 예약했습니다.`,
    audit_warning: audit.ok ? '' : audit.error || ''
  });
}

async function clinicQueueParentNoticeDirect(args = {}, sessionToken = '') {
  return await clinicQueueNoticeDirect({ ...args, notice_type: args.notice_type || args.noticeType || 'CLINIC_RESERVATION_PARENT' }, sessionToken);
}



function isMissingWordCatalogTableError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || error?.hint || '').toLowerCase();
  return code === '42P01'
    || code === 'PGRST205'
    || message.includes('word_books')
    || message.includes('word_book_ranges')
    || message.includes('does not exist')
    || message.includes('schema cache');
}

function normalizeCatalogStatus(raw) {
  const value = String(raw || '').trim().toUpperCase();
  return value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
}

function mapWordRangeRow(row = {}) {
  const wordCount = Number(row.word_count ?? row.total_count ?? row.max_score ?? 0);
  return {
    range_id: String(row.range_id || '').trim(),
    academy_id: String(row.academy_id || '').trim(),
    book_id: String(row.book_id || '').trim(),
    range_key: String(row.range_key || '').trim(),
    range_label: String(row.range_label || row.title || '').trim(),
    start_index: row.start_index == null ? null : Number(row.start_index),
    end_index: row.end_index == null ? null : Number(row.end_index),
    word_count: Number.isFinite(wordCount) ? wordCount : 0,
    pass_count: Number.isFinite(wordCount) && wordCount > 0 ? Math.ceil(wordCount * 0.9) : 0,
    status: normalizeCatalogStatus(row.status),
    sort_order: Number(row.sort_order || 0) || 0,
    memo: String(row.memo || '').trim(),
    source: String(row.source || '').trim()
  };
}

function mapWordBookRow(row = {}, rangesByBook = new Map()) {
  const bookId = String(row.book_id || '').trim();
  const ranges = rangesByBook.get(bookId) || [];
  return {
    book_id: bookId,
    academy_id: String(row.academy_id || '').trim(),
    book_key: String(row.book_key || '').trim(),
    book_title: String(row.book_title || row.title || '').trim(),
    title: String(row.book_title || row.title || '').trim(),
    publisher: String(row.publisher || '').trim(),
    level: String(row.level || '').trim(),
    status: normalizeCatalogStatus(row.status),
    sort_order: Number(row.sort_order || 0) || 0,
    range_count: ranges.length,
    word_count: ranges.reduce((sum, item) => sum + (Number(item.word_count || 0) || 0), 0),
    ranges
  };
}

async function wordCatalogListDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const bookId = String(args.book_id || args.bookId || '').trim();
  const includeInactive = normalizeBool(args.include_inactive ?? args.includeInactive, false);
  const limitBooks = Math.max(1, Math.min(500, toPositiveInt(args.limit_books || args.limitBooks, 200)));
  const limitRanges = Math.max(1, Math.min(3000, toPositiveInt(args.limit_ranges || args.limitRanges, 1500)));

  let bookQ = supabase
    .from('word_books')
    .select('book_id, academy_id, book_key, book_title, publisher, level, status, sort_order, source, memo, created_at, updated_at')
    .order('sort_order', { ascending: true })
    .order('book_title', { ascending: true })
    .limit(limitBooks);
  if (bookId) bookQ = bookQ.eq('book_id', bookId);
  if (!includeInactive) bookQ = bookQ.eq('status', 'ACTIVE');

  const { data: bookRows, error: bookErr } = await bookQ;
  if (bookErr) {
    if (isMissingWordCatalogTableError(bookErr)) return success(listSeedWordCatalog());
    return fail(500, 'DB_SELECT_FAILED', bookErr.message || 'word_books 조회 실패');
  }

  const booksRaw = Array.isArray(bookRows) ? bookRows : [];
  if (!booksRaw.length) {
    return success({
      source: 'SUPABASE',
      seed_fallback: false,
      catalog_version: 'word-catalog-foundation-v1',
      count_books: 0,
      count_ranges: 0,
      books: [],
      ranges: [],
      filter: { book_id: bookId, include_inactive: includeInactive },
      warnings: ['word_books 테이블은 있으나 조회된 단어책이 없습니다. catalog seed 적용이 필요합니다.']
    });
  }

  const bookIds = booksRaw.map(row => String(row.book_id || '').trim()).filter(Boolean);
  let rangeQ = supabase
    .from('word_book_ranges')
    .select('range_id, academy_id, book_id, range_key, range_label, start_index, end_index, word_count, status, sort_order, source, memo, created_at, updated_at')
    .in('book_id', bookIds)
    .order('book_id', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('range_label', { ascending: true })
    .limit(limitRanges);
  if (!includeInactive) rangeQ = rangeQ.eq('status', 'ACTIVE');

  const { data: rangeRows, error: rangeErr } = await rangeQ;
  if (rangeErr) {
    if (isMissingWordCatalogTableError(rangeErr)) return success(listSeedWordCatalog());
    return fail(500, 'DB_SELECT_FAILED', rangeErr.message || 'word_book_ranges 조회 실패');
  }

  const ranges = (Array.isArray(rangeRows) ? rangeRows : []).map(mapWordRangeRow);
  const rangesByBook = ranges.reduce((map, row) => {
    const key = String(row.book_id || '').trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
    return map;
  }, new Map());
  const books = booksRaw.map(row => mapWordBookRow(row, rangesByBook));

  return success({
    source: 'SUPABASE',
    seed_fallback: false,
    catalog_version: 'word-catalog-foundation-v1',
    count_books: books.length,
    count_ranges: ranges.length,
    books,
    ranges,
    filter: { book_id: bookId, include_inactive: includeInactive },
    warnings: ranges.length ? [] : ['단어책은 있으나 연결된 범위가 없습니다. word_book_ranges seed 적용이 필요합니다.']
  });
}

async function wordTestListSessionsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const startYmd = String(args.start_ymd || args.startYmd || args.period_start || args.periodStart || '').trim();
  const endYmd = String(args.end_ymd || args.endYmd || args.period_end || args.periodEnd || '').trim();
  const classId = String(args.class_id || args.classId || '').trim();
  const limit = Math.max(1, Math.min(200, toPositiveInt(args.limit, 80)));

  if (yyyymmdd && !isStrictYmd(yyyymmdd)) return fail(400, 'INVALID_INPUT', 'yyyymmdd는 YYYYMMDD 형식이어야 합니다.');
  if (startYmd && !isStrictYmd(startYmd)) return fail(400, 'INVALID_INPUT', '조회 시작일은 YYYYMMDD 형식이어야 합니다.');
  if (endYmd && !isStrictYmd(endYmd)) return fail(400, 'INVALID_INPUT', '조회 종료일은 YYYYMMDD 형식이어야 합니다.');
  if (startYmd && endYmd && startYmd > endYmd) return fail(400, 'INVALID_INPUT', '조회 시작일은 종료일보다 늦을 수 없습니다.');

  let q = supabase
    .from('word_test_sessions')
    .select('session_id, title, yyyymmdd, class_id, scope_text, pass_score, max_score, created_by, created_at, updated_at')
    .order('yyyymmdd', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (yyyymmdd) q = q.eq('yyyymmdd', yyyymmdd);
  else {
    if (startYmd) q = q.gte('yyyymmdd', startYmd);
    if (endYmd) q = q.lte('yyyymmdd', endYmd);
  }
  if (classId) q = q.eq('class_id', classId);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'word_test_sessions 조회 실패');

  const items = (Array.isArray(data) ? data : []).map(mapWordSessionRow);
  return success({ count: items.length, items, filter: { yyyymmdd, start_ymd: startYmd, end_ymd: endYmd, class_id: classId, limit } });
}

async function wordTestCreateSessionDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const title = normalizeLimitedText(args.title, 160);
  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  const maxScore = normalizeWordTotal(args.total_count ?? args.totalCount ?? args.max_score ?? args.maxScore, 100);
  const passScore = normalizeWordPassCount(args.pass_count ?? args.passCount ?? args.pass_score ?? args.passScore, maxScore, Math.ceil(maxScore * 0.9));
  if (!title) return fail(400, 'INVALID_INPUT', '시험 제목이 필요합니다.');
  if (!isStrictYmd(yyyymmdd)) return fail(400, 'INVALID_INPUT', 'yyyymmdd는 8자리 숫자여야 합니다.');
  if (!(Number.isFinite(passScore) && Number.isFinite(maxScore) && passScore >= 0 && maxScore > 0 && passScore <= maxScore)) {
    return fail(400, 'INVALID_INPUT', '통과 개수와 전체 개수가 올바르지 않습니다.');
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



async function resolveWordFailClinicIfNeeded(supabase, auth, clinicTaskId, resultStatus, meta = {}) {
  const taskId = String(clinicTaskId || '').trim();
  const status = String(resultStatus || '').trim().toUpperCase();
  if (!taskId || !['PASS', 'EXEMPT'].includes(status)) return { ok: true, resolved: false };
  try {
    const { data: before, error: beforeErr } = await supabase
      .from('clinic_tasks')
      .select('*')
      .eq('clinic_task_id', taskId)
      .maybeSingle();
    if (beforeErr) return { ok: false, resolved: false, error: beforeErr.message || 'clinic_tasks 조회 실패' };
    if (!before) return { ok: true, resolved: false };
    const beforeStatus = normalizeClinicStatus(before.status, '');
    const sourceType = normalizeClinicSourceType(before.source_type, '');
    if (sourceType !== 'WORD_FAIL' || !['CANDIDATE', 'PENDING', 'IN_PROGRESS'].includes(beforeStatus)) {
      return { ok: true, resolved: false };
    }
    const patch = {
      status: 'DONE',
      updated_by: auth.me.staff_id,
      updated_at: nowIso(),
      completed_at: nowIso(),
      internal_note: normalizeLimitedText(`${before.internal_note || ''}\n단어시험 결과가 ${status === 'PASS' ? '통과' : '면제'}로 변경되어 자동 완료 처리되었습니다.`.trim(), 2000)
    };
    const { data: after, error } = await supabase
      .from('clinic_tasks')
      .update(patch)
      .eq('clinic_task_id', taskId)
      .select('*')
      .single();
    if (error) return { ok: false, resolved: false, error: error.message || 'WORD_FAIL 클리닉 자동 완료 실패' };
    await appendClinicLogDirect(supabase, auth, {
      clinic_task_id: taskId,
      event_type: 'AUTO_RESOLVED',
      before_status: beforeStatus,
      after_status: 'DONE',
      internal_note: patch.internal_note,
      parent_note: before.parent_note || '',
      parent_visible: before.parent_visible === true
    });
    await appendPortalAuditLogDirect(supabase, auth, {
      op: 'clinic.autoResolveWordFail',
      target_type: 'clinic_task',
      target_id: taskId,
      action: 'AUTO_RESOLVE',
      before_json: before,
      after_json: after || { ...before, ...patch },
      meta_json: meta
    });
    return { ok: true, resolved: true, item: after || { ...before, ...patch } };
  } catch (e) {
    return { ok: false, resolved: false, error: e?.message || 'WORD_FAIL 클리닉 자동 완료 실패' };
  }
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

  const maxScore = normalizeWordTotal(args.total_count ?? args.totalCount ?? args.max_score ?? args.maxScore, Number(session.max_score || 100));
  const passScore = normalizeWordPassCount(args.pass_count ?? args.passCount ?? args.pass_score ?? args.passScore, maxScore, Number(session.pass_score || Math.ceil(maxScore * 0.9)));
  const score = normalizeWordCount(args.correct_count ?? args.correctCount ?? args.score, null);
  const resultStatus = normalizeWordResultStatus(args.result_status || args.resultStatus, score, passScore);
  if ((resultStatus === 'PASS' || resultStatus === 'FAIL') && score === null) {
    return fail(400, 'INVALID_INPUT', '통과/불통과 결과에는 맞은 개수가 필요합니다.');
  }
  if (score !== null && score > maxScore) {
    return fail(400, 'INVALID_INPUT', '맞은 개수는 전체 개수보다 클 수 없습니다.');
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
      title: `단어 재시험 클리닉: ${session.title}`.slice(0, 160),
      task_type: 'EXTRA_CLINIC',
      source_type: 'WORD_FAIL',
      source_id: resultId,
      status: 'CANDIDATE',
      priority: Number(score) < passScore - 20 ? 'HIGH' : 'NORMAL',
      due_date: null,
      assigned_staff_id: null,
      internal_note: `맞은 개수 ${score}/${maxScore}, 통과 기준 ${passScore}. ${normalizeLimitedText(args.note, 700)}`.trim(),
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

  const wordRecordMirror = await upsertWordRecordMirrorsIfAvailable(supabase, auth, [saved || row], session, 'wordTest.enterResult');

  const resolvedClinic = await resolveWordFailClinicIfNeeded(supabase, auth, row.clinic_task_id, resultStatus, {
    session_id: sessionId,
    student_id: sid,
    result_id: resultId,
    result_status: resultStatus
  });

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'wordTest.enterResult',
    target_type: 'word_test_result',
    target_id: resultId,
    action: existing ? 'UPDATE' : 'CREATE',
    before_json: existing || {},
    after_json: saved || row,
    meta_json: { clinic_task_id: row.clinic_task_id || '', result_status: resultStatus, word_record_mirror: wordRecordMirror }
  });

  const item = mapWordResultRow(saved || row, { [sessionId]: session }, {});
  return success({
    item,
    clinic_task: clinicTask,
    created_clinic: !!clinicTask,
    resolved_clinic: resolvedClinic.resolved === true,
    word_record_mirrored: wordRecordMirror.ok === true && wordRecordMirror.skipped !== true,
    word_record_mirror_count: wordRecordMirror.mirrored_count || 0,
    word_record_warning: wordRecordMirror.ok ? wordRecordMirror.warning || '' : wordRecordMirror.warning || 'word_records mirror 저장 실패',
    resolve_warning: resolvedClinic.ok ? '' : resolvedClinic.error || '',
    audit_warning: audit.ok ? '' : audit.error || ''
  });
}

async function wordTestBulkEntryDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sessionId = String(args.session_id || args.sessionId || '').trim();
  const classIdArg = normalizeLimitedText(args.class_id || args.classId, 80);
  if (!sessionId) return fail(400, 'INVALID_INPUT', 'session_id가 필요합니다.');

  const supabase = getSupabaseAdmin();
  const { data: session, error: sessionErr } = await supabase
    .from('word_test_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (sessionErr) return fail(500, 'DB_SELECT_FAILED', sessionErr.message || 'word_test_sessions 조회 실패');
  if (!session) return fail(404, 'NOT_FOUND', '단어시험 회차를 찾지 못했습니다.');

  const classId = classIdArg || String(session.class_id || '').trim();
  if (!classId) return fail(400, 'INVALID_INPUT', '일괄 입력에는 class_id가 필요합니다.');

  const { data: relRows, error: relErr } = await supabase
    .from('class_students')
    .select('student_id')
    .eq('class_id', classId)
    .limit(500);

  if (relErr) return fail(500, 'DB_SELECT_FAILED', relErr.message || 'class_students 조회 실패');

  const studentIds = Array.from(new Set((Array.isArray(relRows) ? relRows : [])
    .map(row => normalizeStudentId(row?.student_id))
    .filter(Boolean)));

  if (!studentIds.length) {
    return success({ session: mapWordSessionRow(session), class_id: classId, count: 0, items: [] });
  }

  const studentNameMap = await readStudentNameMap(supabase, studentIds);
  const { data: existingRows, error: existingErr } = await supabase
    .from('word_test_results')
    .select('result_id, session_id, student_id, score, max_score, pass_score, result_status, clinic_task_id, note, created_at, updated_at')
    .eq('session_id', sessionId)
    .in('student_id', studentIds);

  if (existingErr) return fail(500, 'DB_SELECT_FAILED', existingErr.message || 'word_test_results 조회 실패');

  const existingBySid = new Map();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    existingBySid.set(normalizeStudentId(row?.student_id), row);
  }

  const sessionMap = { [sessionId]: session };
  const items = studentIds.map(sid => {
    const existing = existingBySid.get(sid) || {};
    return {
      student_id: sid,
      student_name: studentNameMap[sid] || '',
      result_id: String(existing.result_id || '').trim(),
      score: existing.score == null ? null : Number(existing.score),
      max_score: Number(existing.max_score ?? session.max_score ?? 100),
      pass_score: Number(existing.pass_score ?? session.pass_score ?? 90),
      result_status: String(existing.result_status || '').trim(),
      clinic_task_id: String(existing.clinic_task_id || '').trim(),
      note: String(existing.note || '').trim(),
      updated_at: String(existing.updated_at || '')
    };
  });

  return success({ session: mapWordSessionRow(session), class_id: classId, count: items.length, items });
}

async function wordTestBulkEnterResultsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sessionId = String(args.session_id || args.sessionId || '').trim();
  const inputRows = Array.isArray(args.results) ? args.results : [];
  if (!sessionId) return fail(400, 'INVALID_INPUT', 'session_id가 필요합니다.');
  if (!inputRows.length) return fail(400, 'INVALID_INPUT', '저장할 결과가 없습니다.');

  const supabase = getSupabaseAdmin();
  const { data: session, error: sessionErr } = await supabase
    .from('word_test_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (sessionErr) return fail(500, 'DB_SELECT_FAILED', sessionErr.message || 'word_test_sessions 조회 실패');
  if (!session) return fail(404, 'NOT_FOUND', '단어시험 회차를 찾지 못했습니다.');

  const maxScore = normalizeWordTotal(session.max_score, 100);
  const passScore = normalizeWordPassCount(session.pass_score, maxScore, Math.ceil(maxScore * 0.9));
  const normalized = [];
  const seen = new Set();

  for (const raw of inputRows) {
    const sid = normalizeStudentId(raw?.student_id || raw?.sid || '');
    if (!sid || seen.has(sid)) continue;
    const score = normalizeWordCount(raw?.correct_count ?? raw?.correctCount ?? raw?.score, null);
    const statusText = String(raw?.result_status || raw?.resultStatus || '').trim().toUpperCase();
    if (score === null && !statusText && !String(raw?.note || '').trim()) continue;
    const resultStatus = normalizeWordResultStatus(statusText, score, passScore);
    if ((resultStatus === 'PASS' || resultStatus === 'FAIL') && score === null) {
      return fail(400, 'INVALID_INPUT', `${sid} 학생의 통과/불통과 결과에는 맞은 개수가 필요합니다.`);
    }
    if (score !== null && score > maxScore) {
      return fail(400, 'INVALID_INPUT', `${sid} 학생의 맞은 개수는 전체 개수보다 클 수 없습니다.`);
    }
    normalized.push({
      student_id: sid,
      score,
      result_status: resultStatus,
      note: normalizeLimitedText(raw?.note, 1000),
      create_clinic: normalizeBool(raw?.create_clinic ?? raw?.createClinic, true)
    });
    seen.add(sid);
  }

  if (!normalized.length) return fail(400, 'INVALID_INPUT', '점수 또는 상태가 입력된 학생이 없습니다.');

  const studentIds = normalized.map(row => row.student_id);
  const { data: existingRows, error: existingErr } = await supabase
    .from('word_test_results')
    .select('*')
    .eq('session_id', sessionId)
    .in('student_id', studentIds);

  if (existingErr) return fail(500, 'DB_SELECT_FAILED', existingErr.message || 'word_test_results 기존 결과 조회 실패');

  const existingBySid = new Map();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    existingBySid.set(normalizeStudentId(row?.student_id), row);
  }

  const now = nowIso();
  const rowsToUpsert = [];
  const clinicRows = [];
  const beforeJson = {};

  for (const item of normalized) {
    const existing = existingBySid.get(item.student_id) || null;
    const resultId = existing?.result_id || randomUUID();
    beforeJson[item.student_id] = existing || {};
    const row = {
      result_id: resultId,
      session_id: sessionId,
      student_id: item.student_id,
      score: item.score,
      max_score: maxScore,
      pass_score: passScore,
      result_status: item.result_status,
      clinic_task_id: existing?.clinic_task_id || null,
      note: item.note,
      created_by: existing?.created_by || auth.me.staff_id,
      created_at: existing?.created_at || now,
      updated_by: auth.me.staff_id,
      updated_at: now
    };

    if (item.result_status === 'FAIL' && item.create_clinic && !row.clinic_task_id) {
      const clinicTaskId = randomUUID();
      row.clinic_task_id = clinicTaskId;
      clinicRows.push({
        clinic_task_id: clinicTaskId,
        student_id: item.student_id,
        class_id: String(session.class_id || '').trim() || null,
        title: `단어 재시험 클리닉: ${session.title}`.slice(0, 160),
        task_type: 'EXTRA_CLINIC',
        source_type: 'WORD_FAIL',
        source_id: resultId,
        status: 'CANDIDATE',
        priority: Number(item.score) < passScore - 20 ? 'HIGH' : 'NORMAL',
        due_date: null,
        assigned_staff_id: null,
        internal_note: `맞은 개수 ${item.score}/${maxScore}, 통과 기준 ${passScore}. ${item.note}`.trim(),
        parent_note: '',
        parent_visible: false,
        created_by: auth.me.staff_id,
        created_at: now,
        updated_by: auth.me.staff_id,
        updated_at: now,
        completed_at: null
      });
    }

    rowsToUpsert.push(row);
  }

  let clinicItems = [];
  if (clinicRows.length) {
    const { data: insertedClinics, error: clinicErr } = await supabase
      .from('clinic_tasks')
      .insert(clinicRows)
      .select('*');
    if (clinicErr) return fail(500, 'DB_INSERT_FAILED', clinicErr.message || '불통과 클리닉 후보 일괄 생성 실패');

    clinicItems = await hydrateClinicTasks(supabase, insertedClinics || clinicRows);

    for (const clinicRow of clinicRows) {
      await appendClinicLogDirect(supabase, auth, {
        clinic_task_id: clinicRow.clinic_task_id,
        event_type: 'AUTO_CREATED',
        after_status: 'CANDIDATE',
        internal_note: clinicRow.internal_note
      });
    }
  }

  const { data: savedRows, error: saveErr } = await supabase
    .from('word_test_results')
    .upsert(rowsToUpsert, { onConflict: 'session_id,student_id' })
    .select('*');

  if (saveErr) return fail(500, 'DB_UPSERT_FAILED', saveErr.message || 'word_test_results 일괄 저장 실패');

  const wordRecordMirror = await upsertWordRecordMirrorsIfAvailable(supabase, auth, savedRows || rowsToUpsert, session, 'wordTest.bulkEnterResults');

  const resolvedClinics = [];
  for (const item of normalized) {
    const existing = existingBySid.get(item.student_id) || null;
    if (existing?.clinic_task_id && ['PASS', 'EXEMPT'].includes(item.result_status)) {
      const resolved = await resolveWordFailClinicIfNeeded(supabase, auth, existing.clinic_task_id, item.result_status, {
        session_id: sessionId,
        student_id: item.student_id,
        result_status: item.result_status,
        bulk: true
      });
      if (resolved.resolved) resolvedClinics.push(resolved.item);
    }
  }

  const studentNameMap = await readStudentNameMap(supabase, studentIds);
  const sessionMap = { [sessionId]: session };
  const items = (Array.isArray(savedRows) ? savedRows : []).map(row => mapWordResultRow(row, sessionMap, studentNameMap));
  const passCount = items.filter(row => row.result_status === 'PASS').length;
  const failCount = items.filter(row => row.result_status === 'FAIL').length;
  const absentCount = items.filter(row => row.result_status === 'ABSENT').length;
  const exemptCount = items.filter(row => row.result_status === 'EXEMPT').length;

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'wordTest.bulkEnterResults',
    target_type: 'word_test_session',
    target_id: sessionId,
    action: 'BULK_UPSERT',
    before_json: beforeJson,
    after_json: { items },
    meta_json: { count: items.length, pass_count: passCount, fail_count: failCount, absent_count: absentCount, exempt_count: exemptCount, clinic_count: clinicItems.length, word_record_mirror: wordRecordMirror }
  });

  return success({
    count: items.length,
    pass_count: passCount,
    fail_count: failCount,
    absent_count: absentCount,
    exempt_count: exemptCount,
    created_clinic_count: clinicItems.length,
    resolved_clinic_count: resolvedClinics.length,
    word_record_mirror_count: wordRecordMirror.mirrored_count || 0,
    word_record_warning: wordRecordMirror.ok ? wordRecordMirror.warning || '' : wordRecordMirror.warning || 'word_records mirror 저장 실패',
    items,
    clinic_items: clinicItems,
    audit_warning: audit.ok ? '' : audit.error || ''
  });
}



async function wordTestListResultsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const sessionId = String(args.session_id || args.sessionId || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const status = String(args.result_status || args.resultStatus || '').trim().toUpperCase();
  const limit = Math.max(1, Math.min(500, toPositiveInt(args.limit, 200)));

  let q = supabase
    .from('word_test_results')
    .select('result_id, session_id, student_id, score, max_score, pass_score, result_status, clinic_task_id, note, created_by, created_at, updated_by, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (sessionId) q = q.eq('session_id', sessionId);
  if (sid) q = q.eq('student_id', sid);
  if (['PASS', 'FAIL', 'ABSENT', 'EXEMPT'].includes(status)) q = q.eq('result_status', status);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'word_test_results 조회 실패');

  const rows = Array.isArray(data) ? data : [];
  const sessionIds = Array.from(new Set(rows.map(row => String(row?.session_id || '').trim()).filter(Boolean)));
  const studentIds = Array.from(new Set(rows.map(row => normalizeStudentId(row?.student_id)).filter(Boolean)));
  let sessionMap = {};
  if (sessionIds.length) {
    const { data: sessions, error: sessionErr } = await supabase
      .from('word_test_sessions')
      .select('session_id, title, yyyymmdd, class_id, scope_text, pass_score, max_score')
      .in('session_id', sessionIds)
      .limit(500);
    if (sessionErr) return fail(500, 'DB_SELECT_FAILED', sessionErr.message || 'word_test_sessions 조회 실패');
    sessionMap = (Array.isArray(sessions) ? sessions : []).reduce((acc, row) => {
      const id = String(row?.session_id || '').trim();
      if (id) acc[id] = row;
      return acc;
    }, {});
  }
  const studentNameMap = await readStudentNameMap(supabase, studentIds);
  const items = rows.map(row => mapWordResultRow(row, sessionMap, studentNameMap));
  return success({
    count: items.length,
    pass_count: items.filter(row => row.result_status === 'PASS').length,
    fail_count: items.filter(row => row.result_status === 'FAIL').length,
    absent_count: items.filter(row => row.result_status === 'ABSENT').length,
    exempt_count: items.filter(row => row.result_status === 'EXEMPT').length,
    items
  });
}

async function buildStudentReportSummary(supabase, sid, periodStart, periodEnd) {
  const { data: student } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, status, teacher')
    .eq('student_id', sid)
    .maybeSingle();

  const studentOut = {
    student_id: sid,
    student_name: String(student?.student_name || '').trim(),
    school: String(student?.school || '').trim(),
    grade: String(student?.grade || '').trim(),
    status: String(student?.status || '').trim(),
    teacher: String(student?.teacher || '').trim()
  };

  const warnings = [];
  const { data: attendanceRows, error: attendanceErr } = await supabase
    .from('attendance_logs')
    .select('ts, yyyymmdd, action_type, result, deny_reason, trace_id')
    .eq('student_id', sid)
    .gte('yyyymmdd', periodStart)
    .lte('yyyymmdd', periodEnd)
    .order('ts', { ascending: false })
    .limit(200);

  if (attendanceErr) warnings.push({ area: 'attendance_logs', message: attendanceErr.message || '출결 로그 조회 실패' });

  const okLogs = (Array.isArray(attendanceRows) ? attendanceRows : []).filter(row => String(row?.result || '').toUpperCase() === 'OK');
  const checkInDays = Array.from(new Set(okLogs
    .filter(row => String(row?.action_type || '').toUpperCase().includes('CHECK_IN'))
    .map(row => String(row?.yyyymmdd || '').trim())
    .filter(Boolean)));
  const checkOutDays = Array.from(new Set(okLogs
    .filter(row => String(row?.action_type || '').toUpperCase().includes('CHECK_OUT'))
    .map(row => String(row?.yyyymmdd || '').trim())
    .filter(Boolean)));

  const { data: clinicRows, error: clinicErr } = await supabase
    .from('clinic_tasks')
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, status, priority, due_date, internal_note, parent_note, parent_visible, created_at, updated_at, completed_at')
    .eq('student_id', sid)
    .gte('updated_at', `${periodStart.slice(0,4)}-${periodStart.slice(4,6)}-${periodStart.slice(6,8)}T00:00:00+09:00`)
    .lte('updated_at', `${periodEnd.slice(0,4)}-${periodEnd.slice(4,6)}-${periodEnd.slice(6,8)}T23:59:59+09:00`)
    .order('updated_at', { ascending: false })
    .limit(80);

  if (clinicErr) warnings.push({ area: 'clinic_tasks', message: clinicErr.message || '클리닉 조회 실패' });
  const clinics = await hydrateClinicTasks(supabase, clinicRows || []);

  const { data: wordRows, error: wordErr } = await supabase
    .from('word_test_results')
    .select('result_id, session_id, student_id, score, max_score, pass_score, result_status, clinic_task_id, note, created_at, updated_at')
    .eq('student_id', sid)
    .order('updated_at', { ascending: false })
    .limit(60);

  if (wordErr) warnings.push({ area: 'word_test_results', message: wordErr.message || '단어시험 조회 실패' });

  const sessionIds = Array.from(new Set((Array.isArray(wordRows) ? wordRows : []).map(row => String(row?.session_id || '').trim()).filter(Boolean)));
  let sessionMap = {};
  if (sessionIds.length) {
    const { data: sessions, error: sessionErr } = await supabase
      .from('word_test_sessions')
      .select('session_id, title, yyyymmdd, class_id, scope_text, pass_score, max_score')
      .in('session_id', sessionIds)
      .limit(100);
    if (sessionErr) warnings.push({ area: 'word_test_sessions', message: sessionErr.message || '단어시험 회차 조회 실패' });
    else {
      sessionMap = (Array.isArray(sessions) ? sessions : []).reduce((acc, row) => {
        const sessionId = String(row?.session_id || '').trim();
        if (sessionId) acc[sessionId] = row;
        return acc;
      }, {});
    }
  }

  const wordItems = (Array.isArray(wordRows) ? wordRows : [])
    .map(row => mapWordResultRow(row, sessionMap, {}))
    .filter(row => !row.yyyymmdd || (row.yyyymmdd >= periodStart && row.yyyymmdd <= periodEnd));

  const numericScores = wordItems.map(row => Number(row.correct_count ?? row.score)).filter(Number.isFinite);
  const totalCounts = wordItems.map(row => Number(row.total_count ?? row.max_score)).filter(Number.isFinite);
  const correctSum = numericScores.reduce((a, b) => a + b, 0);
  const totalSum = totalCounts.reduce((a, b) => a + b, 0);
  const avgScore = numericScores.length ? Math.round((correctSum / numericScores.length) * 10) / 10 : null;
  const avgRate = totalSum > 0 ? Math.round((correctSum / totalSum) * 1000) / 10 : null;
  const publicClinics = clinics.filter(row => row.parent_visible && row.parent_note);
  const openStatuses = new Set(['CANDIDATE', 'PENDING', 'IN_PROGRESS']);
  const doneStatuses = new Set(['DONE', 'PARTIAL']);

  return {
    student: studentOut,
    period: { start: periodStart, end: periodEnd },
    attendance: {
      log_count: Array.isArray(attendanceRows) ? attendanceRows.length : 0,
      check_in_days: checkInDays.length,
      check_out_days: checkOutDays.length,
      recent: (Array.isArray(attendanceRows) ? attendanceRows : []).slice(0, 12).map(mapProfileLogRow)
    },
    word: {
      count: wordItems.length,
      average_score: avgScore,
      average_rate: avgRate,
      correct_sum: correctSum,
      total_sum: totalSum,
      pass_count: wordItems.filter(row => row.result_status === 'PASS').length,
      fail_count: wordItems.filter(row => row.result_status === 'FAIL').length,
      absent_count: wordItems.filter(row => row.result_status === 'ABSENT').length,
      recent: wordItems.slice(0, 12)
    },
    clinic: {
      count: clinics.length,
      open_count: clinics.filter(row => openStatuses.has(row.status)).length,
      done_count: clinics.filter(row => doneStatuses.has(row.status)).length,
      public_note_count: publicClinics.length,
      recent: clinics.slice(0, 12),
      public_notes: publicClinics.slice(0, 8).map(row => ({ title: row.title, parent_note: row.parent_note, status: row.status, updated_at: row.updated_at }))
    },
    warnings
  };
}

async function reportPreviewStudentReportDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const periodStart = String(args.period_start || args.periodStart || args.start || '').trim();
  const periodEnd = String(args.period_end || args.periodEnd || args.end || '').trim();
  if (!sid) return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');
  if (!isStrictYmd(periodStart) || !isStrictYmd(periodEnd)) return fail(400, 'INVALID_INPUT', 'period_start와 period_end는 YYYYMMDD 형식이어야 합니다.');
  if (periodStart > periodEnd) return fail(400, 'INVALID_INPUT', '시작일은 종료일보다 늦을 수 없습니다.');

  const supabase = getSupabaseAdmin();
  const summary = await buildStudentReportSummary(supabase, sid, periodStart, periodEnd);
  return success({ summary });
}

async function reportCreateSnapshotDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const periodType = String(args.period_type || args.periodType || 'WEEKLY').trim().toUpperCase();
  const periodStart = String(args.period_start || args.periodStart || args.start || '').trim();
  const periodEnd = String(args.period_end || args.periodEnd || args.end || '').trim();
  if (!sid) return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'].includes(periodType)) return fail(400, 'INVALID_INPUT', 'period_type이 올바르지 않습니다.');
  if (!isStrictYmd(periodStart) || !isStrictYmd(periodEnd)) return fail(400, 'INVALID_INPUT', 'period_start와 period_end는 YYYYMMDD 형식이어야 합니다.');
  if (periodStart > periodEnd) return fail(400, 'INVALID_INPUT', '시작일은 종료일보다 늦을 수 없습니다.');

  const supabase = getSupabaseAdmin();
  const summary = await buildStudentReportSummary(supabase, sid, periodStart, periodEnd);
  const parentNote = normalizeLimitedText(args.parent_note || args.parentNote || summary.clinic.public_notes.map(row => row.parent_note).filter(Boolean).join('\n'), 2000);
  const row = {
    report_id: randomUUID(),
    student_id: sid,
    period_type: periodType,
    period_start: periodStart,
    period_end: periodEnd,
    summary_json: summary,
    parent_note: parentNote,
    created_by: auth.me.staff_id,
    created_at: nowIso()
  };

  const { data, error } = await supabase
    .from('report_snapshots')
    .insert(row)
    .select('*')
    .single();

  if (error) return fail(500, 'DB_INSERT_FAILED', error.message || 'report_snapshots 저장 실패');

  const audit = await appendPortalAuditLogDirect(supabase, auth, {
    op: 'report.createSnapshot',
    target_type: 'report_snapshot',
    target_id: row.report_id,
    action: 'CREATE',
    after_json: row,
    meta_json: { student_id: sid, period_start: periodStart, period_end: periodEnd }
  });

  return success({ item: data || row, summary, audit_warning: audit.ok ? '' : audit.error || '' });
}



async function reportListSnapshotsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const periodType = String(args.period_type || args.periodType || '').trim().toUpperCase();
  const limit = Math.max(1, Math.min(200, toPositiveInt(args.limit, 50)));

  let q = supabase
    .from('report_snapshots')
    .select('report_id, student_id, period_type, period_start, period_end, summary_json, parent_note, created_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (sid) q = q.eq('student_id', sid);
  if (['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'].includes(periodType)) q = q.eq('period_type', periodType);

  const { data, error } = await q;
  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'report_snapshots 조회 실패');

  const rows = Array.isArray(data) ? data : [];
  const studentNameMap = await readStudentNameMap(supabase, rows.map(row => row?.student_id).filter(Boolean));
  const items = rows.map(row => {
    const summary = isPlainObject(row?.summary_json) ? row.summary_json : {};
    const wordAvg = summary?.word?.average_score;
    const wordCorrectSum = summary?.word?.correct_sum;
    const wordTotalSum = summary?.word?.total_sum;
    const clinicDone = summary?.clinic?.done_count;
    const clinicOpen = summary?.clinic?.open_count;
    return {
      report_id: String(row?.report_id || '').trim(),
      student_id: normalizeStudentId(row?.student_id),
      student_name: studentNameMap[normalizeStudentId(row?.student_id)] || summary?.student?.student_name || '',
      period_type: String(row?.period_type || '').trim(),
      period_start: String(row?.period_start || '').trim(),
      period_end: String(row?.period_end || '').trim(),
      parent_note: String(row?.parent_note || '').trim(),
      created_by: String(row?.created_by || '').trim(),
      created_at: String(row?.created_at || '').trim(),
      word_average_score: Number.isFinite(Number(wordAvg)) ? Number(wordAvg) : null,
      word_correct_sum: Number.isFinite(Number(wordCorrectSum)) ? Number(wordCorrectSum) : null,
      word_total_sum: Number.isFinite(Number(wordTotalSum)) ? Number(wordTotalSum) : null,
      clinic_summary: `${clinicOpen ?? 0}/${clinicDone ?? 0}`,
      summary_json: summary
    };
  });
  return success({ count: items.length, items });
}

async function auditSearchLogsDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const opFilter = normalizeLimitedText(args.op, 120);
  const targetType = normalizeLimitedText(args.target_type || args.targetType, 120);
  const targetId = normalizeLimitedText(args.target_id || args.targetId, 160);
  const actorStaffId = normalizeLimitedText(args.actor_staff_id || args.actorStaffId || args.actor || '', 120);
  const limit = Math.max(1, Math.min(200, toPositiveInt(args.limit, 80)));

  let q = supabase
    .from('portal_audit_logs')
    .select('audit_id, actor_staff_id, actor_role, actor_name, op, target_type, target_id, action, before_json, after_json, meta_json, trace_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (opFilter) q = q.eq('op', opFilter);
  if (targetType) q = q.eq('target_type', targetType);
  if (targetId) q = q.eq('target_id', targetId);
  if (actorStaffId) q = q.eq('actor_staff_id', actorStaffId);

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
    .select('clinic_task_id, student_id, class_id, title, task_type, source_type, source_id, status, priority, due_date, due_time, due_at, clinic_mode, auto_notice_enabled, assigned_staff_id, internal_note, parent_note, parent_visible, created_by, created_at, updated_by, updated_at, completed_at')
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


async function adminStudentTodayLinkCreateDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const expiresDays = Math.max(1, Math.min(30, toPositiveInt(args.expires_days || args.expiresDays, 7)));
  if (!sid) return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');

  const supabase = getSupabaseAdmin();
  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, status')
    .eq('student_id', sid)
    .maybeSingle();

  if (studentErr) return fail(500, 'DB_SELECT_FAILED', studentErr.message || '학생 조회 실패');
  if (!student) return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
  const token = makePublicToken();
  const tokenHash = publicTokenHash(token);
  const tokenPrefix = token.slice(0, 8);

  const row = {
    link_id: randomUUID(),
    student_id: sid,
    audience: 'STUDENT',
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    status: 'ACTIVE',
    expires_at: expiresAt,
    created_by: auth.me.staff_id,
    created_at: now.toISOString(),
    updated_by: auth.me.staff_id,
    updated_at: now.toISOString(),
    meta_json: {
      source: 'admin.studentTodayLink.create',
      actor_role: normalizeRole(auth.me.role),
      student_name: String(student.student_name || '').trim()
    }
  };

  const { error } = await supabase
    .from('student_today_links')
    .insert([row]);

  if (error) {
    return fail(500, 'DB_INSERT_FAILED', error.message || 'student_today_links 저장 실패', {
      hint: 'docs/supabase-student-today-link-v1.sql 적용 여부를 확인하세요.'
    });
  }

  const baseUrl = normalizePublicBaseUrl(args.origin || args.base_url || args.baseUrl);
  const publicUrl = `${baseUrl}/student-today.html?t=${encodeURIComponent(token)}`;

  return success({
    student_id: sid,
    student_name: String(student.student_name || '').trim(),
    public_url: publicUrl,
    token_prefix: tokenPrefix,
    expires_at: expiresAt,
    expires_days: expiresDays
  });
}

function normalizeLectureStatus(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (['ACTIVE', 'COMPLETED', 'ARCHIVED'].includes(v)) return v;
  return 'ACTIVE';
}

function normalizeLectureUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    const url = new URL(v);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

function mapLectureAssignmentRow(row = {}) {
  return {
    assignment_id: String(row.assignment_id || '').trim(),
    student_id: normalizeStudentId(row.student_id || ''),
    title: String(row.title || '').trim(),
    url: String(row.url || '').trim(),
    due_date: String(row.due_date || '').trim(),
    status: normalizeLectureStatus(row.status || 'ACTIVE'),
    visible_to_student: row.visible_to_student !== false,
    note: String(row.note || '').trim(),
    completed_at: String(row.completed_at || '').trim(),
    created_by: String(row.created_by || '').trim(),
    created_at: String(row.created_at || '').trim(),
    updated_by: String(row.updated_by || '').trim(),
    updated_at: String(row.updated_at || '').trim()
  };
}

async function adminLectureAssignmentListDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const status = String(args.status || '').trim().toUpperCase();
  const includeArchived = args.include_archived === true || String(args.include_archived || '').toUpperCase() === 'Y';
  const limit = Math.max(1, Math.min(100, toPositiveInt(args.limit, 40)));

  if (!sid) return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('student_lecture_assignments')
    .select('assignment_id, student_id, title, url, due_date, status, visible_to_student, note, completed_at, created_by, created_at, updated_by, updated_at')
    .eq('student_id', sid)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status && ['ACTIVE', 'COMPLETED', 'ARCHIVED'].includes(status)) query = query.eq('status', status);
  if (!includeArchived) query = query.neq('status', 'ARCHIVED');

  const { data, error } = await query;
  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'student_lecture_assignments 조회 실패', {
      hint: 'docs/supabase-online-lecture-assignment-v1.sql 적용 여부를 확인하세요.'
    });
  }

  const items = (Array.isArray(data) ? data : []).map(mapLectureAssignmentRow);
  return success({ student_id: sid, count: items.length, items });
}

async function adminLectureAssignmentSaveDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'teacher');
  if (!auth.ok) return auth.out;

  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const assignmentId = String(args.assignment_id || args.assignmentId || '').trim();
  const title = String(args.title || '').trim().slice(0, 160);
  const url = normalizeLectureUrl(args.url || '');
  const dueDate = normalizeYmdInput(args.due_date || args.dueDate || '');
  const status = normalizeLectureStatus(args.status || 'ACTIVE');
  const visible = args.visible_to_student !== false && String(args.visible_to_student || 'Y').toUpperCase() !== 'N';
  const note = String(args.note || '').trim().slice(0, 500);

  if (!sid) return fail(400, 'INVALID_INPUT', 'student_id 4자리가 필요합니다.');
  if (!title) return fail(400, 'INVALID_INPUT', '강의 제목이 필요합니다.');
  if (!url) return fail(400, 'INVALID_INPUT', 'http 또는 https 강의 링크가 필요합니다.');
  if (args.due_date || args.dueDate) {
    if (!dueDate) return fail(400, 'INVALID_INPUT', '기한은 20260627 또는 2026-06-27 형식으로 입력하세요.');
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  let before = null;
  if (assignmentId) {
    const { data: prev, error: prevErr } = await supabase
      .from('student_lecture_assignments')
      .select('*')
      .eq('assignment_id', assignmentId)
      .maybeSingle();
    if (prevErr) return fail(500, 'DB_SELECT_FAILED', prevErr.message || '기존 강의 배정 조회 실패');
    if (!prev) return fail(404, 'NOT_FOUND', '수정할 강의 배정을 찾지 못했습니다.');
    before = prev;
  }

  const row = {
    student_id: sid,
    title,
    url,
    due_date: dueDate || null,
    status,
    visible_to_student: visible,
    note,
    updated_by: auth.me.staff_id,
    updated_at: now
  };

  let saved;
  let error;
  if (assignmentId) {
    ({ data: saved, error } = await supabase
      .from('student_lecture_assignments')
      .update(row)
      .eq('assignment_id', assignmentId)
      .select('assignment_id, student_id, title, url, due_date, status, visible_to_student, note, completed_at, created_by, created_at, updated_by, updated_at')
      .maybeSingle());
  } else {
    ({ data: saved, error } = await supabase
      .from('student_lecture_assignments')
      .insert([{
        assignment_id: randomUUID(),
        ...row,
        created_by: auth.me.staff_id,
        created_at: now
      }])
      .select('assignment_id, student_id, title, url, due_date, status, visible_to_student, note, completed_at, created_by, created_at, updated_by, updated_at')
      .maybeSingle());
  }

  if (error) {
    return fail(500, assignmentId ? 'DB_UPDATE_FAILED' : 'DB_INSERT_FAILED', error.message || '온라인강의 배정 저장 실패', {
      hint: 'docs/supabase-online-lecture-assignment-v1.sql 적용 여부를 확인하세요.'
    });
  }

  await appendPortalAuditLogDirect(supabase, auth, {
    op: 'admin.lectureAssignment.save',
    target_type: 'student_lecture_assignment',
    target_id: String(saved?.assignment_id || assignmentId || ''),
    action: assignmentId ? 'UPDATE' : 'CREATE',
    before_json: before || {},
    after_json: saved || {},
    meta_json: { student_id: sid, visible_to_student: visible }
  });

  return success({ item: mapLectureAssignmentRow(saved || {}) });
}


async function studentTodayPublicGetDirect(args = {}) {
  const token = String(args.token || args.t || '').trim();
  if (!token || token.length < 24) return fail(400, 'INVALID_TOKEN', '유효한 링크 토큰이 필요합니다.');

  const supabase = getSupabaseAdmin();
  const hash = publicTokenHash(token);
  const { data: link, error: linkErr } = await supabase
    .from('student_today_links')
    .select('link_id, student_id, audience, status, expires_at, access_count')
    .eq('token_hash', hash)
    .maybeSingle();

  if (linkErr) return fail(500, 'DB_SELECT_FAILED', linkErr.message || '학생 링크 조회 실패');
  if (!link || String(link.status || '').toUpperCase() !== 'ACTIVE') return fail(404, 'LINK_NOT_FOUND', '유효하지 않은 학생 링크입니다.');
  if (Date.parse(link.expires_at) && Date.parse(link.expires_at) < Date.now()) return fail(410, 'LINK_EXPIRED', '만료된 학생 링크입니다.');

  const sid = normalizeStudentId(link.student_id);
  const yyyymmdd = String(args.yyyymmdd || args.ymd || kstYmd(new Date())).trim();
  const warnings = [];

  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, status')
    .eq('student_id', sid)
    .maybeSingle();

  if (studentErr) return fail(500, 'DB_SELECT_FAILED', studentErr.message || '학생 조회 실패');
  if (!student) return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');

  const todayOut = await loadManualTodayState(supabase, sid, yyyymmdd);
  if (!todayOut.ok) warnings.push({ area: 'attendance', message: todayOut.error || '오늘 출결 상태 조회 실패' });

  let clinics = [];
  const { data: clinicRows, error: clinicErr } = await supabase
    .from('clinic_tasks')
    .select('clinic_task_id, title, status, due_date, due_time, clinic_mode, parent_note, parent_visible, updated_at')
    .eq('student_id', sid)
    .order('updated_at', { ascending: false })
    .limit(8);
  if (clinicErr) warnings.push({ area: 'clinic', message: clinicErr.message || '클리닉 조회 실패' });
  else {
    clinics = (Array.isArray(clinicRows) ? clinicRows : [])
      .filter(row => row.parent_visible === true || ['pending','in_progress','incomplete','no_show','contact_needed'].includes(String(row.status || '').toLowerCase()))
      .map(row => ({
        title: String(row.title || '').trim(),
        status: String(row.status || '').trim(),
        due_date: String(row.due_date || '').trim(),
        due_time: String(row.due_time || '').trim(),
        clinic_mode: String(row.clinic_mode || '').trim(),
        note: row.parent_visible === true ? String(row.parent_note || '').trim() : ''
      }));
  }

  let words = [];
  const { data: wordRows, error: wordErr } = await supabase
    .from('word_records')
    .select('yyyymmdd, word_book_title, range_label, scope_text, word_total_count, word_correct_count, word_pass_count, word_accuracy, result_status, word_passed, word_needs_retest, word_needs_clinic, updated_at')
    .eq('student_id', sid)
    .order('yyyymmdd', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(8);
  if (wordErr) warnings.push({ area: 'word_records', message: wordErr.message || '단어 기록 조회 실패' });
  else {
    words = (Array.isArray(wordRows) ? wordRows : []).map(row => ({
      yyyymmdd: String(row.yyyymmdd || '').trim(),
      title: String(row.word_book_title || row.scope_text || '').trim(),
      range_label: String(row.range_label || '').trim(),
      total: Number(row.word_total_count || 0),
      correct: row.word_correct_count == null ? null : Number(row.word_correct_count),
      pass_count: Number(row.word_pass_count || 0),
      accuracy: row.word_accuracy == null ? null : Number(row.word_accuracy),
      result_status: String(row.result_status || '').trim(),
      needs_retest: row.word_needs_retest === true,
      needs_clinic: row.word_needs_clinic === true
    }));
  }


  let lectures = [];
  const { data: lectureRows, error: lectureErr } = await supabase
    .from('student_lecture_assignments')
    .select('assignment_id, title, url, due_date, status, visible_to_student, note, completed_at, updated_at')
    .eq('student_id', sid)
    .eq('visible_to_student', true)
    .neq('status', 'ARCHIVED')
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(12);
  if (lectureErr) warnings.push({ area: 'student_lecture_assignments', message: lectureErr.message || '온라인강의 조회 실패' });
  else {
    lectures = (Array.isArray(lectureRows) ? lectureRows : []).map(row => ({
      assignment_id: String(row.assignment_id || '').trim(),
      title: String(row.title || '').trim(),
      url: String(row.url || '').trim(),
      due_date: String(row.due_date || '').trim(),
      status: normalizeLectureStatus(row.status || 'ACTIVE'),
      note: String(row.note || '').trim(),
      completed_at: String(row.completed_at || '').trim()
    }));
  }

  supabase
    .from('student_today_links')
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: Number(link.access_count || 0) + 1
    })
    .eq('link_id', link.link_id)
    .then(() => {}, () => {});

  return success({
    link: {
      audience: String(link.audience || 'STUDENT'),
      expires_at: String(link.expires_at || '')
    },
    yyyymmdd,
    student: {
      student_id: sid,
      student_name: String(student.student_name || '').trim(),
      school: String(student.school || '').trim(),
      grade: String(student.grade || '').trim(),
      status: String(student.status || '').trim()
    },
    today: {
      label: publicTodayStateLabel(todayOut.ok ? todayOut.state : null),
      last_action: publicActionLabel(todayOut.ok ? todayOut.state?.lastActionType : ''),
      source: todayOut.source || ''
    },
    clinics,
    words,
    lectures,
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


function finalCheckStatus(ok, warn = false) {
  if (!ok) return 'FAIL';
  return warn ? 'WARN' : 'OK';
}

function envPresence(name) {
  return String(process.env[name] || '').trim() ? 'SET' : 'MISSING';
}

async function probeColumns(supabase, table, columns = []) {
  try {
    const { error } = await supabase
      .from(table)
      .select(columns.join(', '))
      .limit(1);
    return { ok: !error, error: error ? String(error.message || error) : '' };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function countRows(supabase, table, column = '*', apply = null) {
  try {
    let q = supabase.from(table).select(column, { count: 'exact', head: true });
    if (typeof apply === 'function') q = apply(q);
    const { count, error } = await q;
    return { ok: !error, count: Number(count || 0), error: error ? String(error.message || error) : '' };
  } catch (e) {
    return { ok: false, count: 0, error: e?.message || String(e) };
  }
}

function kstDateTextFromYmd(ymd) {
  const v = String(ymd || '').replace(/[^0-9]/g, '');
  if (v.length !== 8) return '';
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}



function phoneIdentityDigits(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

function phoneIdentityIs010(raw) {
  return /^010\d{8}$/.test(phoneIdentityDigits(raw));
}

function phoneIdentityTail8(raw) {
  const digits = phoneIdentityDigits(raw);
  if (/^010\d{8}$/.test(digits)) return digits.slice(-8);
  if (/^\d{8}$/.test(digits)) return digits;
  return '';
}

function phoneIdentityStudentActive(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return true;
  return !['deleted', 'delete', 'inactive', 'disabled', '졸업', '퇴원', '휴원', '비활성', '삭제'].includes(v);
}

function phoneIdentityStaffActive(row = {}) {
  const revoked = String(row?.revoked || '').trim().toUpperCase() === 'Y';
  if (revoked) return false;
  const v = String(row?.status || '').trim().toLowerCase();
  if (!v) return true;
  return ['active', '재직', '활성', 'enabled', '1', 'y', 'yes', 'true'].includes(v);
}

function phoneIdentityPickStaffPhone(row = {}) {
  const candidates = [
    row?.staff_phone,
    row?.phone,
    row?.mobile,
    row?.mobile_phone,
    row?.phone_number,
    row?.tel,
    row?.contact,
    row?.contact_phone
  ];
  for (const c of candidates) {
    const digits = phoneIdentityDigits(c);
    if (digits) return String(c || '').trim();
  }
  return '';
}

function phoneIdentityIssue(entity, type, severity, row = {}, message = '', extra = {}) {
  return {
    entity,
    type,
    severity,
    id: String(row?.student_id || row?.staff_id || row?.id || '').trim(),
    name: String(row?.student_name || row?.name || '').trim(),
    status: String(row?.status || '').trim(),
    phone: String(row?.student_phone || row?.staff_phone || row?.phone || row?.mobile || row?.mobile_phone || '').trim(),
    tail8: phoneIdentityTail8(row?.student_phone || row?.staff_phone || row?.phone || row?.mobile || row?.mobile_phone || ''),
    message,
    ...extra
  };
}

function phoneIdentityGroupByTail(items) {
  const map = new Map();
  for (const item of items) {
    const tail8 = String(item.tail8 || '').trim();
    if (!tail8) continue;
    if (!map.has(tail8)) map.set(tail8, []);
    map.get(tail8).push(item);
  }
  return Array.from(map.entries()).filter(([, list]) => list.length > 1);
}

function phoneIdentityMissingTable(error, tableName) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const table = String(tableName || '').toLowerCase();
  return (
    code === 'PGRST205' ||
    message.includes('could not find the table') ||
    message.includes(table) ||
    details.includes(table)
  );
}

async function phoneIdentityReadStaffRows(supabase) {
  const tables = ['staff_phone_directory', 'staff_snapshot', 'staff'];
  const rows = [];
  const errors = [];

  for (const table of tables) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .limit(1000);

    if (error) {
      if (!phoneIdentityMissingTable(error, table)) {
        errors.push({ table, message: String(error.message || error), code: String(error.code || '') });
      }
      continue;
    }

    for (const row of Array.isArray(data) ? data : []) {
      rows.push({ ...row, _source_table: table });
    }
  }

  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.staff_id || '').trim().toLowerCase();
    if (!id) continue;
    const phone = phoneIdentityPickStaffPhone(row);
    const normalized = {
      ...row,
      staff_id: id,
      staff_phone: phone,
      status: String(row?.status || '').trim(),
      revoked: String(row?.revoked || '').trim()
    };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, normalized);
      continue;
    }
    const prevPhone = phoneIdentityPickStaffPhone(prev);
    if (!prevPhone && phone) byId.set(id, normalized);
    else if (prev._source_table === 'staff' && normalized._source_table === 'staff_snapshot') byId.set(id, normalized);
  }

  return { rows: Array.from(byId.values()), errors };
}

async function buildPhoneIdentityAudit(supabase) {
  const generatedAt = nowIso();
  const studentIssues = [];
  const staffIssues = [];
  const crossIssues = [];

  const studentSelect = 'student_id, student_name, school, grade, student_phone, parent_phone, teacher, status';
  const { data: studentData, error: studentError } = await supabase
    .from('students')
    .select(studentSelect)
    .limit(5000);

  const studentRows = Array.isArray(studentData) ? studentData : [];
  const activeStudents = studentRows.filter(row => phoneIdentityStudentActive(row?.status));
  const studentIdentities = [];

  if (studentError) {
    studentIssues.push(phoneIdentityIssue('system', 'student_read_failed', 'blocker', {}, studentError.message || 'students 조회 실패'));
  }

  for (const row of activeStudents) {
    const studentPhone = String(row?.student_phone || '').trim();
    const parentPhone = String(row?.parent_phone || '').trim();
    const studentDigits = phoneIdentityDigits(studentPhone);
    const parentDigits = phoneIdentityDigits(parentPhone);
    const studentValid = /^010\d{8}$/.test(studentDigits);
    const parentValid = /^010\d{8}$/.test(parentDigits);
    const useParentFallback = !studentValid && parentValid;
    const phone = studentValid ? studentPhone : (useParentFallback ? parentPhone : studentPhone);
    const digits = studentValid ? studentDigits : (useParentFallback ? parentDigits : studentDigits);
    const tail8 = phoneIdentityTail8(digits);
    const identity = {
      entity: 'student',
      id: String(row?.student_id || '').trim(),
      name: String(row?.student_name || '').trim(),
      phone,
      digits,
      tail8,
      phone_source: studentValid ? 'student_phone' : (useParentFallback ? 'parent_phone_fallback' : 'student_phone'),
      student_phone: studentPhone,
      parent_phone: parentPhone,
      status: String(row?.status || '').trim(),
      school: String(row?.school || '').trim(),
      grade: String(row?.grade || '').trim()
    };
    studentIdentities.push(identity);

    if (useParentFallback) {
      studentIssues.push(phoneIdentityIssue('student', 'student_phone_parent_fallback', 'warn', { ...row, student_phone: parentPhone }, '학생 본인 번호가 없어 학부모 번호로 출결 가능합니다. 형제/자매 중복 여부만 확인하세요.', { school: identity.school, grade: identity.grade, phone_source: 'parent_phone_fallback' }));
      continue;
    }
    if (!studentDigits) {
      studentIssues.push(phoneIdentityIssue('student', 'missing_phone', 'blocker', row, '학생 본인 휴대폰 번호가 없고, 출결 fallback으로 사용할 010 형식 학부모 번호도 없습니다.', { school: identity.school, grade: identity.grade }));
      continue;
    }
    if (!studentValid) {
      studentIssues.push(phoneIdentityIssue('student', 'invalid_phone', 'blocker', row, '010으로 시작하는 11자리 학생 휴대폰 번호가 아니며, 출결 fallback으로 사용할 010 형식 학부모 번호도 없습니다.', { digits_length: studentDigits.length, school: identity.school, grade: identity.grade }));
      continue;
    }
    if (parentDigits && parentDigits === studentDigits) {
      studentIssues.push(phoneIdentityIssue('student', 'same_as_parent_phone', 'warn', row, '학생 본인 번호와 학부모 번호가 같습니다. 실제 학생 번호인지 확인하세요.', { school: identity.school, grade: identity.grade }));
    }
  }

  for (const [tail8, list] of phoneIdentityGroupByTail(studentIdentities)) {
    for (const item of list) {
      studentIssues.push({
        entity: 'student',
        type: 'duplicate_tail8',
        severity: 'blocker',
        id: item.id,
        name: item.name,
        status: item.status,
        phone: item.phone,
        tail8,
        message: '같은 휴대폰 뒤 8자리를 가진 재원생이 여러 명입니다.',
        duplicates: list.map(x => ({ id: x.id, name: x.name, school: x.school, grade: x.grade }))
      });
    }
  }

  const fullPhoneMap = new Map();
  for (const item of studentIdentities.filter(x => /^010\d{8}$/.test(x.digits))) {
    if (!fullPhoneMap.has(item.digits)) fullPhoneMap.set(item.digits, []);
    fullPhoneMap.get(item.digits).push(item);
  }
  for (const [digits, list] of fullPhoneMap.entries()) {
    if (list.length <= 1) continue;
    for (const item of list) {
      studentIssues.push({
        entity: 'student',
        type: 'duplicate_full_phone',
        severity: 'blocker',
        id: item.id,
        name: item.name,
        status: item.status,
        phone: item.phone,
        tail8: item.tail8,
        message: '같은 전체 휴대폰 번호를 가진 재원생이 여러 명입니다.',
        duplicates: list.map(x => ({ id: x.id, name: x.name }))
      });
    }
  }

  const staffRead = await phoneIdentityReadStaffRows(supabase);
  for (const err of staffRead.errors) {
    staffIssues.push(phoneIdentityIssue('system', 'staff_read_failed', 'warn', {}, `${err.table} 조회 실패: ${err.message}`, { table: err.table, code: err.code }));
  }

  const activeStaff = staffRead.rows.filter(row => phoneIdentityStaffActive(row));
  const staffIdentities = [];
  for (const row of activeStaff) {
    const phone = phoneIdentityPickStaffPhone(row);
    const digits = phoneIdentityDigits(phone);
    const tail8 = phoneIdentityTail8(phone);
    const identity = {
      entity: 'staff',
      id: String(row?.staff_id || '').trim().toLowerCase(),
      name: String(row?.name || '').trim(),
      role: normalizeRole(row?.role || 'assistant'),
      phone,
      digits,
      tail8,
      status: String(row?.status || '').trim(),
      source: String(row?._source_table || '').trim()
    };
    staffIdentities.push(identity);

    if (!digits) {
      staffIssues.push(phoneIdentityIssue('staff', 'missing_phone', 'blocker', { ...row, staff_phone: phone }, '직원 휴대폰 번호가 없습니다.', { role: identity.role, source: identity.source }));
      continue;
    }
    if (!/^010\d{8}$/.test(digits)) {
      staffIssues.push(phoneIdentityIssue('staff', 'invalid_phone', 'blocker', { ...row, staff_phone: phone }, '010으로 시작하는 11자리 직원 휴대폰 번호가 아닙니다.', { role: identity.role, digits_length: digits.length, source: identity.source }));
    }
  }

  for (const [tail8, list] of phoneIdentityGroupByTail(staffIdentities)) {
    for (const item of list) {
      staffIssues.push({
        entity: 'staff',
        type: 'duplicate_tail8',
        severity: 'blocker',
        id: item.id,
        name: item.name,
        status: item.status,
        phone: item.phone,
        tail8,
        message: '같은 휴대폰 뒤 8자리를 가진 재직 직원이 여러 명입니다.',
        duplicates: list.map(x => ({ id: x.id, name: x.name, role: x.role }))
      });
    }
  }

  const studentTailMap = new Map(studentIdentities.filter(x => x.tail8).map(x => [x.tail8, x]));
  for (const staff of staffIdentities.filter(x => x.tail8)) {
    const student = studentTailMap.get(staff.tail8);
    if (!student) continue;
    crossIssues.push({
      entity: 'cross',
      type: 'student_staff_tail_conflict',
      severity: 'warn',
      id: staff.id,
      name: staff.name,
      phone: staff.phone,
      tail8: staff.tail8,
      message: '학생과 직원의 휴대폰 뒤 8자리가 같습니다. 키오스크 모드 전환 안내를 확인하세요.',
      student: { id: student.id, name: student.name, phone: student.phone },
      staff: { id: staff.id, name: staff.name, phone: staff.phone }
    });
  }

  const allIssues = [...studentIssues, ...staffIssues, ...crossIssues];
  const blockers = allIssues.filter(x => x.severity === 'blocker');
  const warnings = allIssues.filter(x => x.severity !== 'blocker');
  const studentReady = activeStudents.length - new Set(studentIssues.filter(x => x.severity === 'blocker' && x.id).map(x => x.id)).size;
  const staffReady = activeStaff.length - new Set(staffIssues.filter(x => x.severity === 'blocker' && x.id).map(x => x.id)).size;
  const studentReadyRate = activeStudents.length ? Math.round((Math.max(0, studentReady) / activeStudents.length) * 100) : 0;
  const studentParentFallbackReady = studentIdentities.filter(x => x.phone_source === 'parent_phone_fallback' && /^010\d{8}$/.test(x.digits)).length;
  const staffReadyRate = activeStaff.length ? Math.round((Math.max(0, staffReady) / activeStaff.length) * 100) : 0;

  return {
    generated_at: generatedAt,
    status: blockers.length ? 'FAIL' : (warnings.length ? 'WARN' : 'OK'),
    summary: {
      active_students: activeStudents.length,
      student_ready: Math.max(0, studentReady),
      student_ready_rate: studentReadyRate,
      student_parent_fallback_ready: studentParentFallbackReady,
      active_staff: activeStaff.length,
      staff_ready: Math.max(0, staffReady),
      staff_ready_rate: staffReadyRate,
      blockers: blockers.length,
      warnings: warnings.length,
      total_issues: allIssues.length
    },
    students: {
      total_active: activeStudents.length,
      ready: Math.max(0, studentReady),
      ready_rate: studentReadyRate,
      parent_fallback_ready: studentParentFallbackReady,
      issues: studentIssues.slice(0, 200)
    },
    staff: {
      total_active: activeStaff.length,
      ready: Math.max(0, staffReady),
      ready_rate: staffReadyRate,
      issues: staffIssues.slice(0, 200)
    },
    cross_issues: crossIssues.slice(0, 100),
    issues: allIssues.slice(0, 300),
    notes: [
      '읽기 전용 점검입니다. 데이터는 수정하지 않습니다.',
      '학생은 students.student_phone을 우선 사용하고, 학생 번호가 없거나 유효하지 않으면 parent_phone을 출결 fallback으로 사용할 수 있습니다.',
      '직원은 staff_phone_directory/staff/staff_snapshot의 전화번호 계열 컬럼을 기준으로 점검합니다.',
      '010으로 시작하는 11자리 번호와 뒤 8자리 중복 여부를 확인합니다.'
    ]
  };
}

async function adminPhoneIdentityAuditDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;
  const supabase = getSupabaseAdmin();
  try {
    const audit = await buildPhoneIdentityAudit(supabase);
    return success(audit);
  } catch (e) {
    return fail(500, 'PHONE_IDENTITY_AUDIT_FAILED', e?.message || '휴대폰 출결 준비도 점검 실패');
  }
}

async function adminFinalReadinessDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const supabase = getSupabaseAdmin();
  const todayDate = kstDateTextFromYmd(kstYmd());
  const sections = [];

  const add = (key, label, status, detail = '', meta = {}) => {
    sections.push({ key, label, status, detail, meta });
  };

  const requiredProbes = [
    ['students', ['student_id', 'student_name', 'student_phone', 'parent_phone']],
    ['clinic_tasks', ['clinic_task_id', 'student_id', 'class_id', 'task_type', 'status', 'due_date', 'due_time', 'due_at', 'clinic_mode', 'auto_notice_enabled']],
    ['clinic_logs', ['clinic_log_id', 'clinic_task_id', 'event_type', 'before_status', 'after_status', 'created_at']],
    ['word_test_sessions', ['session_id', 'class_id', 'yyyymmdd', 'title', 'pass_score', 'max_score']],
    ['word_test_results', ['result_id', 'session_id', 'student_id', 'score', 'max_score', 'pass_score', 'result_status', 'clinic_task_id']],
    ['report_snapshots', ['report_snapshot_id', 'student_id', 'period_start', 'period_end', 'summary_json', 'created_at']],
    ['attendance_notify_queue', ['queue_id', 'student_id', 'action_type', 'parent_phone', 'status', 'occurred_at', 'trace_id']],
    ['portal_audit_logs', ['audit_id', 'op', 'target_type', 'target_id', 'actor_staff_id', 'created_at']]
  ];

  const schemaMeta = [];
  for (const [table, columns] of requiredProbes) {
    const probe = await probeColumns(supabase, table, columns);
    schemaMeta.push({ table, ok: probe.ok, error: probe.error });
  }
  const schemaFails = schemaMeta.filter(x => !x.ok);
  add(
    'schema',
    'DB 스키마/컬럼',
    schemaFails.length ? 'FAIL' : 'OK',
    schemaFails.length ? `${schemaFails.length}개 테이블/컬럼 점검 실패` : '필수 테이블과 컬럼이 모두 응답합니다.',
    { tables: schemaMeta }
  );

  const totalStudents = await countRows(supabase, 'students', 'student_id');
  const parentPhones = await countRows(supabase, 'students', 'student_id', q => q.not('parent_phone', 'is', null).neq('parent_phone', ''));
  const studentPhones = await countRows(supabase, 'students', 'student_id', q => q.not('student_phone', 'is', null).neq('student_phone', ''));
  const total = totalStudents.count || 0;
  const parentRate = total ? Math.round((parentPhones.count / total) * 100) : 0;
  const studentRate = total ? Math.round((studentPhones.count / total) * 100) : 0;
  add(
    'phone_coverage',
    '학생/학부모 연락처',
    finalCheckStatus(total > 0 && parentPhones.count > 0, total > 0 && studentRate < 80),
    total ? `학생 ${total}명 · 학부모 연락처 ${parentPhones.count}명(${parentRate}%) · 학생 연락처 ${studentPhones.count}명(${studentRate}%)` : '학생 데이터가 없습니다.',
    { total, parent_count: parentPhones.count, student_count: studentPhones.count, parent_rate: parentRate, student_rate: studentRate }
  );

  const phoneIdentity = await buildPhoneIdentityAudit(supabase);
  add(
    'phone_identity',
    '휴대폰 출결 준비도',
    phoneIdentity.status,
    `학생 출결 가능 ${phoneIdentity.summary.student_ready}/${phoneIdentity.summary.active_students}명(${phoneIdentity.summary.student_ready_rate}%) · 직원 출퇴근 가능 ${phoneIdentity.summary.staff_ready}/${phoneIdentity.summary.active_staff}명(${phoneIdentity.summary.staff_ready_rate}%) · 수정 필요 ${phoneIdentity.summary.blockers}건 · 확인 권장 ${phoneIdentity.summary.warnings}건`,
    phoneIdentity.summary
  );

  const envRequired = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const envOps = ['CENTRAL_GAS_WEBAPP_URL', 'CENTRAL_BRIDGE_SECRET', 'CRON_SECRET', 'NOTIFY_WORKER_KEY'];
  const envAlim = ['NCP_ALIMTALK_SERVICE_ID', 'NCP_ACCESS_KEY', 'NCP_SECRET_KEY', 'NCP_PLUS_FRIEND_ID'];
  const envTpl = ['TPL_CLINIC_RESERVATION_PARENT', 'TPL_CLINIC_RESERVATION_STUDENT', 'TPL_CLINIC_MISSING_PARENT', 'TPL_CLINIC_MISSING_STUDENT', 'TPL_CLINIC_ABSENCE_PARENT'];
  const envSms = ['NCP_SMS_SERVICE_ID', 'NCP_SENS_FROM', 'NCP_CALLER', 'USE_SMS_FAILOVER', 'CLINIC_NOTIFY_SMS_AFTER_ALIM_FAIL'];
  const envMeta = [...envRequired, ...envOps, ...envAlim, ...envTpl, ...envSms].map(name => ({ name, status: envPresence(name) }));
  const missingRequired = envMeta.filter(x => envRequired.includes(x.name) && x.status !== 'SET');
  const missingAlim = envMeta.filter(x => envAlim.includes(x.name) && x.status !== 'SET');
  const missingOps = envMeta.filter(x => envOps.includes(x.name) && x.status !== 'SET');
  add(
    'env',
    '운영 환경변수',
    missingRequired.length ? 'FAIL' : (missingAlim.length || missingOps.length ? 'WARN' : 'OK'),
    missingRequired.length ? '필수 서버 환경변수가 누락되었습니다.' : (missingAlim.length ? '알림톡 환경변수 일부가 없어 클리닉 알림이 실패할 수 있습니다.' : '필수 운영 환경변수 상태가 양호합니다.'),
    { variables: envMeta }
  );

  const todayClinic = await countRows(supabase, 'clinic_tasks', 'clinic_task_id', q => q.eq('due_date', todayDate));
  const todayOpenClinic = await countRows(supabase, 'clinic_tasks', 'clinic_task_id', q => q.eq('due_date', todayDate).not('status', 'in', '(DONE,PARTIAL,REJECTED,CANCELLED)'));
  const classClinics = await countRows(supabase, 'clinic_tasks', 'clinic_task_id', q => q.eq('task_type', 'CLASS_CLINIC'));
  const extraClinics = await countRows(supabase, 'clinic_tasks', 'clinic_task_id', q => q.eq('task_type', 'EXTRA_CLINIC'));
  add(
    'clinic_workflow',
    '클리닉 업무 흐름',
    finalCheckStatus(todayClinic.ok && classClinics.ok && extraClinics.ok, todayClinic.ok && todayOpenClinic.count > 30),
    `오늘 클리닉 ${todayClinic.count}건 · 열린 건 ${todayOpenClinic.count}건 · 수업 클리닉 누적 ${classClinics.count}건 · 추가 클리닉 누적 ${extraClinics.count}건`,
    { today: todayClinic.count, today_open: todayOpenClinic.count, class_total: classClinics.count, extra_total: extraClinics.count }
  );

  const clinicQueuePending = await countRows(supabase, 'attendance_notify_queue', 'queue_id', q => q.like('action_type', 'CLINIC_%').eq('status', 'PENDING'));
  const clinicQueueFailed = await countRows(supabase, 'attendance_notify_queue', 'queue_id', q => q.like('action_type', 'CLINIC_%').eq('status', 'FAILED'));
  const clinicQueueDone = await countRows(supabase, 'attendance_notify_queue', 'queue_id', q => q.like('action_type', 'CLINIC_%').eq('status', 'DONE'));
  add(
    'clinic_notify',
    '클리닉 알림 큐',
    clinicQueueFailed.count > 0 ? 'WARN' : 'OK',
    `대기 ${clinicQueuePending.count}건 · 완료 ${clinicQueueDone.count}건 · 실패 ${clinicQueueFailed.count}건`,
    { pending: clinicQueuePending.count, done: clinicQueueDone.count, failed: clinicQueueFailed.count }
  );

  const wordSessions = await countRows(supabase, 'word_test_sessions', 'session_id');
  const wordResults = await countRows(supabase, 'word_test_results', 'result_id');
  const wordFails = await countRows(supabase, 'word_test_results', 'result_id', q => q.eq('result_status', 'FAIL'));
  add(
    'word_tests',
    '단어시험',
    finalCheckStatus(wordSessions.ok && wordResults.ok, wordSessions.count === 0),
    `회차 ${wordSessions.count}개 · 결과 ${wordResults.count}건 · 불통과 ${wordFails.count}건`,
    { sessions: wordSessions.count, results: wordResults.count, fails: wordFails.count }
  );

  const reports = await countRows(supabase, 'report_snapshots', 'report_snapshot_id');
  const audits = await countRows(supabase, 'portal_audit_logs', 'audit_id');
  add(
    'report_audit',
    '리포트/감사 로그',
    finalCheckStatus(reports.ok && audits.ok, reports.count === 0 || audits.count === 0),
    `리포트 스냅샷 ${reports.count}건 · 감사 로그 ${audits.count}건`,
    { reports: reports.count, audits: audits.count }
  );

  const summary = {
    ok: sections.filter(x => x.status === 'OK').length,
    warn: sections.filter(x => x.status === 'WARN').length,
    fail: sections.filter(x => x.status === 'FAIL').length,
    generated_at: nowIso(),
    today_ymd: kstYmd()
  };

  return success({
    status: summary.fail ? 'FAIL' : (summary.warn ? 'WARN' : 'OK'),
    summary,
    sections,
    next_actions: sections
      .filter(x => x.status !== 'OK')
      .map(x => ({ key: x.key, label: x.label, status: x.status, detail: x.detail }))
  });
}


function liveAbsenceKstStartMs(yyyymmdd, hhmm) {
  const t = String(hhmm || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!isStrictYmd(yyyymmdd) || !m) return 0;
  const y = Number(yyyymmdd.slice(0, 4));
  const mo = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return 0;
  return Date.UTC(y, mo - 1, d, h - 9, mi, 0, 0);
}

function liveAbsenceKstDateTimeIso(yyyymmdd, hhmm) {
  const ms = liveAbsenceKstStartMs(yyyymmdd, hhmm);
  return ms ? new Date(ms).toISOString() : '';
}

function liveAbsencePhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').trim();
}

function liveAbsenceStudentActive(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return true;
  return !['deleted', 'delete', 'inactive', 'disabled', '졸업', '퇴원', '휴원', '비활성', '삭제'].includes(v);
}

function liveAbsenceStagePolicy(raw) {
  const parsed = String(raw || process.env.ABSENT_STAGE_MINUTES || '5,20')
    .split(/[,,/|;\s]+/)
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 60 && n % 5 === 0)
    .map(n => Math.floor(n));
  const unique = Array.from(new Set(parsed)).sort((a, b) => a - b);
  return unique.length ? unique.slice(0, 3) : [5, 20];
}

async function liveAbsenceSelectInChunks(supabase, table, columns, field, values, extra = null) {
  const ids = Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let query = supabase.from(table).select(columns).in(field, chunk);
    if (typeof extra === 'function') query = extra(query);
    const { data, error } = await query;
    if (error) throw new Error(error.message || table + ' 조회 실패');
    out.push(...(Array.isArray(data) ? data : []));
  }
  return out;
}

function liveAbsencePresentFromState(row, nowMs) {
  if (!row) return false;
  const checkedIn = row.checked_in === true;
  const checkedOut = row.checked_out === true;
  const lastInMs = Date.parse(String(row.last_check_in_ts || ''));
  const lastOutMs = Date.parse(String(row.last_check_out_ts || ''));
  if (Number.isFinite(lastInMs) && lastInMs > nowMs) return false;
  if (checkedIn && !checkedOut) return true;
  return Number.isFinite(lastInMs) && (!Number.isFinite(lastOutMs) || lastInMs > lastOutMs);
}

function liveAbsenceIsExcuseActive(row, nowMs) {
  const until = String(row?.until_ts || '').trim();
  if (!until) return true;
  let parsed = NaN;
  if (/^\d{10,13}$/.test(until)) parsed = until.length === 10 ? Number(until) * 1000 : Number(until);
  else parsed = Date.parse(until);
  if (!Number.isFinite(parsed)) return false;
  return parsed >= nowMs;
}

function liveAbsenceTraceId(ymd, classId, studentId, stage) {
  return ['ABSENT', ymd, classId, studentId, String(stage)].join('|');
}

function liveAbsenceActionType(stage) {
  return 'ABSENT_' + String(stage);
}

async function assistantTodayAbsenceBoardDirect(args = {}, sessionToken = '') {
  const auth = await requireRole(sessionToken, 'assistant');
  if (!auth.ok) return auth.out;

  const yyyymmdd = normalizeYmdInput(args.yyyymmdd || args.ymd || kstYmd(new Date()));
  if (!yyyymmdd) return fail(400, 'INVALID_INPUT', 'yyyymmdd 8자리가 필요합니다.');

  const includeUpcoming = normalizeBool(args.include_upcoming || args.includeUpcoming) === true;
  const classIdFilter = String(args.class_id || args.classId || '').trim();
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) return fail(400, 'INVALID_INPUT', 'now 값이 올바른 날짜가 아닙니다.');
  const nowMs = now.getTime();
  const minuteBucket = Math.floor(nowMs / 10000);
  const cacheKey = ['todayAbsenceBoard', yyyymmdd, classIdFilter || 'all', includeUpcoming ? 'upcoming' : 'late', minuteBucket].join('|');
  const cached = fastCacheGet(cacheKey);
  if (cached) return success({ ...cached, cache: { hit: true, source: 'memory_fresh' } });

  const supabase = getSupabaseAdmin();

  let scheduleQuery = supabase
    .from('class_schedule')
    .select('yyyymmdd, class_id, class_name, teacher, start, end, status, reason')
    .eq('yyyymmdd', yyyymmdd)
    .order('start', { ascending: true });

  if (classIdFilter) scheduleQuery = scheduleQuery.eq('class_id', classIdFilter);

  const { data: scheduleData, error: scheduleErr } = await scheduleQuery;
  if (scheduleErr) return fail(500, 'DB_SELECT_FAILED', scheduleErr.message || 'class_schedule 조회 실패');

  const scheduledRows = (Array.isArray(scheduleData) ? scheduleData : [])
    .filter(row => isActiveLikeScheduleStatus(row.status))
    .map(row => {
      const startMs = liveAbsenceKstStartMs(yyyymmdd, row.start);
      const lateMin = startMs ? Math.floor((nowMs - startMs) / 60000) : -99999;
      return {
        ...row,
        class_id: String(row.class_id || '').trim(),
        class_name: String(row.class_name || '').trim(),
        start_ms: startMs,
        start_iso: liveAbsenceKstDateTimeIso(yyyymmdd, row.start),
        late_min: lateMin,
        start_passed: startMs > 0 && nowMs >= startMs
      };
    })
    .filter(row => row.class_id)
    .filter(row => includeUpcoming || row.start_passed);

  const classIds = Array.from(new Set(scheduledRows.map(row => row.class_id).filter(Boolean)));
  const emptyOut = {
    yyyymmdd,
    checked_at: now.toISOString(),
    source: 'class_schedule',
    realtime: true,
    refresh_sec: 10,
    schedule_count: (Array.isArray(scheduleData) ? scheduleData : []).length,
    active_schedule_count: scheduledRows.length,
    class_count: 0,
    roster_count: 0,
    present_count: 0,
    missing_count: 0,
    excused_count: 0,
    upcoming_count: 0,
    no_phone_count: 0,
    groups: [],
    items: []
  };
  if (!classIds.length) {
    fastCacheSet(cacheKey, emptyOut, 8, 60);
    return success(emptyOut);
  }

  let relations = [];
  let students = [];
  let classes = [];
  try {
    [relations, classes] = await Promise.all([
      liveAbsenceSelectInChunks(supabase, 'class_students', 'class_id, student_id', 'class_id', classIds),
      liveAbsenceSelectInChunks(supabase, 'classes', 'class_id, name, teacher, alert_delay, status', 'class_id', classIds)
    ]);
    const studentIds = Array.from(new Set(relations.map(row => normalizeStudentId(row.student_id)).filter(Boolean)));
    students = await liveAbsenceSelectInChunks(
      supabase,
      'students',
      'student_id, student_name, school, grade, status, parent_phone, student_phone',
      'student_id',
      studentIds
    );
  } catch (e) {
    return fail(500, 'DB_SELECT_FAILED', e?.message || '실시간 미등원 보드 조회 실패');
  }

  const classMap = new Map();
  for (const cls of classes || []) {
    const id = String(cls.class_id || '').trim();
    if (id) classMap.set(id, cls);
  }

  const studentMap = new Map();
  for (const student of students || []) {
    const sid = normalizeStudentId(student.student_id);
    if (sid && liveAbsenceStudentActive(student.status)) studentMap.set(sid, student);
  }

  const activeStudentIds = Array.from(studentMap.keys());
  let stateRows = [];
  let excuseRows = [];
  let queueRows = [];
  try {
    [stateRows, excuseRows] = await Promise.all([
      liveAbsenceSelectInChunks(
        supabase,
        'today_student_state',
        'student_id, checked_in, checked_out, last_check_in_ts, last_check_out_ts, last_action_type',
        'student_id',
        activeStudentIds,
        query => query.eq('yyyymmdd', yyyymmdd)
      ).catch(() => []),
      liveAbsenceSelectInChunks(
        supabase,
        'absence_excuses',
        'excuse_id, class_id, yyyymmdd, student_id, reason, until_ts',
        'student_id',
        activeStudentIds,
        query => query.eq('yyyymmdd', yyyymmdd)
      ).catch(() => [])
    ]);
  } catch {
    stateRows = [];
    excuseRows = [];
  }

  const presentSet = new Set();
  for (const row of stateRows || []) {
    const sid = normalizeStudentId(row.student_id);
    if (sid && liveAbsencePresentFromState(row, nowMs)) presentSet.add(sid);
  }

  const excuseMap = new Map();
  for (const row of excuseRows || []) {
    const sid = normalizeStudentId(row.student_id);
    const classId = String(row.class_id || '').trim();
    if (!sid || !classId) continue;
    if (!liveAbsenceIsExcuseActive(row, nowMs)) continue;
    excuseMap.set(classId + '|' + sid, row);
  }

  const relationsByClass = new Map();
  for (const rel of relations || []) {
    const classId = String(rel.class_id || '').trim();
    const sid = normalizeStudentId(rel.student_id);
    if (!classId || !sid || !studentMap.has(sid)) continue;
    if (!relationsByClass.has(classId)) relationsByClass.set(classId, []);
    relationsByClass.get(classId).push(sid);
  }

  const traceIds = [];
  const projected = [];
  for (const schedule of scheduledRows) {
    const classId = schedule.class_id;
    const cls = classMap.get(classId) || {};
    const stages = liveAbsenceStagePolicy(cls.alert_delay);
    const roster = relationsByClass.get(classId) || [];
    for (const sid of roster) {
      for (const stage of stages) {
        if (schedule.late_min >= stage) traceIds.push(liveAbsenceTraceId(yyyymmdd, classId, sid, stage));
      }
      projected.push({ classId, sid, stages, schedule, cls });
    }
  }

  if (traceIds.length) {
    try {
      queueRows = await liveAbsenceSelectInChunks(
        supabase,
        'attendance_notify_queue',
        'trace_id, action_type, status, sent_channel, processed_at, last_error, created_at',
        'trace_id',
        traceIds
      );
    } catch {
      queueRows = [];
    }
  }
  const queueByTrace = new Map((queueRows || []).map(row => [String(row.trace_id || '').trim(), row]));

  const groupsByClass = new Map();
  const items = [];
  let rosterCount = 0;
  let presentCount = 0;
  let missingCount = 0;
  let excusedCount = 0;
  let upcomingCount = 0;
  let noPhoneCount = 0;

  for (const schedule of scheduledRows) {
    const classId = schedule.class_id;
    const cls = classMap.get(classId) || {};
    const roster = relationsByClass.get(classId) || [];
    const group = {
      class_id: classId,
      class_name: schedule.class_name || cls.name || classId,
      teacher: String(schedule.teacher || cls.teacher || '').trim(),
      start: String(schedule.start || '').trim(),
      end: String(schedule.end || '').trim(),
      start_iso: schedule.start_iso,
      late_min: schedule.late_min,
      start_passed: schedule.start_passed,
      roster_count: 0,
      present_count: 0,
      missing_count: 0,
      excused_count: 0,
      no_phone_count: 0,
      queue_done_count: 0,
      students: []
    };

    const stages = liveAbsenceStagePolicy(cls.alert_delay);
    for (const sid of roster) {
      const student = studentMap.get(sid);
      if (!student) continue;
      rosterCount++;
      group.roster_count++;

      const isPresent = presentSet.has(sid);
      const excuse = excuseMap.get(classId + '|' + sid) || null;
      if (!schedule.start_passed) {
        upcomingCount++;
        continue;
      }
      if (isPresent) {
        presentCount++;
        group.present_count++;
        continue;
      }
      if (excuse) {
        excusedCount++;
        group.excused_count++;
        continue;
      }

      const sentStages = [];
      for (const stage of stages) {
        if (schedule.late_min < stage) continue;
        const trace = liveAbsenceTraceId(yyyymmdd, classId, sid, stage);
        const q = queueByTrace.get(trace);
        if (q) {
          sentStages.push({
            stage,
            action_type: liveAbsenceActionType(stage),
            status: String(q.status || '').trim(),
            sent_channel: String(q.sent_channel || '').trim(),
            processed_at: q.processed_at || '',
            last_error: q.last_error || ''
          });
          if (String(q.status || '').toUpperCase() === 'DONE') group.queue_done_count++;
        }
      }

      const parentPhone = liveAbsencePhone(student.parent_phone);
      const studentPhone = liveAbsencePhone(student.student_phone);
      if (!parentPhone && !studentPhone) {
        noPhoneCount++;
        group.no_phone_count++;
      }
      const item = {
        yyyymmdd,
        class_id: classId,
        class_name: group.class_name,
        teacher: group.teacher,
        start: group.start,
        end: group.end,
        late_min: schedule.late_min,
        student_id: sid,
        student_name: String(student.student_name || '').trim(),
        school: String(student.school || '').trim(),
        grade: String(student.grade || '').trim(),
        parent_phone: parentPhone,
        student_phone: studentPhone,
        sent_stages: sentStages,
        contact_status: sentStages.length ? sentStages.map(x => `${x.stage}분:${x.status || '-'}`).join(', ') : '미발송',
        risk: schedule.late_min >= 20 ? 'high' : schedule.late_min >= 5 ? 'medium' : 'low'
      };
      missingCount++;
      group.missing_count++;
      group.students.push(item);
      items.push(item);
    }

    groupsByClass.set(classId, group);
  }

  const groups = Array.from(groupsByClass.values())
    .filter(group => includeUpcoming || group.start_passed)
    .sort((a, b) => Number(b.missing_count || 0) - Number(a.missing_count || 0) || String(a.start || '').localeCompare(String(b.start || '')));

  items.sort((a, b) => Number(b.late_min || 0) - Number(a.late_min || 0) || String(a.class_id || '').localeCompare(String(b.class_id || '')) || String(a.student_name || '').localeCompare(String(b.student_name || '')));

  const out = {
    yyyymmdd,
    checked_at: now.toISOString(),
    source: 'class_schedule + today_student_state',
    realtime: true,
    refresh_sec: 10,
    schedule_count: (Array.isArray(scheduleData) ? scheduleData : []).length,
    active_schedule_count: scheduledRows.length,
    class_count: groups.length,
    roster_count: rosterCount,
    present_count: presentCount,
    missing_count: missingCount,
    excused_count: excusedCount,
    upcoming_count: upcomingCount,
    no_phone_count: noPhoneCount,
    groups,
    items
  };

  fastCacheSet(cacheKey, out, 8, 60);
  return success(out);
}


async function adminGetOpsOverviewDirect(sessionToken = '') {
  const auth = await requireRole(sessionToken, 'admin');
  if (!auth.ok) return auth.out;

  const overviewCacheKey = 'adminOpsOverview';
  const cachedOverview = fastCacheGet(overviewCacheKey);
  if (cachedOverview) return success({ ...cachedOverview, cache: { hit: true, ttl_sec: fastCacheSec('ops_overview', 20, 120) } });

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

  const out = {
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
  };

  fastCacheSet(overviewCacheKey, out, fastCacheSec('ops_overview', 20, 120));
  return success(out);
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
  const cacheKey = ['absenceExcuses', yyyymmdd || 'all', classId || 'all', sid || 'all'].join('|');
  const cached = fastCacheGet(cacheKey);
  if (cached) return success({ ...cached, cache: { hit: true, source: 'memory_fresh' } });

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

  const out = {
    count: items.length,
    items
  };
  fastCacheSet(cacheKey, out, fastCacheSec('absence_excuses', 10, 60), fastCacheStaleSec('absence_excuses', 120, 600));
  return success(out);
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
    return send(res, 200, { ok: true, data: { ...meta.data, qa_feature_matrix: buildSupportedOpsMeta() } });
  }

  if (op === 'meta.supportedOps') {
    return send(res, 200, { ok: true, data: buildSupportedOpsMeta() });
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

  if (op === 'studentToday.publicGet') {
    const result = await studentTodayPublicGetDirect(payload.args || {});
    return send(res, result.status, result.body);
  }

  if (op === 'admin.studentTodayLink.create') {
    const result = await adminStudentTodayLinkCreateDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.lectureAssignment.list') {
    const result = await adminLectureAssignmentListDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'lectureAssignment.list' || op === 'admin.onlineLecture.list') {
    const result = await adminLectureAssignmentListDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.lectureAssignment.save') {
    const result = await adminLectureAssignmentSaveDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'lectureAssignment.save' || op === 'admin.onlineLecture.save') {
    const result = await adminLectureAssignmentSaveDirect(payload.args || {}, sessionToken);
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

  if (op === 'admin.staffClock.listLogs') {
    const result = await adminListStaffClockLogsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.staffClock.saveManual') {
    const result = await adminSaveStaffClockManualDirect(payload.args || {}, sessionToken);
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

  if (op === 'clinic.todayBoard') {
    const result = await clinicTodayBoardDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.bulkUpdateStatus') {
    const result = await clinicBulkUpdateStatusDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.queueNotice') {
    const result = await clinicQueueNoticeDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'clinic.queueParentNotice') {
    const result = await clinicQueueParentNoticeDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordCatalog.list') {
    const result = await wordCatalogListDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordRecord.list') {
    const result = await wordRecordListDirect(payload.args || {}, sessionToken);
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

  if (op === 'wordTest.bulkEntry') {
    const result = await wordTestBulkEntryDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordTest.bulkEnterResults') {
    const result = await wordTestBulkEnterResultsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'wordTest.listResults') {
    const result = await wordTestListResultsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'report.previewStudentReport') {
    const result = await reportPreviewStudentReportDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'report.createSnapshot') {
    const result = await reportCreateSnapshotDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'report.listSnapshots') {
    const result = await reportListSnapshotsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'audit.searchLogs') {
    const result = await auditSearchLogsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.getClass') {
    const result = await adminMasterGetClassDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.upsertClass') {
    const result = await adminMasterUpsertClassDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.deleteClass') {
    const result = await adminMasterDeleteClassDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.searchStudents') {
    const result = await adminMasterSearchStudentsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.upsertStudent') {
    const result = await adminMasterUpsertStudentDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.addClassStudents') {
    const result = await adminMasterAddClassStudentsDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.master.removeClassStudent') {
    const result = await adminMasterRemoveClassStudentDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.central.classHolidays.list') { const result = await adminCentralClassHolidaysListDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.classHolidays.add') { const result = await adminCentralClassHolidayAddDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.classHolidays.remove') { const result = await adminCentralClassHolidayRemoveDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.globalHolidays.list') { const result = await adminCentralGlobalHolidaysListDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.globalHolidays.add') { const result = await adminCentralGlobalHolidayAddDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.globalHolidays.remove') { const result = await adminCentralGlobalHolidayRemoveDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.schedule.list') { const result = await adminCentralScheduleListDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.schedule.update') { const result = await adminCentralScheduleUpdateDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.schedule.rebuild') { const result = await adminCentralScheduleRebuildDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.staff.list') { const result = await adminCentralStaffListDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.staff.upsert') { const result = await adminCentralStaffUpsertDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.staff.phoneOnly') { const result = await adminCentralStaffPhoneOnlyDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.staff.toggle') { const result = await adminCentralStaffToggleDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.staff.resetSecret') { const result = await adminCentralStaffResetSecretDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.props.get') { const result = await adminCentralPropsGetDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.props.set') { const result = await adminCentralPropsSetDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }
  if (op === 'admin.central.selfCheck') { const result = await adminCentralSelfCheckDirect(payload.args || {}, sessionToken); return send(res, result.status, result.body); }

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


  if (op === 'admin.phoneIdentity.audit') {
    const result = await adminPhoneIdentityAuditDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'phoneIdentity.audit' || op === 'admin.phoneIdentityAudit') {
    const result = await adminPhoneIdentityAuditDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.finalReadiness') {
    const result = await adminFinalReadinessDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getOpsOverview') {
    const result = await adminGetOpsOverviewDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.todayAbsenceBoard') {
    const result = await assistantTodayAbsenceBoardDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.listAbsenceExcuses') {
    const result = await assistantListAbsenceExcusesDirect(payload.args || {}, sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.addAbsenceExcuse') {
    const result = await assistantUpsertAbsenceExcuseHybrid(payload.args || {}, sessionToken);
    if (result.body?.ok === true) fastCacheDelPrefix('absenceExcuses');
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.bulkAddAbsenceExcuses') {
    const result = await assistantBulkUpsertAbsenceExcusesDirect(payload.args || {}, sessionToken);
    if (result.body?.ok === true) fastCacheDelPrefix('absenceExcuses');
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.removeAbsenceExcuse') {
    const result = await assistantRemoveAbsenceExcuseHybrid(payload.args || {}, sessionToken);
    if (result.body?.ok === true) fastCacheDelPrefix('absenceExcuses');
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