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
    .replace(/[^a-z0-9._\-\u3131-\u318E\uAC00-\uD7A3]/g, '')
    .slice(0, 80);
}

function normalizePhoneDigits(input) {
  return String(input || '').replace(/[^0-9]/g, '');
}

function normalizePhoneTail8(input) {
  const digits = normalizePhoneDigits(input);
  if (/^010\d{8}$/.test(digits)) return digits.slice(-8);
  if (/^\d{8}$/.test(digits)) return digits;
  return '';
}

function pickStaffPhone(row) {
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
    const digits = normalizePhoneDigits(c);
    if (/^010\d{8}$/.test(digits)) return digits;
  }

  return '';
}

function staffPhoneTailMatches(row, tail8) {
  const tail = normalizePhoneTail8(tail8);
  const phone = pickStaffPhone(row);
  return !!tail && !!phone && phone.slice(-8) === tail;
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


async function readStaffPhoneDirectoryRowsForClock() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('staff_phone_directory')
    .select('staff_id, name, role, status, revoked, staff_phone')
    .limit(1000);

  if (error) {
    return { data: [], error, table: 'staff_phone_directory' };
  }

  return { data: Array.isArray(data) ? data : [], error: null, table: 'staff_phone_directory' };
}

async function readStaffRowsForPhoneClock(tableName) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .limit(500);

  if (error) {
    return { data: [], error, table: tableName };
  }

  return { data: Array.isArray(data) ? data : [], error: null, table: tableName };
}

async function readStaffForPhoneClock(phoneTail8) {
  const tail = normalizePhoneTail8(phoneTail8);
  if (!tail) {
    return {
      data: null,
      error: null,
      code: 'BAD_PHONE_TAIL',
      message: '010을 제외한 휴대폰 번호 8자리를 입력하세요.'
    };
  }

  const sources = [];
  const directory = await readStaffPhoneDirectoryRowsForClock();
  if (!directory.error || isMissingTableError('staff_phone_directory', directory.error)) sources.push(...directory.data);
  else return { data: null, error: directory.error, code: 'DB_SELECT_FAILED' };

  const snap = await readStaffRowsForPhoneClock('staff_snapshot');
  if (!snap.error || isMissingTableError('staff_snapshot', snap.error)) sources.push(...snap.data);
  else return { data: null, error: snap.error, code: 'DB_SELECT_FAILED' };

  const staff = await readStaffRowsForPhoneClock('staff');
  if (!staff.error || isMissingTableError('staff', staff.error)) sources.push(...staff.data);
  else return { data: null, error: staff.error, code: 'DB_SELECT_FAILED' };

  const byId = new Map();
  for (const row of sources) {
    const staffId = normalizeStaffId(row?.staff_id);
    if (!staffId) continue;
    if (!staffPhoneTailMatches(row, tail)) continue;
    if (normalizeStatus(row?.status) !== 'active' || normalizeRevoked(row?.revoked) === 'Y') continue;
    if (!byId.has(staffId)) byId.set(staffId, row);
  }

  const matches = Array.from(byId.values());
  if (matches.length === 1) return { data: matches[0], error: null, code: 'OK' };
  if (matches.length > 1) {
    return {
      data: null,
      error: null,
      code: 'PHONE_AMBIGUOUS',
      message: '같은 휴대폰 끝 8자리의 재직 직원이 여러 명입니다. 관리자에게 문의하세요.',
      count: matches.length
    };
  }

  return {
    data: null,
    error: null,
    code: 'PHONE_NOT_FOUND',
    message: '등록된 직원 휴대폰 번호를 찾지 못했습니다. 관리자에게 문의하세요.'
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

  const phoneTail8 = normalizePhoneTail8(args.phone_tail8 || args.phoneTail8 || args.phone_tail || args.phoneTail || args.phone || '');

  if (phoneTail8) {
    const staffOut = await readStaffForPhoneClock(phoneTail8);
    if (staffOut.error) {
      return fail(500, 'DB_SELECT_FAILED', staffOut.error.message || '직원 휴대폰 번호 조회 실패');
    }
    if (!staffOut.data) {
      return fail(
        staffOut.code === 'PHONE_AMBIGUOUS' ? 409 : 404,
        staffOut.code || 'PHONE_NOT_FOUND',
        staffOut.message || '등록된 직원 휴대폰 번호를 찾지 못했습니다.',
        { phone_tail8: phoneTail8, count: staffOut.count || 0 }
      );
    }

    const staff = staffOut.data;
    const staffId = normalizeStaffId(staff.staff_id);
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
      input_mode: 'PHONE_LAST8'
    }, {
      recentDedupeSec: 5
    });

    if (!result.ok) {
      return fail(
        result.status || 500,
        result.error || 'SERVER_ERROR',
        result.detail || 'staff.clock phone 처리 실패'
      );
    }

    return success({
      ok: true,
      data: {
        ok: true,
        duplicate: !!result.duplicate,
        msg: result.duplicate ? '중복 입력 방지 (이미 처리됨)' : ('휴대폰 번호 근태 기록: ' + action),
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