import crypto from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

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

function ok(data) {
  return { ok: true, data };
}

function err(code, message, detail) {
  return { ok: false, error: { code, message, detail: detail || {} } };
}

async function purgeExpired(supabase) {
  const now = nowMs();

  await supabase
    .from('student_qr_sessions')
    .delete()
    .lt('exp_ms', now);

  await supabase
    .from('student_qr_nonces')
    .delete()
    .lt('exp_ms', now);
}

async function getStudentBySid(supabase, sid) {
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

export async function studentQrSessionStart(args) {
  const supabase = getSupabaseAdmin();
  await purgeExpired(supabase);

  const sid = normalizeSid(args?.student_id);
  const phoneTail = normalizePhoneTail(args?.phone_tail);

  if (!isSid(sid)) return err('INVALID_INPUT', '학번은 4자리 숫자여야 합니다.');
  if (!/^\d{4}$/.test(phoneTail)) return err('INVALID_INPUT', '휴대폰 뒤 4자리를 입력해주세요.');

  const student = await getStudentBySid(supabase, sid);
  if (!student) {
    return err('AUTH_FAILED', '학번 또는 휴대폰 뒤 4자리를 확인해주세요.');
  }

  const expectedTail = studentPhoneTail(student);
  if (!expectedTail || phoneTail !== expectedTail) {
    return err('AUTH_FAILED', '학번 또는 휴대폰 뒤 4자리를 확인해주세요.');
  }

  if (normalizeStudentStatus(student.status) !== 'ACTIVE') {
    return err('NOT_ALLOWED', '현재 인증할 수 없습니다. 데스크에 문의해주세요.');
  }

  const token = randomId(16);
  const publicSessionId = randomId(16);
  const now = nowMs();
  const exp = now + (cfg().sessionTtlSec * 1000);

  await supabase
    .from('student_qr_sessions')
    .delete()
    .eq('student_id', sid);

  const { error: insErr } = await supabase
    .from('student_qr_sessions')
    .insert([{
      token,
      student_id: sid,
      public_session_id: publicSessionId,
      exp_ms: exp,
      anchor_ms: now,
      student_name: String(student.student_name || '')
    }]);

  if (insErr) {
    return err('DB_INSERT_FAILED', insErr.message || 'student_qr_sessions insert 실패');
  }

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
  const supabase = getSupabaseAdmin();
  await purgeExpired(supabase);

  const token = String(args?.token || '').trim();
  if (!token) return err('INVALID_INPUT', 'token 필요');

  const { data: session, error: sessErr } = await supabase
    .from('student_qr_sessions')
    .select('token, student_id, public_session_id, exp_ms, anchor_ms, student_name')
    .eq('token', token)
    .maybeSingle();

  if (sessErr) return err('DB_SELECT_FAILED', sessErr.message || 'student_qr_sessions 조회 실패');
  if (!session) return err('SESSION_NOT_FOUND', '세션을 찾지 못했습니다.');

  const now = nowMs();
  if (now >= Number(session.exp_ms || 0)) {
    await supabase.from('student_qr_sessions').delete().eq('token', token);
    return err('SESSION_EXPIRED', '세션이 만료되었습니다.');
  }

  const step = cfg().stepMs;
  const anchorMs = Number(session.anchor_ms || now);
  const elapsed = Math.max(0, now - anchorMs);
  const bucketIndex = Math.floor(elapsed / step);
  const bucketStart = anchorMs + (bucketIndex * step);
  const rotateAt = bucketStart + step;
  const frameExp = rotateAt + cfg().graceMs;

  const nonce = randomId(12);

  const { error: nonceErr } = await supabase
    .from('student_qr_nonces')
    .insert([{
      nonce,
      student_id: session.student_id,
      public_session_id: session.public_session_id,
      exp_ms: frameExp,
      used: false
    }]);

  if (nonceErr) {
    return err('DB_INSERT_FAILED', nonceErr.message || 'student_qr_nonces insert 실패');
  }

  const payloadObj = {
    v: 1,
    s: session.student_id,
    u: session.public_session_id,
    n: nonce,
    e: frameExp
  };

  const payloadB64 = Buffer.from(
    JSON.stringify(payloadObj),
    'utf8'
  ).toString('base64url');

  const sigB64 = hmacB64Url(payloadB64);
  const qrText = 'QR1.' + ['v1', payloadB64, sigB64].join('.');

  return ok({
    qrText,
    rotateAt,
    expiresAt: frameExp,
    serverNow: now
  });
}

export async function studentQrVerify(args) {
  const supabase = getSupabaseAdmin();
  await purgeExpired(supabase);

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

  const student = await getStudentBySid(supabase, sid);
  if (!student) return err('NOT_FOUND', '학생을 찾지 못했습니다.');
  if (normalizeStudentStatus(student.status) !== 'ACTIVE') {
    return err('NOT_ALLOWED', '현재 재원 상태가 아니어서 QR 인증이 제한됩니다.');
  }

  const now = nowMs();
  if (now > frameExp) return err('EXPIRED', '만료된 QR');

  const { data: issued, error: nonceReadErr } = await supabase
    .from('student_qr_nonces')
    .select('nonce, student_id, public_session_id, exp_ms, used')
    .eq('nonce', nonce)
    .maybeSingle();

  if (nonceReadErr) return err('DB_SELECT_FAILED', nonceReadErr.message || 'student_qr_nonces 조회 실패');
  if (!issued) return err('NOT_ISSUED', '발급되지 않은 QR');
  if (String(issued.public_session_id || '') !== publicSessionId || String(issued.student_id || '') !== sid) {
    return err('BAD_NONCE', 'nonce 정보 불일치');
  }
  if (Number(issued.exp_ms || 0) < now) return err('EXPIRED', '만료된 QR');

  if (consume) {
    const { data: updated, error: updErr } = await supabase
      .from('student_qr_nonces')
      .update({ used: true })
      .eq('nonce', nonce)
      .eq('used', false)
      .select('nonce')
      .maybeSingle();

    if (updErr) return err('DB_UPDATE_FAILED', updErr.message || 'nonce consume 실패');
    if (!updated) return err('ALREADY_USED', '이미 사용된 QR');
  }

  return ok({
    student_id: sid,
    student_name: String(student.student_name || ''),
    qr_id: String(student.qr_id || ''),
    consumed: consume
  });
}

export async function studentQrSessionStop(args) {
  const supabase = getSupabaseAdmin();
  await purgeExpired(supabase);

  const token = String(args?.token || '').trim();
  if (!token) return ok({ ok: true });

  await supabase
    .from('student_qr_sessions')
    .delete()
    .eq('token', token);

  return ok({ ok: true });
}