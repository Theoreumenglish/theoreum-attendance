import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  assistantGetLogsDirect,
  assistantGetLogByTraceDirect,
  adminGetStaffMonthlySummaryDirect,
  adminGetStaffDailyDetailDirect
} from '../lib/rpc-direct-read.js';

const MAX_BODY_BYTES = 64 * 1024;
const RUNTIME_META_CACHE_TTL_MS = 3000;

let runtimeMetaCache = null;
let runtimeMetaCacheExp = 0;

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

function normalizeFloor(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === '5층') return '5F';
  if (text === '7층') return '7F';
  if (text === '5F' || text === '7F') return text;
  return '';
}

function normalizeYn(raw, fallback = 'N') {
  const text = String(raw == null ? fallback : raw).trim().toUpperCase();
  return text === 'Y' ? 'Y' : 'N';
}

function buildEnvMeta() {
  const kioskFloor = normalizeFloor(process.env.KIOSK_FLOOR || '5F') || '5F';
  const safeMode = normalizeYn(process.env.SAFE_MODE_DEFAULT || 'N');

  return {
    version: 'vercel-direct',
    tz: 'Asia/Seoul',
    kiosk_floor: kioskFloor,
    safe: {
      mode: safeMode,
      message: String(process.env.SAFE_MODE_MESSAGE || '').trim()
    },
    props_missing: [],
    staff_mode: '',
    disabled_ops: [],
    logo_url_set: false,
    logo_url_normalized: '',
    source: 'env'
  };
}

function isMissingRuntimeConfigTable(error) {
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();

  return (
    (message.includes('runtime_config') && message.includes('does not exist')) ||
    (details.includes('runtime_config') && details.includes('does not exist'))
  );
}

function applyRuntimeRowsToMeta(rows, baseMeta) {
  const next = {
    ...baseMeta,
    safe: { ...(baseMeta.safe || {}) },
    source: 'runtime_config'
  };

  for (const row of rows || []) {
    const key = String(row?.key || '').trim();
    const value = isPlainObject(row?.value_json) ? row.value_json : {};

    if (key === 'kiosk_floor') {
      const floor = normalizeFloor(value.value || value.kiosk_floor || '');
      if (floor) next.kiosk_floor = floor;
      continue;
    }

    if (key === 'safe_mode') {
      next.safe.mode = normalizeYn(value.mode || value.value || next.safe.mode || 'N');
      next.safe.message = String(value.message || '').trim();
    }
  }

  return next;
}

async function readRuntimeMeta(force = false) {
  const now = Date.now();
  if (!force && runtimeMetaCache && now < runtimeMetaCacheExp) {
    return { ok: true, data: runtimeMetaCache };
  }

  const envMeta = buildEnvMeta();
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('runtime_config')
    .select('key, value_json')
    .in('key', ['kiosk_floor', 'safe_mode']);

  if (error) {
    if (isMissingRuntimeConfigTable(error)) {
      runtimeMetaCache = envMeta;
      runtimeMetaCacheExp = now + RUNTIME_META_CACHE_TTL_MS;
      return { ok: true, data: envMeta };
    }

    return {
      ok: false,
      error: {
        code: 'DB_SELECT_FAILED',
        message: error.message || 'runtime_config 조회 실패'
      }
    };
  }

  const merged = applyRuntimeRowsToMeta(data || [], envMeta);
  runtimeMetaCache = merged;
  runtimeMetaCacheExp = now + RUNTIME_META_CACHE_TTL_MS;
  return { ok: true, data: merged };
}

function invalidateRuntimeMetaCache() {
  runtimeMetaCache = null;
  runtimeMetaCacheExp = 0;
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

async function upsertRuntimeConfig(supabase, row) {
  const { data, error } = await supabase
    .from('runtime_config')
    .upsert([row], { onConflict: 'key' })
    .select('key, value_json, updated_at, updated_by')
    .single();

  return { data, error };
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

  const kioskFloor = normalizeFloor(args.kiosk_floor || args.floor || args.kioskFloor || '');
  if (!kioskFloor || !['5F', '7F'].includes(kioskFloor)) {
    return fail(400, 'INVALID_INPUT', 'kiosk_floor는 5F 또는 7F여야 합니다.');
  }

  const supabase = getSupabaseAdmin();
  const { error } = await upsertRuntimeConfig(supabase, {
    key: 'kiosk_floor',
    value_json: { value: kioskFloor },
    updated_at: new Date().toISOString(),
    updated_by: auth.me.staff_id
  });

  if (error) {
    return fail(500, 'DB_UPSERT_FAILED', error.message || 'runtime_config kiosk_floor 저장 실패');
  }

  invalidateRuntimeMetaCache();

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

  const mode = normalizeYn(args.mode || args.safe_mode || args.safeMode || 'N');
  const message = String(args.message || args.safe_message || '').trim().slice(0, 200);

  const supabase = getSupabaseAdmin();
  const { error } = await upsertRuntimeConfig(supabase, {
    key: 'safe_mode',
    value_json: {
      mode,
      message
    },
    updated_at: new Date().toISOString(),
    updated_by: auth.me.staff_id
  });

  if (error) {
    return fail(500, 'DB_UPSERT_FAILED', error.message || 'runtime_config safe_mode 저장 실패');
  }

  invalidateRuntimeMetaCache();

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
    .select('student_id, student_name, is_exception, exception_note')
    .eq('student_id', sid)
    .maybeSingle();

  if (readErr) {
    return fail(500, 'DB_SELECT_FAILED', readErr.message || 'students 조회 실패');
  }

  if (!found) {
    return fail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');
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

  if (op === 'admin.getRuntimeConfig') {
    const result = await adminGetRuntimeConfigDirect(sessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.setKioskFloor') {
    const result = await adminSetKioskFloorDirect(payload.args || {}, sessionToken);
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