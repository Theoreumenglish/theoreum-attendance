import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClockQr } from './staff-clock-qr.js';
import { handleStaffClock } from './staff-clock.js';
import { handleKioskApprovePin } from './kiosk-approve-pin.js';
import { getAttendanceMetaCached } from '../lib/attendance-meta.js';
import { authLoginDirect, authMeDirect, authLogoutDirect } from '../lib/staff-auth.js';
import { proxyRpcToGas } from '../lib/gas-rpc-proxy.js';
import { teacherSetExceptionHybrid } from '../lib/rpc-hybrid-write.js';
import {
  assistantGetLogsDirect,
  assistantGetLogByTraceDirect,
  adminGetStaffMonthlySummaryDirect,
  adminGetStaffDailyDetailDirect
} from '../lib/rpc-direct-read.js';

const DEFAULT_TIMEOUT_MS = 25000;
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

function resolveTimeoutMs(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 120000);
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
    const meta = await getAttendanceMetaCached();
    if (!meta.ok) {
      return send(res, 503, {
        ok: false,
        error: {
          code: meta.error?.code || 'META_UNAVAILABLE',
          message: meta.error?.message || '운영 메타 정보를 읽지 못했습니다.'
        }
      });
    }
    return send(res, 200, { ok: true, data: meta.data });
  }

  if (op === 'auth.login') {
    const result = await authLoginDirect(payload.args || {});
    if (!result.body || result.body.ok !== true) {
      return send(res, result.status, result.body);
    }

    const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
    if (gasUrl) {
      const gasLogin = await proxyRpcToGas('auth.login', payload.args || {}, '');

      if (
        !gasLogin.body ||
        gasLogin.body.ok !== true ||
        !gasLogin.body.data ||
        !gasLogin.body.data.sessionToken
      ) {
        try {
          await authLogoutDirect(result.body?.data?.sessionToken || '');
        } catch (_) {}

        return send(res, gasLogin.status || 502, {
          ok: false,
          error: {
            code: 'GAS_AUTH_SYNC_FAILED',
            message:
              (gasLogin.body && gasLogin.body.error && gasLogin.body.error.message) ||
              'GAS 세션 동기화에 실패했습니다. 다시 시도해주세요.'
          }
        });
      }

      result.body.data = {
        ...(result.body.data || {}),
        gasSessionToken: gasLogin.body.data.sessionToken
      };
    }

    return send(res, result.status, result.body);
  }

  if (op === 'auth.me') {
    const me = await authMeDirect(directSessionToken, { touch: true });
    return send(res, 200, { ok: true, data: me });
  }

  if (op === 'auth.logout') {
    const result = await authLogoutDirect(directSessionToken);

    if (gasSessionToken) {
      try {
        await proxyRpcToGas('auth.logout', {}, gasSessionToken);
      } catch (_) {}
    }

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
    const result = await teacherSetExceptionHybrid(payload.args || {}, gasSessionToken);
    return send(res, result.status, result.body);
  }

  const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
  if (!gasUrl) {
    return send(res, 500, {
      ok: false,
      error: { code: 'CONFIG_REQUIRED', message: 'Vercel 환경변수 GAS_WEBAPP_URL이 없습니다.' }
    });
  }

  const controller = new AbortController();
  const timeoutMs = resolveTimeoutMs(process.env.GAS_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const forwardedArgs = isPlainObject(payload.args) ? { ...payload.args } : {};

    delete forwardedArgs.directSessionToken;
    delete forwardedArgs.gasSessionToken;
    forwardedArgs.sessionToken = gasSessionToken;

    const upstreamPayload = {
      ...payload,
      directSessionToken: '',
      gasSessionToken: '',
      sessionToken: gasSessionToken,
      args: forwardedArgs
    };

    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Accept: 'application/json'
      },
      body: JSON.stringify(upstreamPayload),
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store'
    });

    const text = await upstream.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      return send(res, 502, {
        ok: false,
        error: {
          code: 'UPSTREAM_BAD_JSON',
          message: 'GAS 응답 JSON 파싱 실패',
          detail: {
            status: upstream.status,
            preview: String(text || '').slice(0, 400)
          }
        }
      });
    }

    return send(
      res,
      upstream.ok ? 200 : upstream.status,
      data || {
        ok: false,
        error: { code: 'EMPTY_RESPONSE', message: 'GAS 응답이 비어 있습니다.' }
      }
    );
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return send(res, aborted ? 504 : 502, {
      ok: false,
      error: {
        code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAIL',
        message: aborted ? 'GAS 응답 시간 초과' : (e?.message || 'GAS 요청 실패')
      }
    });
  } finally {
    clearTimeout(timer);
  }
}