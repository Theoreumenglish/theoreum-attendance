import crypto from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

const _mem = globalThis.__studentQrMem || {
  sessions: new Map(),
  sidToPublicSession: new Map(),
  nonces: new Map(),
  rate: new Map(),
  startFail: new Map()
};
globalThis.__studentQrMem = _mem;

function nowMs() {
  return Date.now();
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function cfg() {
  return {
    stepMs: positiveInt(process.env.STUDENT_QR_FRAME_STEP_MS, 10000),
    graceMs: positiveInt(process.env.STUDENT_QR_GRACE_MS, 3000),
    sessionTtlSec: positiveInt(process.env.STUDENT_QR_SESSION_TTL_SEC, 180),
    verifySharedSecret: String(
      process.env.STUDENT_QR_VERIFY_SHARED_SECRET ||
      process.env.VERIFY_SHARED_SECRET ||
      ''
    ).trim(),
    qrHmacSecret: String(
      process.env.STUDENT_QR_HMAC_SECRET ||
      process.env.QR_HMAC_SECRET ||
      ''
    ).trim()
  };
}

function normalizeSid(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

function isSid(v) {
  return /^\d{4}$/.test(String(v || ''));
}

function normalizePhoneTail(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').slice(-4);
}

function normalizeStudentStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === '재원' || s === 'active' || s === '재원생') return 'ACTIVE';
  if (s === '휴원' || s === 'inactive' || s === '휴원생') return 'INACTIVE';
  if (s === '퇴원' || s === 'withdrawn' || s === '퇴원생') return 'WITHDRAWN';
  return 'UNKNOWN';
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

function hmacB64Url(msg) {
  const secret = cfg().qrHmacSecret;
  if (!secret) throw new Error('STUDENT_QR_HMAC_SECRET 필요');
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(String(msg || ''), 'utf8'))
    .digest('base64url');
}

function rateLimit(key, limit, windowSec) {
  const now = nowMs();
  const cur = _mem.rate.get(key);
  if (!cur || cur.exp <= now) {
    _mem.rate.set(key, { count: 1, exp: now + (windowSec * 1000) });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count += 1;
  return true;
}

function purgeExpired() {
  const now = nowMs();

  for (const [k, v] of _mem.sessions.entries()) {
    if (!v || !v.exp || v.exp <= now) _mem.sessions.delete(k);
  }
  for (const [k, v] of _mem.sidToPublicSession.entries()) {
    if (!v || !v.exp || v.exp <= now) _mem.sidToPublicSession.delete(k);
  }
  for (const [k, v] of _mem.nonces.entries()) {
    if (!v || !v.exp || v.exp <= now) _mem.nonces.delete(k);
  }
  for (const [k, v] of _mem.startFail.entries()) {
    if (!v || !v.exp || v.exp <= now) _mem.startFail.delete(k);
  }
}

async function getStudentBySid(sid) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('students')
    .select('student_id, student_name, status, student_phone, qr_id')
    .eq('student_id', sid)
    .maybeSingle();

  if (error) throw new Error(error.message || 'students 조회 실패');
  return data || null;
}

function studentPhoneTail(student) {
  const phone = String(student?.student_phone || '').replace(/[^0-9]/g, '');
  return phone.slice(-4);
}

function ok(data) {
  return { ok: true, data };
}

function err(code, message, detail) {
  return { ok: false, error: { code, message, detail: detail || {} } };
}

function bumpStartFail(sid) {
  const now = nowMs();
  const cur = _mem.startFail.get(sid);
  if (!cur || cur.exp <= now) {
    _mem.startFail.set(sid, { count: 1, exp: now + 300000 });
    return;
  }
  cur.count += 1;
}

