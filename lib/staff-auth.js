import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_SESSION_TTL_SEC = 43200;
const DEFAULT_PIN_TTL_SEC = 600;
const PIN_LOCK_FAILS = 5;
const PIN_LOCK_SEC = 300;

function toPositiveInt(value, fallback, min = 1, max = 86400) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStaffId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
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

function permissions(role) {
  return {
    canViewLogs: hasRoleAtLeast(role, 'assistant'),
    canApprovePin: hasRoleAtLeast(role, 'assistant'),
    canManageAbsenceExcuse: hasRoleAtLeast(role, 'assistant'),
    canSetException: hasRoleAtLeast(role, 'teacher'),
    canAdmin: hasRoleAtLeast(role, 'admin')
  };
}

function roleKo(role) {
  const r = normalizeRole(role);
  if (r === 'assistant') return '조교';
  if (r === 'teacher') return '강사';
  if (r === 'admin') return '관리자';
  if (r === 'owner') return '오너';
  return '';
}

function getPepper() {
  const pepper = String(
    process.env.AUTH_PEPPER ||
    process.env.SYS_PEPPER ||
    ''
  ).trim();

  if (!pepper) {
    throw new Error('AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.');
  }

  return pepper;
}

function hashWithSalt(plain, salt) {
  const pepper = getPepper();
  let hashStr = String(plain || '') + '|' + String(salt || '') + '|' + pepper;

  for (let i = 0; i < 3000; i++) {
    hashStr = crypto.createHash('sha256').update(hashStr, 'utf8').digest('hex');
  }
  return hashStr;
}

function hashToken(raw) {
  return hashWithSalt(String(raw || ''), '');
}

function buildSessionToken() {
  return randomUUID().replace(/-/g, '');
}

async function findStaffSnapshot(supabase, staffId) {
  const sid = normalizeStaffId(staffId);

  const { data: snap, error: snapErr } = await supabase
    .from('staff_snapshot')
    .select('*')
    .eq('staff_id', sid)
    .maybeSingle();

  if (snapErr) {
    return { data: null, error: snapErr };
  }
  if (snap) {
    return { data: snap, error: null };
  }

  const { data: staff, error: staffErr } = await supabase
    .from('staff')
    .select('*')
    .eq('staff_id', sid)
    .maybeSingle();

  return { data: staff || null, error: staffErr || null };
}
async function findSessionByHash(supabase, sessionTokenHash) {
  const { data, error } = await supabase
    .from('staff_sessions')
    .select('*')
    .eq('session_token_hash', sessionTokenHash)
    .maybeSingle();

  return { data: data || null, error };
}

async function deleteSessionByHash(supabase, sessionTokenHash) {
  const { error } = await supabase
    .from('staff_sessions')
    .delete()
    .eq('session_token_hash', sessionTokenHash);

  return { error };
}

function loginFail(status, code, message) {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      error: { code, message }
    }
  };
}

function loginOk(data) {
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      data
    }
  };
}

function debugLoginFail(status, code, message, detail = {}) {
  return {
    ok: false,
    status,
    body: {
      ok: false,
      error: { code, message, detail }
    }
  };
}

