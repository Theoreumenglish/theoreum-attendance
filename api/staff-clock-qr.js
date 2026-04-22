import { randomUUID } from 'node:crypto';
import { writeStaffClockAndRollup } from '../lib/staff-attendance.js';
import { staffQrVerify } from '../lib/staff-qr-core.js';

const DEDUPE_SEC = 10;
const ALLOWED_ACTIONS = new Set(['IN', 'OUT']);

function normalizeAction(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_ACTIONS.has(s) ? s : '';
}


function normalizeRole(input) {
  return String(input || '').trim().toLowerCase();
}

function normalizeNote(input) {
  return String(input || '').trim().slice(0, 200);
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
  return payload?.args && typeof payload.args === 'object'
    ? payload.args
    : (payload && typeof payload === 'object' ? payload : {});
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

  const verified = await staffQrVerify({
    qrText,
    consume: 'Y',
    shared_secret: String(
      process.env.STAFF_QR_VERIFY_SHARED_SECRET ||
      process.env.STAFF_QR_SHARED_SECRET ||
      process.env.VERIFY_SHARED_SECRET ||
      ''
    ).trim()
  });
  if (!verified.ok) {
    const raw = verified.error || {};
    const mapped = mapVerifyErrorCode(raw.code, raw.message);

    if (mapped.code === 'NOT_FOUND') {
      return fail(404, mapped.code, mapped.message);
    }
    if (mapped.code === 'NOT_ACTIVE') {
      return fail(403, mapped.code, mapped.message);
    }
    if (mapped.code === 'CONFIG_REQUIRED' || mapped.code === 'SERVER_ERROR') {
      return fail(500, mapped.code, mapped.message);
    }

    return fail(400, mapped.code, mapped.message);
  }

  const staffId = normalizeStaffId(verified.data?.staff_id);
  const staffName = String(verified.data?.staff_name || '').trim();
  const role = normalizeRole(verified.data?.role || '');

  if (!staffId) {
    return fail(500, 'SERVER_ERROR', '직원 QR 검증 결과에 staff_id가 없습니다.');
  }

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