export async function studentQrSessionStart(args) {
  purgeExpired();

  const sid = normalizeSid(args?.student_id);
  const phoneTail = normalizePhoneTail(args?.phone_tail);

  if (!isSid(sid)) return err('INVALID_INPUT', '학번은 4자리 숫자여야 합니다.');
  if (!/^\d{4}$/.test(phoneTail)) return err('INVALID_INPUT', '휴대폰 뒤 4자리를 입력해주세요.');

  if (!rateLimit('START|' + sid, 10, 60)) {
    return err('RATE_LIMIT', '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  }

  const fail = _mem.startFail.get(sid);
  if (fail && fail.count >= 5 && fail.exp > nowMs()) {
    return err('AUTH_LOCKED', '인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  }

  const student = await getStudentBySid(sid);
  if (!student) {
    bumpStartFail(sid);
    return err('AUTH_FAILED', '학번 또는 휴대폰 뒤 4자리를 확인해주세요.');
  }

  const expectedTail = studentPhoneTail(student);
  if (!expectedTail || phoneTail !== expectedTail) {
    bumpStartFail(sid);
    return err('AUTH_FAILED', '학번 또는 휴대폰 뒤 4자리를 확인해주세요.');
  }

  if (normalizeStudentStatus(student.status) !== 'ACTIVE') {
    return err('NOT_ALLOWED', '현재 인증할 수 없습니다. 데스크에 문의해주세요.');
  }

  _mem.startFail.delete(sid);

  const token = randomId(16);
  const publicSessionId = randomId(16);
  const now = nowMs();
  const exp = now + (cfg().sessionTtlSec * 1000);

  _mem.sessions.set(token, {
    sid,
    publicSessionId,
    exp,
    anchorMs: now,
    studentName: String(student.student_name || '')
  });

  _mem.sidToPublicSession.set(sid, {
    publicSessionId,
    exp
  });

  return ok({
    token,
    publicSessionId,
    expiresAt: exp,
    serverNow: now,
    student: {
      student_id: sid,
      student_name: String(student.student_name || '')
    }
  });
}

export async function studentQrSessionFrame(args) {
  purgeExpired();

  const token = String(args?.token || '').trim();
  if (!token) return err('INVALID_INPUT', 'token 필요');

  const session = _mem.sessions.get(token);
  if (!session) return err('SESSION_NOT_FOUND', '세션을 찾지 못했습니다.');

  const now = nowMs();
  if (now >= session.exp) {
    _mem.sessions.delete(token);
    return err('SESSION_EXPIRED', '세션이 만료되었습니다.');
  }

  const step = cfg().stepMs;
  const anchorMs = Number(session.anchorMs || now);
  const elapsed = Math.max(0, now - anchorMs);
  const bucketIndex = Math.floor(elapsed / step);
  const bucketStart = anchorMs + (bucketIndex * step);
  const rotateAt = bucketStart + step;
  const frameExp = rotateAt + cfg().graceMs;

  const nonce = randomId(12);
  const payloadObj = {
    v: 1,
    s: session.sid,
    u: session.publicSessionId,
    n: nonce,
    e: frameExp
  };

  const payloadB64 = Buffer.from(
    JSON.stringify(payloadObj),
    'utf8'
  ).toString('base64url');

  const sigB64 = hmacB64Url(payloadB64);
  const qrText = 'QR1.' + ['v1', payloadB64, sigB64].join('.');

  _mem.nonces.set(nonce, {
    sid: session.sid,
    publicSessionId: session.publicSessionId,
    exp: frameExp,
    used: false
  });

  return ok({
    qrText,
    rotateAt,
    expiresAt: frameExp,
    serverNow: now
  });
}

export async function studentQrVerify(args) {
  purgeExpired();

  const shared = String(args?.shared_secret || args?.verify_secret || '').trim();
  const expectedShared = cfg().verifySharedSecret;

  if (!expectedShared) return err('CONFIG_REQUIRED', 'verify 설정 오류');
  if (!secureEqual(shared, expectedShared)) {
    return err('CALLER_AUTH_FAILED', '호출 인증 실패');
  }

  const consume = String(args?.consume || 'Y').trim().toUpperCase() === 'Y';
  let token = String(args?.qrText || '').trim();
  if (!token) return err('INVALID_INPUT', 'qrText 필요');

  if (/^QR1\./i.test(token)) token = token.replace(/^QR1\./i, '');

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    return err('BAD_FORMAT', 'QR 포맷 오류');
  }

  const payloadB64 = parts[1];
  const sigB64 = parts[2];
  const expect = hmacB64Url(payloadB64);

  if (!secureEqual(sigB64, expect)) {
    return err('BAD_SIG', '서명 불일치');
  }

  let obj;
  try {
    obj = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return err('BAD_PAYLOAD', '페이로드 파싱 실패');
  }

  const version = Number(obj?.v || 0);
  const sid = normalizeSid(obj?.s);
  const publicSessionId = String(obj?.u || '').trim();
  const nonce = String(obj?.n || '').trim();
  const frameExp = Number(obj?.e || 0);

  if (version !== 1) return err('BAD_PAYLOAD', '지원하지 않는 QR 버전');
  if (!isSid(sid)) return err('BAD_SID', '학번 오류');
  if (!publicSessionId) return err('BAD_PAYLOAD', '세션 정보 없음');
  if (!nonce) return err('BAD_NONCE', 'nonce 없음');

  const student = await getStudentBySid(sid);
  if (!student) return err('NOT_FOUND', '학생을 찾지 못했습니다.');
  if (normalizeStudentStatus(student.status) !== 'ACTIVE') {
    return err('NOT_ALLOWED', '현재 재원 상태가 아니어서 QR 인증이 제한됩니다.');
  }

  const now = nowMs();
  if (now > frameExp) return err('EXPIRED', '만료된 QR');

  const issued = _mem.nonces.get(nonce);
  if (!issued) return err('NOT_ISSUED', '발급되지 않은 QR');
  if (issued.publicSessionId !== publicSessionId || issued.sid !== sid) {
    return err('BAD_NONCE', 'nonce 정보 불일치');
  }
  if (issued.exp < now) return err('EXPIRED', '만료된 QR');
  if (consume && issued.used) return err('ALREADY_USED', '이미 사용된 QR');

  if (consume) issued.used = true;

  return ok({
    student_id: sid,
    student_name: String(student.student_name || ''),
    qr_id: String(student.qr_id || ''),
    consumed: consume
  });
}

export async function studentQrSessionStop(args) {
  purgeExpired();

  const token = String(args?.token || '').trim();
  if (!token) return ok({ ok: true });

  const session = _mem.sessions.get(token);
  if (!session) return ok({ ok: true });

  _mem.sessions.delete(token);

  const cur = _mem.sidToPublicSession.get(session.sid);
  if (cur && cur.publicSessionId === session.publicSessionId) {
    _mem.sidToPublicSession.delete(session.sid);
  }

  return ok({ ok: true });
}