export async function authLoginDirect(args = {}) {
  let pepperOk = true;
  try {
    getPepper();
  } catch (e) {
    pepperOk = false;
  }
  if (!pepperOk) {
    return debugLoginFail(500, 'CONFIG_REQUIRED', 'AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.', {
      stage: 'PEPPER_MISSING'
    });
  }

  const staffId = normalizeStaffId(args.staff_id || args.staffId || args.id || '');
  const password = String(args.password || args.pw || '').trim();

  if (!staffId || !password) {
    return debugLoginFail(400, 'INVALID_INPUT', '아이디/비밀번호가 필요합니다.', {
      stage: 'INPUT',
      hasStaffId: !!staffId,
      hasPassword: !!password
    });
  }

  const supabase = getSupabaseAdmin();

  const { data: staff, error: staffErr } = await findStaffSnapshot(supabase, staffId);
  if (staffErr) {
    return debugLoginFail(500, 'DB_SELECT_FAILED', staffErr.message || 'staff_snapshot 조회 실패', {
      stage: 'STAFF_SELECT',
      staffId
    });
  }

if (!staff) {
  let snapshotCount = null;
  let existsInStaffTable = null;
  let staffTableError = '';
  let supabaseHost = '';

  try {
    supabaseHost = new URL(String(process.env.SUPABASE_URL || '')).host;
  } catch (_) {
    supabaseHost = String(process.env.SUPABASE_URL || '');
  }

  try {
    const { count } = await supabase
      .from('staff_snapshot')
      .select('*', { count: 'exact', head: true });

    snapshotCount = typeof count === 'number' ? count : null;
  } catch (_) {}

  try {
    const { data: rawStaff, error: rawStaffErr } = await supabase
      .from('staff')
      .select('staff_id')
      .eq('staff_id', staffId)
      .maybeSingle();

    if (rawStaffErr) {
      staffTableError = rawStaffErr.message || 'staff 조회 실패';
    } else {
      existsInStaffTable = !!rawStaff;
    }
  } catch (e) {
    staffTableError = e?.message || 'staff 조회 실패';
  }

  return debugLoginFail(401, 'AUTH_FAIL', '아이디 또는 비밀번호를 확인해주세요.', {
    stage: 'NO_STAFF',
    staffId,
    supabaseHost,
    snapshotCount,
    existsInStaffTable,
    staffTableError
  });
}

  const status = normalizeStatus(staff.status);
  const revoked = normalizeRevoked(staff.revoked);

  if (status !== 'active' || revoked === 'Y') {
    return debugLoginFail(401, 'AUTH_FAIL', '아이디 또는 비밀번호를 확인해주세요.', {
      stage: 'INACTIVE_OR_REVOKED',
      staffId,
      status,
      revoked
    });
  }

  const pwHash = String(staff.pw_hash || '').trim();
  const pwSalt = String(staff.pw_salt || '').trim();

  if (!pwHash || !pwSalt) {
    return debugLoginFail(500, 'STAFF_SCHEMA_ERROR', 'staff_snapshot 비밀번호 해시/salt가 비어 있습니다.', {
      stage: 'MISSING_HASH_OR_SALT',
      staffId,
      hasPwHash: !!pwHash,
      hasPwSalt: !!pwSalt
    });
  }

  const computedHash = hashWithSalt(password, pwSalt);
  const ok = computedHash === pwHash;

  if (!ok) {
    return debugLoginFail(401, 'AUTH_FAIL', '아이디 또는 비밀번호를 확인해주세요.', {
      stage: 'HASH_MISMATCH',
      staffId,
      status,
      revoked,
      hasPwHash: !!pwHash,
      hasPwSalt: !!pwSalt,
      computedHashPreview: computedHash.slice(0, 12),
      storedHashPreview: pwHash.slice(0, 12)
    });
  }

  const sessionToken = buildSessionToken();
  const sessionTokenHash = hashToken(sessionToken);
  const ttlSec = toPositiveInt(process.env.SESSION_TTL_SEC, DEFAULT_SESSION_TTL_SEC, 1800, 604800);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  const { error: insErr } = await supabase
    .from('staff_sessions')
    .upsert([{
      session_token_hash: sessionTokenHash,
      staff_id: staffId,
      expires_at: expiresAt,
      created_at: nowIso(),
      last_seen_at: nowIso(),
      revoked_at: null
    }], { onConflict: 'session_token_hash' });

  if (insErr) {
    return debugLoginFail(500, 'DB_INSERT_FAILED', insErr.message || 'staff_sessions insert 실패', {
      stage: 'SESSION_INSERT',
      staffId
    });
  }

  const role = normalizeRole(staff.role);
  return loginOk({
    loggedIn: true,
    sessionToken,
    staff: {
      staff_id: staffId,
      name: String(staff.name || staffId),
      role
    },
    role,
    role_ko: roleKo(role),
    permissions: permissions(role)
  });
}

