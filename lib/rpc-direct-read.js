import { getSupabaseAdmin } from './supabase-admin.js';
import { authMeDirect } from './staff-auth.js';

const ROLE_LEVEL = {
  viewer: 0,
  assistant: 1,
  staff: 1,
  teacher: 2,
  admin: 4,
  owner: 4
};

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

function roleAtLeast(role, need) {
  const r = String(role || '').trim().toLowerCase();
  const n = String(need || '').trim().toLowerCase();
  return (ROLE_LEVEL[r] || 0) >= (ROLE_LEVEL[n] || 0);
}

async function requireRole(sessionToken, needRole) {
  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });

  if (!me.loggedIn) {
    return fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  }

  if (!roleAtLeast(me.role, needRole)) {
    return fail(
      403,
      'NO_PERMISSION',
      needRole === 'admin' ? '관리자 권한이 필요합니다.' : '조교 이상 권한이 필요합니다.'
    );
  }

  return me;
}

function toPositiveInt(value, fallback, min = 1, max = 800) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeStudentId(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

function normalizeStaffId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

function isStrictYmd(v) {
  return /^\d{8}$/.test(String(v || '').trim());
}

function isStrictYyyymm(v) {
  return /^\d{6}$/.test(String(v || '').trim());
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

function kstYyyymm(date = new Date()) {
  return kstYmd(date).slice(0, 6);
}

function nextYyyymm(yyyymm) {
  const s = String(yyyymm || '').trim();
  if (!/^\d{6}$/.test(s)) return '';
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const next = new Date(Date.UTC(y, m, 1));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

function parseMetaJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

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

function mapAttendLogRow(row) {
  const meta = parseMetaJson(row?.meta_json);
  let finalReason = String(row?.deny_reason || '').trim();

  if (String(row?.result || '').trim().toUpperCase() === 'OK' && meta.source_trace_id) {
    finalReason =
      '[수동정정] 원본: ' +
      String(meta.source_trace_id || '') +
      ' / 사유: ' +
      String(meta.reason || '');
  }

  return {
    ts: String(row?.ts || ''),
    student_id: normalizeStudentId(row?.student_id),
    action_type: String(row?.action_type || ''),
    kiosk_floor: String(row?.kiosk_floor || ''),
    result: String(row?.result || ''),
    qr_id: String(row?.qr_id || ''),
    input_mode: String(meta.input_mode || ''),
    exception: String(meta.exception || ''),
    deny_reason: finalReason,
    trace_id: String(row?.trace_id || '')
  };
}

export async function assistantGetLogsDirect(args = {}, sessionToken = '') {
  const me = await requireRole(sessionToken, 'assistant');
  if (me && me.status) return me;

  const supabase = getSupabaseAdmin();
  const yyyymmdd = isStrictYmd(args.yyyymmdd) ? String(args.yyyymmdd).trim() : kstYmd(new Date());
  const studentId = args.student_id ? normalizeStudentId(args.student_id) : '';
  const limit = toPositiveInt(args.limit, 200, 1, 800);

  let query = supabase
    .from('attendance_logs')
    .select('ts, yyyymmdd, student_id, action_type, kiosk_floor, meta_json, result, deny_reason, qr_id, trace_id')
    .eq('yyyymmdd', yyyymmdd)
    .order('ts', { ascending: false })
    .limit(limit);

  if (studentId) {
    query = query.eq('student_id', studentId);
  }

  const { data, error } = await query;

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'attendance_logs 조회 실패');
  }

  const logs = (Array.isArray(data) ? data : []).map(mapAttendLogRow);

  return success({
    count: logs.length,
    logs
  });
}

export async function assistantGetLogByTraceDirect(args = {}, sessionToken = '') {
  const me = await requireRole(sessionToken, 'assistant');
  if (me && me.status) return me;

  const traceId = String(args.trace_id || '').trim();
  if (!traceId) {
    return fail(400, 'INVALID_INPUT', 'trace_id가 필요합니다.');
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('attendance_logs')
    .select('ts, yyyymmdd, student_id, action_type, kiosk_floor, meta_json, result, deny_reason, qr_id, trace_id')
    .eq('trace_id', traceId)
    .maybeSingle();

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'trace 로그 조회 실패');
  }

  if (!data) {
    return success({});
  }

  return success(mapAttendLogRow(data));
}

export async function adminGetStaffMonthlySummaryDirect(args = {}, sessionToken = '') {
  const me = await requireRole(sessionToken, 'admin');
  if (me && me.status) return me;

  const yyyymm = isStrictYyyymm(args.yyyymm) ? String(args.yyyymm).trim() : kstYyyymm(new Date());
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('staff_monthly')
    .select('*')
    .eq('yyyymm', yyyymm)
    .order('name', { ascending: true });

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'staff_monthly 조회 실패');
  }

  const items = Array.isArray(data) ? data : [];

  return success({
    yyyymm,
    count: items.length,
    items
  });
}

export async function adminGetStaffDailyDetailDirect(args = {}, sessionToken = '') {
  const me = await requireRole(sessionToken, 'admin');
  if (me && me.status) return me;

  const yyyymm = isStrictYyyymm(args.yyyymm) ? String(args.yyyymm).trim() : kstYyyymm(new Date());
  const staffId = normalizeStaffId(args.staff_id);

  if (!staffId) {
    return fail(400, 'INVALID_INPUT', 'staff_id 필요');
  }

  const monthEnd = nextYyyymm(yyyymm);
  if (!monthEnd) {
    return fail(400, 'INVALID_INPUT', 'yyyymm 형식이 올바르지 않습니다.');
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('staff_daily')
    .select('*')
    .eq('staff_id', staffId)
    .gte('yyyymmdd', `${yyyymm}01`)
    .lt('yyyymmdd', `${monthEnd}01`)
    .order('yyyymmdd', { ascending: true });

  if (error) {
    return fail(500, 'DB_SELECT_FAILED', error.message || 'staff_daily 조회 실패');
  }

  const items = Array.isArray(data) ? data : [];

  return success({
    yyyymm,
    staff_id: staffId,
    count: items.length,
    items
  });
}