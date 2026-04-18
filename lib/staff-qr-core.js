import crypto from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

function nowMs() {
  return Date.now();
}

function positiveInt(value, fallback, min = 1, max = 86400) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cfg() {
  return {
    stepMs: positiveInt(process.env.STAFF_QR_FRAME_STEP_MS, 10000, 4000, 20000),
    graceMs: positiveInt(process.env.STAFF_QR_GRACE_MS, 30000, 5000, 60000),
    sessionTtlSec: positiveInt(process.env.STAFF_QR_SESSION_TTL_SEC, 180, 60, 600),
    verifySharedSecret: String(process.env.STAFF_QR_VERIFY_SHARED_SECRET || '').trim(),
    qrHmacSecret: String(process.env.STAFF_QR_HMAC_SECRET || '').trim()
  };
}

function normalizeStaffId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
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

function isActiveStaffRecord(staff) {
  return normalizeStatus(staff?.status) === 'active' && normalizeRevoked(staff?.revoked) !== 'Y';
}

function randomId(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function secureEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function getPepper() {
  const pepper = String(
    process.env.AUTH_PEPPER ||
    process.env.SYS_PEPPER ||
    ''
  ).trim();

  if (!pepper) throw new Error('AUTH_PEPPER 또는 SYS_PEPPER 필요');
  return pepper;
}

function hashWithSalt(plain, salt) {
  let hashStr = String(plain || '') + '|' + String(salt || '') + '|' + getPepper();
  for (let i = 0; i < 3000; i++) {
    hashStr = crypto.createHash('sha256').update(hashStr, 'utf8').digest('hex');
  }
  return hashStr;
}

function hmacB64Url(msg) {
  const secret = cfg().qrHmacSecret;
  if (!secret) throw new Error('STAFF_QR_HMAC_SECRET 필요');
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(String(msg || ''), 'utf8'))
    .digest('base64url');
}

function ok(data) {
  return { ok: true, data };
}

function err(code, message, detail = {}) {
  return { ok: false, error: { code, message, detail } };
}

async function maybePurgeExpired(supabase, chance = 0) {
  const p = Number(chance);
  if (!(p >= 1) && Math.random() >= p) return;

  const now = nowMs();

  await supabase
    .from('staff_qr_sessions')
    .delete()
    .lt('exp_ms', now);

  await supabase
    .from('staff_qr_nonces')
    .delete()
    .lt('exp_ms', now);
}

async function getStaffById(supabase, staffId) {
  const { data, error } = await supabase
    .from('staff_snapshot')
    .select('staff_id, name, role, revoked, status, pin_hash, pin_salt')
    .eq('staff_id', normalizeStaffId(staffId))
    .maybeSingle();

  if (error) throw new Error(error.message || 'staff_snapshot 조회 실패');
  return data || null;
}

async function rateLimitStart(supabase, staffId) {
  const { data, error } = await supabase
    .from('kiosk_pin_attempts')
    .select('*')
    .eq('staff_id', normalizeStaffId(staffId))
    .eq('student_id', '__STAFF_QR_START__')
    .maybeSingle();

  if (error) throw new Error(error.message || '시도 횟수 조회 실패');

  const lockedUntilMs = data?.locked_until ? Date.parse(String(data.locked_until)) : 0;
  if (lockedUntilMs && nowMs() < lockedUntilMs) {
    return { ok: false, code: 'AUTH_LOCKED', message: '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' };
  }

  return { ok: true, row: data || null };
}

async function recordStartFail(supabase, staffId, failCount) {
  const lockUntil = failCount >= 5
    ? new Date(Date.now() + 300 * 1000).toISOString()
    : null;

  const { error } = await supabase
    .from('kiosk_pin_attempts')
    .upsert([{
      staff_id: normalizeStaffId(staffId),
      student_id: '__STAFF_QR_START__',
      fail_count: failCount,
      locked_until: lockUntil,
      updated_at: new Date().toISOString()
    }], { onConflict: 'staff_id,student_id' });

  if (error) throw new Error(error.message || '시도 횟수 저장 실패');
}

async function clearStartFail(supabase, staffId) {
  const { error } = await supabase
    .from('kiosk_pin_attempts')
    .delete()
    .eq('staff_id', normalizeStaffId(staffId))
    .eq('student_id', '__STAFF_QR_START__');

  if (error) throw new Error(error.message || '시도 횟수 초기화 실패');
}