export async function authMeDirect(rawToken, options = {}) {
  const token = String(rawToken || '').trim();
  if (!token) {
    return {
      loggedIn: false
    };
  }

  let tokenHash = '';
  try {
    tokenHash = hashToken(token);
  } catch (_) {
    return { loggedIn: false };
  }

  const supabase = getSupabaseAdmin();

  const { data: sess, error: sessErr } = await findSessionByHash(supabase, tokenHash);
  if (sessErr || !sess) return { loggedIn: false };

  if (sess.revoked_at) {
    await deleteSessionByHash(supabase, tokenHash);
    return { loggedIn: false };
  }

  const expMs = Date.parse(String(sess.expires_at || ''));
  if (!Number.isFinite(expMs) || Date.now() > expMs) {
    await deleteSessionByHash(supabase, tokenHash);
    return { loggedIn: false };
  }

  const staffId = normalizeStaffId(sess.staff_id || '');
  if (!staffId) return { loggedIn: false };

  const { data: staff, error: staffErr } = await findStaffSnapshot(supabase, staffId);
  if (staffErr || !staff) {
    await deleteSessionByHash(supabase, tokenHash);
    return { loggedIn: false };
  }

  const status = normalizeStatus(staff.status);
  const revoked = normalizeRevoked(staff.revoked);
  if (status !== 'active' || revoked === 'Y') {
    await deleteSessionByHash(supabase, tokenHash);
    return { loggedIn: false };
  }

  if (options.touch !== false) {
    await supabase
      .from('staff_sessions')
      .update({ last_seen_at: nowIso() })
      .eq('session_token_hash', tokenHash);
  }

  const role = normalizeRole(staff.role);
  return {
    loggedIn: true,
    staff_id: staffId,
    name: String(staff.name || staffId),
    role,
    role_ko: roleKo(role),
    permissions: permissions(role)
  };
}

export async function authLogoutDirect(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, data: { ok: true } }
    };
  }

  let tokenHash = '';
  try {
    tokenHash = hashToken(token);
  } catch (_) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, data: { ok: true } }
    };
  }

  const supabase = getSupabaseAdmin();
  await deleteSessionByHash(supabase, tokenHash);

  return {
    ok: true,
    status: 200,
    body: { ok: true, data: { ok: true } }
  };
}

async function readPinAttempt(supabase, staffId, studentId) {
  const { data, error } = await supabase
    .from('kiosk_pin_attempts')
    .select('*')
    .eq('staff_id', staffId)
    .eq('student_id', studentId)
    .maybeSingle();

  return { data: data || null, error };
}

async function upsertPinAttempt(supabase, row) {
  const { error } = await supabase
    .from('kiosk_pin_attempts')
    .upsert([row], { onConflict: 'staff_id,student_id' });

  return { error };
}

async function clearPinAttempt(supabase, staffId, studentId) {
  const { error } = await supabase
    .from('kiosk_pin_attempts')
    .delete()
    .eq('staff_id', staffId)
    .eq('student_id', studentId);

  return { error };
}

