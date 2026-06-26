import { authMeDirect } from '../lib/staff-auth.js';
import { writeStaffClockAndRollup } from '../lib/staff-attendance.js';
import { verifyAdminPinByStaffId } from './_admin-pin.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

const ALLOWED_ACTIONS = new Set(['IN', 'OUT']);

function normalizeAction(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_ACTIONS.has(s) ? s : '';
}

function normalizeStaffId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

function normalizeRole(input) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return 'assistant';
  if (['assistant', 'staff', '조교'].includes(v)) return 'assistant';
  if (['teacher', '강사'].includes(v)) return 'teacher';
  if (['admin', '관리자'].includes(v)) return 'admin';
  if (['owner', '오너', '원장'].includes(v)) return 'owner';
  return v;
}

function normalizeStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'inactive';
  if (['active', '재직', '활성', 'enabled', '1', 'y', 'yes', 'true'].includes(v)) return 'active';
  if (['inactive', '비활성', '퇴사', 'disabled', '0', 'n', 'no', 'false'].includes(v)) return 'inactive';
  return 'inactive';
}

function normalizeRevoked(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return ['y', 'yes', '1', 'true', 'revoked', '중지', '해지', '퇴사'].includes(v) ? 'Y' : 'N';
}

function isMissingTableError(tableName, error) {
  const table = String(tableName || '').toLowerCase();
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();

  return (
    code === 'PGRST205' ||
    message.includes('could not find the table') ||
    message.includes(table + "'") ||
    message.includes(table + '"') ||
    details.includes(table)
  );
}

async function readStaffForPinClock(staffId) {
  const sid = normalizeStaffId(staffId);
  const supabase = getSupabaseAdmin();

  const { data: snap, error: snapErr } = await supabase
    .from('staff_snapshot')
    .select('staff_id, name, role, status, revoked')
    .eq('staff_id', sid)
    .maybeSingle();

  if (!snapErr && snap) {
    return { data: snap, error: null, source: 'staff_snapshot' };
  }

  if (snapErr && !isMissingTableError('staff_snapshot', snapErr)) {
    return { data: null, error: snapErr, source: 'staff_snapshot' };
  }

  const { data: staff, error: staffErr } = await supabase
    .from('staff')
    .select('staff_id, name, role, status, revoked')
    .eq('staff_id', sid)
    .maybeSingle();

  return {
    data: staff || null,
    error: staffErr || null,
    source: staff ? 'staff' : 'none'
  };
}

function normalizeInputMode(input) {
  const s = String(input || '').trim().toUpperCase();
  return ['WEB', 'QR', 'MANUAL'].includes(s) ? s : 'WEB';
}

function normalizeNote(input) {
  return String(input || '').trim().slice(0, 200);
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

function success(body) {
  return { status: 200, body };
}

export async function handleStaffClock(payload) {
  const args =
    payload?.args && typeof payload.args === 'object'
      ? payload.args
      : (payload && typeof payload === 'object' ? payload : {});
  const action = normalizeAction(args.action || args.type);
  const note = normalizeNote(args.note || '');
  const inputMode = normalizeInputMode(args.input_mode || 'WEB');
  const sessionToken = String(args.sessionToken || payload?.sessionToken || '').trim();
  const traceId = String(
    payload?.traceId ||
    payload?.trace_id ||
    args?.traceId ||
    args?.trace_id ||
    ('vercel-staffweb-' + Date.now().toString(36))
  ).trim();

  if (!action) {
    return fail(400, 'INVALID_INPUT', '허용되지 않는 action 입니다.');
  }

  const staffIdFromPin = normalizeStaffId(args.staff_id || args.staffId || args.id || '');
  const pin = String(args.pin || args.staff_pin || args.staffPin || '').trim();

  if (staffIdFromPin || pin) {
    if (!staffIdFromPin) return fail(400, 'INVALID_INPUT', '직원 ID가 필요합니다.');
    if (!pin) return fail(400, 'INVALID_INPUT', '직원 PIN이 필요합니다.');

    const pinCheck = await verifyAdminPinByStaffId(staffIdFromPin, pin);
    if (!pinCheck.ok) {
      return fail(
        pinCheck.error?.code === 'NOT_FOUND' ? 404 : 401,
        pinCheck.error?.code || 'AUTH_FAILED',
        pinCheck.error?.message || 'PIN 확인 실패'
      );
    }

    const { data: staff, error: staffErr } = await readStaffForPinClock(staffIdFromPin);
    if (staffErr) {
      return fail(500, 'DB_SELECT_FAILED', staffErr.message || '직원 정보 조회 실패');
    }
    if (!staff) {
      return fail(404, 'NOT_FOUND', '직원 계정을 찾지 못했습니다.');
    }
    if (normalizeStatus(staff.status) !== 'active' || normalizeRevoked(staff.revoked) === 'Y') {
      return fail(403, 'NOT_ACTIVE', '현재 사용 가능한 직원 계정이 아닙니다.');
    }

    const staffId = normalizeStaffId(staff.staff_id || staffIdFromPin);
    const role = normalizeRole(staff.role || '');
    const name = String(staff.name || staffId).trim();

    const result = await writeStaffClockAndRollup({
      ts: new Date().toISOString(),
      staff_id: staffId,
      name,
      role,
      action,
      note,
      trace_id: traceId,
      input_mode: 'PIN'
    }, {
      recentDedupeSec: 5
    });

    if (!result.ok) {
      return fail(
        result.status || 500,
        result.error || 'SERVER_ERROR',
        result.detail || 'staff.clock PIN 처리 실패'
      );
    }

    return success({
      ok: true,
      data: {
        ok: true,
        duplicate: !!result.duplicate,
        msg: result.duplicate ? '중복 입력 방지 (이미 처리됨)' : ('PIN 근태 기록: ' + action),
        staff_id: staffId,
        name,
        role
      },
      traceId,
      record: result.record || null,
      daily: result.daily || null,
      monthly: result.monthly || null
    });
  }

  const me = await authMeDirect(sessionToken, { touch: true });
  if (!me.loggedIn) {
    return fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  }

  const result = await writeStaffClockAndRollup({
    ts: new Date().toISOString(),
    staff_id: me.staff_id,
    name: me.name,
    role: me.role,
    action,
    note,
    trace_id: traceId,
    input_mode: inputMode
  }, {
    recentDedupeSec: 5
  });

  if (!result.ok) {
    return fail(
      result.status || 500,
      result.error || 'SERVER_ERROR',
      result.detail || 'staff.clock 처리 실패'
    );
  }

  return success({
    ok: true,
    data: {
      ok: true,
      duplicate: !!result.duplicate,
      msg: result.duplicate ? '중복 입력 방지 (이미 처리됨)' : ('근태 기록: ' + action),
      staff_id: me.staff_id,
      name: me.name,
      role: me.role
    },
    traceId,
    record: result.record || null,
    daily: result.daily || null,
    monthly: result.monthly || null
  });
}

function parseBody(req) {
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

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  let payload = {};
  try {
    payload = parseBody(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'BAD_JSON',
        message: '요청 JSON 형식이 올바르지 않습니다.'
      }
    });
  }

  try {
    const out = await handleStaffClock(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'staff.clock 처리 실패'
      }
    });
  }
}