export async function staffQrSessionStart(args) {
  const supabase = getSupabaseAdmin();
  await maybePurgeExpired(supabase, 1);

  const staffId = normalizeStaffId(args?.staff_id);
  const pin = String(args?.pin || '').replace(/[^0-9]/g, '').slice(0, 8);

  if (!staffId) return err('INVALID_INPUT', '직원 아이디를 입력해주세요.');
  if (!/^[a-z0-9._-]{2,40}$/.test(staffId)) return err('INVALID_INPUT', '직원 아이디 형식이 올바르지 않습니다.');
  if (!/^\d{4,8}$/.test(pin)) return err('INVALID_INPUT', 'PIN은 숫자 4~8자리여야 합니다.');

  const rl = await rateLimitStart(supabase, staffId);
  if (!rl.ok) return err(rl.code, rl.message);

  const staff = await getStaffById(supabase, staffId);
  const currentFails = Number(rl.row?.fail_count || 0);

  if (!staff) {
    await recordStartFail(supabase, staffId, currentFails + 1);
    return err('AUTH_FAILED', '직원 아이디 또는 PIN을 확인해주세요.');
  }

  if (!isActiveStaffRecord(staff)) {
    return err('NOT_ALLOWED', '현재 QR 발급이 허용되지 않습니다. 관리자에게 문의해주세요.');
  }

  const pinHash = String(staff.pin_hash || '').trim();
  const pinSalt = String(staff.pin_salt || '').trim();

  if (!pinHash || !pinSalt) {
    return err('PIN_REQUIRED', '직원 PIN이 설정되어 있지 않습니다. 관리자에게 문의해주세요.');
  }

  const okPin = hashWithSalt(pin, pinSalt) === pinHash;
  if (!okPin) {
    await recordStartFail(supabase, staffId, currentFails + 1);
    return err('AUTH_FAILED', '직원 아이디 또는 PIN을 확인해주세요.');
  }

  await clearStartFail(supabase, staffId);

  const token = randomId(16);
  const publicSessionId = randomId(16);
  const now = nowMs();
  const exp = now + (cfg().sessionTtlSec * 1000);

  await supabase
    .from('staff_qr_sessions')
    .delete()
    .eq('staff_id', staffId);

  const { error: insErr } = await supabase
    .from('staff_qr_sessions')
    .insert([{
      token,
      staff_id: staffId,
      public_session_id: publicSessionId,
      exp_ms: exp,
      staff_name: String(staff.name || ''),
      role: normalizeRole(staff.role || '')
    }]);

  if (insErr) return err('DB_INSERT_FAILED', insErr.message || 'staff_qr_sessions insert 실패');

  return ok({
    sessionToken: token,
    staff_id: staffId,
    staff_name: String(staff.name || ''),
    role: normalizeRole(staff.role || ''),
    stepMs: cfg().stepMs,
    sessionExpAt: exp,
    serverNow: now
  });
}

export async function staffQrSessionFrame(args) {
  const supabase = getSupabaseAdmin();
  await maybePurgeExpired(supabase, 0.02);

  const token = String(args?.sessionToken || args?.token || '').trim();
  if (!token) return err('INVALID_INPUT', 'sessionToken 필요');

  const { data: session, error: sessErr } = await supabase
    .from('staff_qr_sessions')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (sessErr) return err('DB_SELECT_FAILED', sessErr.message || 'staff_qr_sessions 조회 실패');
  if (!session) return err('SESSION_NOT_FOUND', '세션을 찾지 못했습니다.');

  const now = nowMs();
  const exp = Number(session.exp_ms || 0);
  if (now >= exp) {
    await supabase.from('staff_qr_sessions').delete().eq('token', token);
    return err('SESSION_EXPIRED', '세션이 만료되었습니다.');
  }

  const { data: cachedNonce, error: cachedErr } = await supabase
    .from('staff_qr_nonces')
    .select('*')
    .eq('staff_id', String(session.staff_id || '').trim())
    .eq('public_session_id', String(session.public_session_id || '').trim())
    .eq('used', false)
    .gt('exp_ms', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cachedErr) return err('DB_SELECT_FAILED', cachedErr.message || 'staff_qr_nonces 조회 실패');

  let nonce = '';
  let frameExp = exp;
  if (cachedNonce) {
    nonce = String(cachedNonce.nonce || '').trim();
    frameExp = Number(cachedNonce.exp_ms || exp);
  } else {
    nonce = randomId(16);
    frameExp = exp;

    const { error: nonceErr } = await supabase
      .from('staff_qr_nonces')
      .insert([{
        nonce,
        staff_id: String(session.staff_id || '').trim(),
        public_session_id: String(session.public_session_id || '').trim(),
        exp_ms: frameExp,
        used: false
      }]);

    if (nonceErr) return err('DB_INSERT_FAILED', nonceErr.message || 'staff_qr_nonces insert 실패');
  }

  const payloadObj = {
    v: 1,
    t: 'staff',
    i: String(session.staff_id || '').trim(),
    u: String(session.public_session_id || '').trim(),
    n: nonce,
    e: frameExp
  };

  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sigB64 = hmacB64Url(payloadB64);
  const qrText = 'STAFFQR1.v1.' + payloadB64 + '.' + sigB64;

  return ok({
    qrText,
    rotateAt: exp,
    expiresAt: frameExp,
    serverNow: now
  });
}

