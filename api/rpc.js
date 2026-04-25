import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import {
  assistantGetLogsDirect,
  assistantGetLogByTraceDirect,
  adminGetStaffMonthlySummaryDirect,
  adminGetStaffDailyDetailDirect
} from '../lib/rpc-direct-read.js';

const MAX_BODY_BYTES = 64 * 1024;

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

async function readBody(req) {
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

function normalizeDirectFloor(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === '5층') return '5F';
  if (text === '7층') return '7F';
  if (text === '5F' || text === '7F') return text;
  return '5F';
}

function readDirectMeta() {
  const kioskFloor = normalizeDirectFloor(process.env.KIOSK_FLOOR || '5F');
  const safeMode =
    String(process.env.SAFE_MODE_DEFAULT || 'N').trim().toUpperCase() === 'Y'
      ? 'Y'
      : 'N';

  return {
    version: 'vercel-direct',
    tz: 'Asia/Seoul',
    kiosk_floor: kioskFloor,
    safe: {
      mode: safeMode,
      message: String(process.env.SAFE_MODE_MESSAGE || '').trim()
    },
    props_missing: [],
    staff_mode: '',
    disabled_ops: [],
    logo_url_set: false,
    logo_url_normalized: ''
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  const contentLength = toPositiveInt(req.headers['content-length'], 0);
  if (contentLength > MAX_BODY_BYTES) {
    return send(res, 413, {
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `요청 크기가 너무 큽니다. 최대 ${MAX_BODY_BYTES} bytes`
      }
    });
  }

  let payload = {};
  try {
    payload = await readBody(req);
  } catch (e) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' }
    });
  }

  if (!isPlainObject(payload)) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_PAYLOAD', message: '요청 본문은 JSON 객체여야 합니다.' }
    });
  }

  const op = String(payload.op || '').trim();
  if (!op) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_OP', message: 'op 값이 필요합니다.' }
    });
  }

  if (payload.args != null && !isPlainObject(payload.args)) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'args는 JSON 객체여야 합니다.' }
    });
  }

  const directSessionToken =
    (payload.args && payload.args.directSessionToken) ||
    payload.directSessionToken ||
    (payload.args && payload.args.sessionToken) ||
    payload.sessionToken ||
    '';

  const gasSessionToken =
    (payload.args && payload.args.gasSessionToken) ||
    payload.gasSessionToken ||
    '';

  if (op === 'meta.ping') {
    return send(res, 200, {
      ok: true,
      data: readDirectMeta()
    });
  }

  if (op === 'auth.login') {
    const result = await authLoginDirect(payload.args || {});
    return send(res, result.status, result.body);
  }

  if (op === 'auth.me') {
    const me = await authMeDirect(directSessionToken, { touch: true });
    return send(res, 200, { ok: true, data: me });
  }

  if (op === 'auth.logout') {
    const result = await authLogoutDirect(directSessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'kiosk.approvePin') {
    const result = await handleKioskApprovePin(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'kiosk.mark') {
    const result = await handleKioskMark(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'staff.clock') {
    const result = await handleStaffClock(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'staff.clock.qr') {
    const result = await handleStaffClockQr(payload);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.getLogs') {
    const result = await assistantGetLogsDirect(payload.args || {}, directSessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'assistant.getLogByTrace') {
    const result = await assistantGetLogByTraceDirect(payload.args || {}, directSessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getStaffMonthlySummary') {
    const result = await adminGetStaffMonthlySummaryDirect(payload.args || {}, directSessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'admin.getStaffDailyDetail') {
    const result = await adminGetStaffDailyDetailDirect(payload.args || {}, directSessionToken);
    return send(res, result.status, result.body);
  }

  if (op === 'teacher.setException') {
    return send(res, 501, {
      ok: false,
      error: {
        code: 'DIRECT_ONLY_UNSUPPORTED',
        message: 'teacher.setException 는 아직 direct 구현 전입니다.'
      }
    });
  }

  return send(res, 400, {
    ok: false,
    error: {
      code: 'BAD_OP',
      message: '지원하지 않는 op 입니다: ' + op
    }
  });