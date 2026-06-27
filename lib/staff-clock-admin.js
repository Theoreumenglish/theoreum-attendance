import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';
import { authMeDirect } from './staff-auth.js';
import {
  writeStaffClockAndRollup,
  recalcStaffClockRollupsByDate
} from './staff-attendance.js';

const ROLE_LEVEL = {
  viewer: 0,
  assistant: 1,
  staff: 1,
  teacher: 2,
  admin: 4,
  owner: 4
};

function fail(status, code, message, detail = {}) {
  return { status, body: { ok: false, error: { code, message, detail } } };
}

function success(data) {
  return { status: 200, body: { ok: true, data } };
}

function roleAtLeast(role, need) {
  const r = String(role || '').trim().toLowerCase();
  const n = String(need || '').trim().toLowerCase();
  return (ROLE_LEVEL[r] || 0) >= (ROLE_LEVEL[n] || 0);
}

async function requireAdmin(sessionToken = '') {
  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });
  if (!me.loggedIn) return fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  if (!roleAtLeast(me.role, 'admin')) return fail(403, 'NO_PERMISSION', '원장 또는 관리자 권한이 필요합니다.');
  return me;
}

function normalizeStaffId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

function normalizeAction(input) {
  const v = String(input || '').trim().toUpperCase();
  return v === 'IN' || v === 'OUT' ? v : '';
}

function normalizeNote(input) {
  return String(input || '').trim().slice(0, 200);
}

function isStrictYmd(value) {
  return /^\d{8}$/.test(String(value || '').trim());
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (/^\d{4}$/.test(digits)) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function kstIsoFromYmdTime(yyyymmdd, timeText) {
  const ymd = String(yyyymmdd || '').trim();
  const hhmm = normalizeTime(timeText);
  if (!isStrictYmd(ymd) || !hhmm) return '';
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(3, 5));
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const utcMs = Date.UTC(y, m - 1, d, hour, minute, 0) - (9 * 60 * 60 * 1000);
  return new Date(utcMs).toISOString();
}

