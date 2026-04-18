import { randomUUID } from 'node:crypto';
import { writeStaffClockAndRollup } from '../lib/staff-attendance.js';

const DEFAULT_TIMEOUT_MS = 12000;
const DEDUPE_SEC = 10;
const ALLOWED_ACTIONS = new Set(['IN', 'OUT']);

function toPositiveInt(value, fallback, min = 1, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

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
  return String(input || '').trim().toLowerCase();
}

function normalizeNote(input) {
  return String(input || '').trim().slice(0, 200);
}

function stripStaffQrEnvelope(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/^STAFFQR1\./i.test(s)) return '';
  return s.replace(/^STAFFQR1\./i, '');
}

function buildTraceId(payload) {
  const candidates = [
    payload?.traceId,
    payload?.trace_id,
    payload?.args?.traceId,
    payload?.args?.trace_id
  ];

  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }

  return 'vercel-staffqr-' + randomUUID();
}

function pickArgs(payload) {
  return payload?.args && typeof payload.args === 'object' ? payload.args : {};
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

function mapVerifyErrorCode(code, message) {
  const c = String(code || '').trim().toUpperCase();
  const msg = String(message || '').trim();

  switch (c) {
    case 'BAD_FORMAT':
      return { code: 'QR_REQUIRED', message: '직원 근태는 직원 전용 QR만 사용할 수 있습니다.' };
    case 'EXPIRED':
    case 'SESSION_EXPIRED':
      return { code: 'QR_EXPIRED', message: '이미 만료되었거나 새 QR로 교체되었습니다. 다시 발급해주세요.' };
    case 'NOT_FOUND':
      return { code: 'NOT_FOUND', message: '직원 계정을 찾지 못했습니다.' };
    case 'NOT_ALLOWED':
      return { code: 'NOT_ACTIVE', message: '현재 사용 가능한 직원 계정이 아닙니다.' };
    case 'NOT_ISSUED':
    case 'REPLAY':
    case 'BAD_SIG':
    case 'BAD_PAYLOAD':
    case 'BAD_NONCE':
    case 'NONCE_BROKEN':
    case 'MISMATCH':
    case 'BAD_STAFF_ID':
      return { code: 'QR_INVALID', message: '이미 사용했거나 유효하지 않은 직원 QR입니다.' };
    case 'LOCK_TIMEOUT':
      return { code: 'SERVER_ERROR', message: '동시 처리 중입니다. 다시 시도해주세요.' };
    case 'CALLER_AUTH_FAILED':
    case 'CONFIG_REQUIRED':
      return { code: 'CONFIG_REQUIRED', message: msg || '직원 QR 검증 설정이 올바르지 않습니다.' };
    default:
      return { code: c || 'SERVER_ERROR', message: msg || ('직원 QR 검증 실패: ' + (c || 'UNKNOWN')) };
  }
}

async function verifyStaffQrRemote(qrText) {
  const url = String(process.env.STAFF_QR_VERIFY_URL || '').trim();
  const shared = String(process.env.STAFF_QR_VERIFY_SHARED_SECRET || '').trim();
  const innerQr = stripStaffQrEnvelope(qrText);

  if (!url) {
    return { ok: false, error: { code: 'CONFIG_REQUIRED', message: 'STAFF_QR_VERIFY_URL이 설정되지 않았습니다.' } };
  }
  if (!shared) {
    return { ok: false, error: { code: 'CONFIG_REQUIRED', message: 'STAFF_QR_VERIFY_SHARED_SECRET이 설정되지 않았습니다.' } };
  }
  if (!innerQr) {
    return { ok: false, error: { code: 'QR_REQUIRED', message: '직원 근태는 직원 전용 QR만 사용할 수 있습니다.' } };
  }

  const controller = new AbortController();
  const timeoutMs = toPositiveInt(process.env.STAFF_QR_VERIFY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 3000, 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        op: 'verify',
        args: {
          qrText: innerQr,
          consume: 'Y',
          shared_secret: shared
        }
      }),
      cache: 'no-store',
      signal: controller.signal
    });

    const text = await resp.text();
    let parsed = null;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (_) {
      return { ok: false, error: { code: 'SERVER_ERROR', message: '직원 QR 검증 응답 파싱 실패' } };
    }

    if (resp.ok && parsed && parsed.ok) {
      const data = parsed.data || {};
      const staffId = normalizeStaffId(data.staff_id || '');
      if (!staffId) {
        return { ok: false, error: { code: 'SERVER_ERROR', message: '직원 QR 검증 결과에 staff_id가 없습니다.' } };
      }

      return {
        ok: true,
        data: {
          staff_id: staffId,
          staff_name: String(data.staff_name || '').trim(),
          role: normalizeRole(data.role || ''),
          consumed: !!data.consumed
        }
      };
    }

    const err = parsed && parsed.error ? parsed.error : {};
    return { ok: false, error: mapVerifyErrorCode(err.code, err.message) };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: aborted
          ? '직원 QR 검증 서버 응답 시간 초과'
          : ('직원 QR 검증 서버 연결 실패: ' + (e?.message || String(e)))
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleStaffClockQr(payload) {
  const args = pickArgs(payload);
  const qrText = String(args.qrText || args.qr || args.input || '').trim();
  const action = normalizeAction(args.action || args.type);
  const note = normalizeNote(args.note || '');
  const traceId = buildTraceId(payload);

  if (!qrText) {
    return fail(400, 'INVALID_INPUT', '직원 QR 값이 필요합니다.');
  }
  if (!action) {
    return fail(400, 'INVALID_INPUT', '허용되지 않는 action 입니다.');
  }

  const verified = await verifyStaffQrRemote(qrText);
  if (!verified.ok) {
    const err = verified.error || {};
    const code = String(err.code || 'AUTH_FAILED').trim();
    const message = String(err.message || '직원 QR 검증 실패').trim();

    if (code === 'QR_REQUIRED') return fail(400, code, message);
    if (code === 'QR_EXPIRED') return fail(400, code, message);
    if (code === 'QR_INVALID') return fail(400, code, message);
    if (code === 'NOT_FOUND') return fail(404, code, message);
    if (code === 'NOT_ACTIVE') return fail(403, code, message);
    if (code === 'CONFIG_REQUIRED') return fail(500, code, message);

    return fail(500, code || 'SERVER_ERROR', message || '직원 QR 검증 실패');
  }

  const staffId = normalizeStaffId(verified.data?.staff_id);
  const staffName = String(verified.data?.staff_name || '').trim();
  const role = normalizeRole(verified.data?.role || '');

  const result = await writeStaffClockAndRollup({
    ts: new Date().toISOString(),
    staff_id: staffId,
    name: staffName,
    role,
    action,
    note,
    trace_id: traceId,
    input_mode: 'QR'
  }, {
    recentDedupeSec: DEDUPE_SEC
  });

  if (!result.ok) {
    return fail(
      result.status || 500,
      result.error || 'SERVER_ERROR',
      result.detail || 'staff.clock.qr 처리 실패'
    );
  }

  return success({
    ok: true,
    data: {
      ok: true,
      duplicate: !!result.duplicate,
      msg: (result.duplicate ? '중복 스캔 방지 (이미 처리됨)' : ('QR 근태 기록: ' + action)),
      staff_id: staffId,
      name: staffName,
      role
    },
    traceId,
    record: result.record || null,
    daily: result.daily || null,
    monthly: result.monthly || null
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  try {
    const payload = typeof req.body === 'object' && req.body ? req.body : {};
    const out = await handleStaffClockQr(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'staff.clock.qr 처리 실패'
      }
    });
  }
}