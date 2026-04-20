import { authMeDirect } from '../lib/staff-auth.js';
import { writeStaffClockAndRollup } from '../lib/staff-attendance.js';

const ALLOWED_ACTIONS = new Set(['IN', 'OUT']);

function normalizeAction(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_ACTIONS.has(s) ? s : '';
}

function normalizeInputMode(input) {
  const s = String(input || '').trim().toUpperCase();
  return ['WEB', 'QR', 'MANUAL'].includes(s) ? s : 'WEB';
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
  const note = String(args.note || '').trim();
  const inputMode = normalizeInputMode(args.input_mode || 'WEB');
  const sessionToken = String(args.sessionToken || payload?.sessionToken || '').trim();
  const traceId = String(
    payload?.traceId ||
    payload?.trace_id ||
    args?.traceId ||
    args?.trace_id ||
    ('vercel-staffweb-' + Date.now().toString(36))
  ).trim();

  const me = await authMeDirect(sessionToken, { touch: true });
  if (!me.loggedIn) {
    return fail(401, 'AUTH_REQUIRED', '로그인이 필요합니다.');
  }

  if (!action) {
    return fail(400, 'INVALID_INPUT', '허용되지 않는 action 입니다.');
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