function ymdFromKstIso(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  const kst = new Date(ms + (9 * 60 * 60 * 1000));
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function utcRangeForKstYmd(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!isStrictYmd(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - (9 * 60 * 60 * 1000);
  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(startUtcMs + (24 * 60 * 60 * 1000)).toISOString()
  };
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

function isMissingTableError(tableName, error) {
  const table = String(tableName || '').toLowerCase();
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  return code === 'PGRST205' || message.includes('could not find the table') || message.includes(table) || details.includes(table);
}

async function readStaff(staffId) {
  const sid = normalizeStaffId(staffId);
  const supabase = getSupabaseAdmin();
  const cols = 'staff_id, name, role, status, revoked';

  const snap = await supabase.from('staff_snapshot').select(cols).eq('staff_id', sid).maybeSingle();
  if (!snap.error && snap.data) return { data: snap.data, error: null, source: 'staff_snapshot' };
  if (snap.error && !isMissingTableError('staff_snapshot', snap.error)) return { data: null, error: snap.error };

  const staff = await supabase.from('staff').select(cols).eq('staff_id', sid).maybeSingle();
  return { data: staff.data || null, error: staff.error || null, source: staff.data ? 'staff' : 'none' };
}

function mapClockLog(row) {
  return {
    ts: String(row?.ts || ''),
    staff_id: normalizeStaffId(row?.staff_id),
    name: String(row?.name || '').trim(),
    role: String(row?.role || '').trim(),
    action: String(row?.action || '').trim().toUpperCase(),
    input_mode: String(row?.input_mode || '').trim(),
    note: String(row?.note || '').trim(),
    trace_id: String(row?.trace_id || '').trim()
  };
}

export async function adminListStaffClockLogsDirect(args = {}, sessionToken = '') {
  const me = await requireAdmin(sessionToken);
  if (me && me.status) return me;

  const staffId = normalizeStaffId(args.staff_id || args.staffId);
  const yyyymmdd = isStrictYmd(args.yyyymmdd) ? String(args.yyyymmdd).trim() : '';
  if (!staffId || !yyyymmdd) return fail(400, 'INVALID_INPUT', 'staff_id와 yyyymmdd가 필요합니다.');

  const range = utcRangeForKstYmd(yyyymmdd);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('staff_clock_logs')
    .select('ts, staff_id, name, role, action, input_mode, note, trace_id')
    .eq('staff_id', staffId)
    .gte('ts', range.startIso)
    .lt('ts', range.endIso)
    .order('ts', { ascending: true });

  if (error) return fail(500, 'DB_SELECT_FAILED', error.message || 'staff_clock_logs 조회 실패');
  return success({ staff_id: staffId, yyyymmdd, count: Array.isArray(data) ? data.length : 0, items: (Array.isArray(data) ? data : []).map(mapClockLog) });
}

export async function adminSaveStaffClockManualDirect(args = {}, sessionToken = '') {
  const me = await requireAdmin(sessionToken);
  if (me && me.status) return me;

  const staffId = normalizeStaffId(args.staff_id || args.staffId);
  const action = normalizeAction(args.action);
  const yyyymmdd = isStrictYmd(args.yyyymmdd) ? String(args.yyyymmdd).trim() : '';
  const time = normalizeTime(args.time || args.hhmm || args.clock_time);
  const note = normalizeNote(args.note || '');
  const traceId = String(args.trace_id || args.traceId || '').trim().slice(0, 120);
  const ts = kstIsoFromYmdTime(yyyymmdd, time);

  if (!staffId || !action || !yyyymmdd || !time || !ts) {
    return fail(400, 'INVALID_INPUT', '직원 ID, 날짜, 시간, IN/OUT을 모두 확인하세요.');
  }

  const staffOut = await readStaff(staffId);
  if (staffOut.error) return fail(500, 'DB_SELECT_FAILED', staffOut.error.message || '직원 정보 조회 실패');
  if (!staffOut.data) return fail(404, 'NOT_FOUND', '직원 계정을 찾지 못했습니다.');

  const staff = staffOut.data;
  const name = String(staff.name || staffId).trim();
  const role = normalizeRole(staff.role || '');
  const supabase = getSupabaseAdmin();

  if (traceId) {
    const { data: before, error: readErr } = await supabase
      .from('staff_clock_logs')
      .select('ts, staff_id, name, role, action, input_mode, note, trace_id')
      .eq('trace_id', traceId)
      .maybeSingle();

    if (readErr) return fail(500, 'DB_SELECT_FAILED', readErr.message || '기존 출퇴근 로그 조회 실패');
    if (!before) return fail(404, 'NOT_FOUND', '수정할 출퇴근 로그를 찾지 못했습니다.');

    const oldStaffId = normalizeStaffId(before.staff_id);
    const oldYmd = ymdFromKstIso(before.ts);
    const row = {
      ts,
      staff_id: staffId,
      name,
      role,
      action,
      input_mode: 'ADMIN_EDIT',
      note: note ? `[관리자수정] ${note}` : '[관리자수정]',
      trace_id: traceId
    };

    const { data: updated, error: updErr } = await supabase
      .from('staff_clock_logs')
      .update(row)
      .eq('trace_id', traceId)
      .select()
      .single();

    if (updErr) return fail(500, 'DB_UPDATE_FAILED', updErr.message || '출퇴근 로그 수정 실패');

    const rollups = [];
    if (oldStaffId && oldYmd) rollups.push(await recalcStaffClockRollupsByDate(oldStaffId, oldYmd));
    if (oldStaffId !== staffId || oldYmd !== yyyymmdd) rollups.push(await recalcStaffClockRollupsByDate(staffId, yyyymmdd));
    else if (!rollups.length) rollups.push(await recalcStaffClockRollupsByDate(staffId, yyyymmdd));

    return success({ mode: 'edit', record: mapClockLog(updated), rollups });
  }

  const result = await writeStaffClockAndRollup({
    ts,
    staff_id: staffId,
    name,
    role,
    action,
    note: note ? `[관리자추가] ${note}` : '[관리자추가]',
    trace_id: `admin-manual-${Date.now().toString(36)}-${randomUUID()}`,
    input_mode: 'ADMIN_MANUAL'
  }, { recentDedupeSec: 0 });

  if (!result.ok) {
    return fail(result.status || 500, result.error || 'SERVER_ERROR', result.detail || '직원 수기 근태 저장 실패');
  }

  return success({ mode: 'add', record: mapClockLog(result.record), daily: result.daily || null, monthly: result.monthly || null });
}