export async function approveKioskPinDirect(args = {}, traceId = '') {
  const sessionToken = String(args.sessionToken || '').trim();
  const pin = String(args.pin || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');

  const me = await authMeDirect(sessionToken, { touch: true });
  if (!me.loggedIn) {
    return loginFail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  }
  if (!hasRoleAtLeast(me.role, 'assistant')) {
    return loginFail(403, 'NO_PERMISSION', '조교 이상 권한이 필요합니다.');
  }

  if (!pin) return loginFail(400, 'INVALID_INPUT', 'PIN이 필요합니다.');
  if (!sid) return loginFail(400, 'INVALID_INPUT', '학번 4자리가 필요합니다.');

  const supabase = getSupabaseAdmin();

  const { data: student, error: stuErr } = await supabase
    .from('students')
    .select('student_id, is_exception')
    .eq('student_id', sid)
    .maybeSingle();

  if (stuErr) return loginFail(500, 'DB_SELECT_FAILED', stuErr.message || 'students 조회 실패');
  if (!student) return loginFail(404, 'NOT_FOUND', '학생을 찾지 못했습니다.');

  const isException = String(student.is_exception || '').trim().toUpperCase() === 'Y';
  if (!isException) {
    return loginFail(400, 'NOT_EXCEPTION', '예외 등록된 학생만 학번으로 등/하원할 수 있습니다.');
  }

  const { data: staff, error: staffErr } = await findStaffSnapshot(supabase, me.staff_id);
  if (staffErr) return loginFail(500, 'DB_SELECT_FAILED', staffErr.message || 'staff_snapshot 조회 실패');
  if (!staff) return loginFail(401, 'AUTH_FAILED', '직원 계정을 확인할 수 없습니다.');

  const { data: attempt, error: atErr } = await readPinAttempt(supabase, me.staff_id, sid);
  if (atErr) return loginFail(500, 'DB_SELECT_FAILED', atErr.message || 'PIN 시도 조회 실패');

  const lockedUntilMs = attempt?.locked_until ? Date.parse(String(attempt.locked_until)) : 0;
  if (lockedUntilMs && Date.now() < lockedUntilMs) {
    return loginFail(429, 'AUTH_LOCKED', 'PIN 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  }

  const salt = String(staff.pin_salt || '').trim();
  const hash = String(staff.pin_hash || '').trim();
  if (!salt || !hash) {
    return loginFail(401, 'AUTH_FAILED', 'PIN이 설정되지 않은 계정입니다.');
  }

  const ok = hashWithSalt(pin, salt) === hash;
  if (!ok) {
    const nextFails = Number(attempt?.fail_count || 0) + 1;
    const lock = nextFails >= PIN_LOCK_FAILS
      ? new Date(Date.now() + PIN_LOCK_SEC * 1000).toISOString()
      : null;

    const { error: upErr } = await upsertPinAttempt(supabase, {
      staff_id: me.staff_id,
      student_id: sid,
      fail_count: nextFails,
      locked_until: lock,
      updated_at: nowIso()
    });

    if (upErr) return loginFail(500, 'DB_UPSERT_FAILED', upErr.message || 'PIN 시도 저장 실패');
    return loginFail(401, 'AUTH_FAILED', 'PIN이 올바르지 않습니다.');
  }

  const { error: clearErr } = await clearPinAttempt(supabase, me.staff_id, sid);
  if (clearErr) return loginFail(500, 'DB_DELETE_FAILED', clearErr.message || 'PIN 시도 초기화 실패');

  const ttlSec = toPositiveInt(process.env.PIN_APPROVE_TTL_SEC, DEFAULT_PIN_TTL_SEC, 60, 3600);
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();

  const { error: appErr } = await supabase
    .from('kiosk_pin_approvals')
    .upsert([{
      student_id: sid,
      approved_by: me.staff_id,
      approved_role: me.role,
      trace_id: String(traceId || '').trim(),
      approved_at: nowIso(),
      expires_at: expiresAt
    }], { onConflict: 'student_id' });

  if (appErr) return loginFail(500, 'DB_UPSERT_FAILED', appErr.message || 'PIN 승인 저장 실패');

  return loginOk({
    ok: true,
    student_id: sid,
    ttlSec
  });
}

export async function hasValidPinApproval(studentId) {
  const sid = normalizeStudentId(studentId);
  if (!sid) return false;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('kiosk_pin_approvals')
    .select('student_id, expires_at')
    .eq('student_id', sid)
    .gt('expires_at', nowIso())
    .maybeSingle();

  if (error) throw new Error(error.message || 'PIN 승인 조회 실패');
  return !!data;
}