export async function staffQrVerify(args) {
  const supabase = getSupabaseAdmin();
  await maybePurgeExpired(supabase, 0.02);

  const shared = String(args?.shared_secret || args?.verify_secret || '').trim();
  const expected = cfg().verifySharedSecret;

  if (!expected) return err('CONFIG_REQUIRED', 'STAFF_QR_VERIFY_SHARED_SECRET 필요');
  if (!secureEqual(shared, expected)) return err('CALLER_AUTH_FAILED', '호출 인증 실패');

  const consume = String(args?.consume || 'Y').trim().toUpperCase() === 'Y';
  let token = String(args?.qrText || '').trim();
  if (!token) return err('INVALID_INPUT', 'qrText 필요');

  if (/^STAFFQR1\./i.test(token)) {
    token = token.replace(/^STAFFQR1\./i, '');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return err('BAD_FORMAT', 'QR 포맷 오류');
  }

  const payloadB64 = parts[1];
  const sigB64 = parts[2];
  const expect = hmacB64Url(payloadB64);
  if (!secureEqual(sigB64, expect)) return err('BAD_SIG', '서명 불일치');

  let obj;
  try {
    obj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return err('BAD_PAYLOAD', '페이로드 파싱 실패');
  }

  const staffId = normalizeStaffId(obj?.i);
  const publicSessionId = String(obj?.u || '').trim();
  const nonce = String(obj?.n || '').trim();
  const frameExp = Number(obj?.e || 0);
  const qrType = String(obj?.t || '').trim();

  if (Number(obj?.v || 0) !== 1) return err('BAD_PAYLOAD', '지원하지 않는 QR 버전');
  if (qrType !== 'staff') return err('BAD_PAYLOAD', '직원 QR 타입이 아닙니다.');
  if (!staffId) return err('BAD_STAFF_ID', '직원 아이디 오류');
  if (!publicSessionId) return err('BAD_PAYLOAD', '세션 정보 없음');
  if (!nonce) return err('BAD_NONCE', 'nonce 없음');

  const staff = await getStaffById(supabase, staffId);
  if (!staff) return err('NOT_FOUND', '직원 계정을 찾지 못했습니다.');
  if (!isActiveStaffRecord(staff)) return err('NOT_ALLOWED', '현재 사용 가능한 직원 QR이 아닙니다.');

  const now = nowMs();
  if (now > frameExp) return err('EXPIRED', '만료된 QR');

  const { data: issued, error: nonceErr } = await supabase
    .from('staff_qr_nonces')
    .select('*')
    .eq('nonce', nonce)
    .maybeSingle();

  if (nonceErr) return err('DB_SELECT_FAILED', nonceErr.message || 'staff_qr_nonces 조회 실패');
  if (!issued) return err('NOT_ISSUED', '발급되지 않았거나 만료된 QR');

  if (String(issued.public_session_id || '') !== publicSessionId) return err('MISMATCH', '세션 불일치');
  if (normalizeStaffId(issued.staff_id || '') !== staffId) return err('MISMATCH', 'nonce 불일치');
  if (Number(issued.exp_ms || 0) !== frameExp) return err('MISMATCH', '만료시각 불일치');

  const { data: currentSession, error: sessErr } = await supabase
    .from('staff_qr_sessions')
    .select('*')
    .eq('staff_id', staffId)
    .eq('public_session_id', publicSessionId)
    .maybeSingle();

  if (sessErr) return err('DB_SELECT_FAILED', sessErr.message || 'staff_qr_sessions 조회 실패');
  if (!currentSession) return err('SESSION_EXPIRED', '이미 새 세션으로 교체된 QR입니다.');
  if (Number(currentSession.exp_ms || 0) < now) return err('SESSION_EXPIRED', '이미 새 세션으로 교체된 QR입니다.');

  if (!consume) {
    if (issued.used) return err('REPLAY', '이미 사용된 QR');
    return ok({
      qr_type: 'staff',
      staff_id: staffId,
      staff_name: String(staff.name || ''),
      role: normalizeRole(staff.role || ''),
      expiresAt: frameExp,
      verifiedAt: now,
      consumed: false
    });
  }

  const { data: updated, error: updErr } = await supabase
    .from('staff_qr_nonces')
    .update({ used: true })
    .eq('nonce', nonce)
    .eq('used', false)
    .select('nonce')
    .maybeSingle();

  if (updErr) return err('DB_UPDATE_FAILED', updErr.message || 'nonce consume 실패');
  if (!updated) return err('REPLAY', '이미 사용된 QR');

  return ok({
    qr_type: 'staff',
    staff_id: staffId,
    staff_name: String(staff.name || ''),
    role: normalizeRole(staff.role || ''),
    expiresAt: frameExp,
    verifiedAt: now,
    consumed: true
  });
}

export async function staffQrSessionStop(args) {
  const supabase = getSupabaseAdmin();
  await maybePurgeExpired(supabase, 0);

  const token = String(args?.sessionToken || args?.token || '').trim();
  if (!token) return ok({ stopped: true });

  const { data: session } = await supabase
    .from('staff_qr_sessions')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (session) {
    await supabase
      .from('staff_qr_sessions')
      .delete()
      .eq('token', token);

    await supabase
      .from('staff_qr_nonces')
      .delete()
      .eq('staff_id', String(session.staff_id || '').trim())
      .eq('public_session_id', String(session.public_session_id || '').trim())
      .eq('used', false);
  }

  return ok({ stopped: true });
}