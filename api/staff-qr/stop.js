import { staffQrSessionStop } from '../../lib/staff-qr-core.js';

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
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
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

function statusFromOut(out) {
  if (out?.ok) return 200;
  const code = String(out?.error?.code || '').trim().toUpperCase();
  if (code === 'NOT_FOUND') return 404;
  if (code === 'NOT_ALLOWED') return 403;
  if (code === 'CONFIG_REQUIRED' || code === 'SERVER_ERROR' || code === 'LOCK_TIMEOUT' || code.startsWith('DB_')) return 500;
  return 400;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' } });
  }

  let payload = {};
  try {
    payload = parseBody(req);
  } catch (e) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' }
    });
  }

  try {
    const args = payload.args && typeof payload.args === 'object' ? payload.args : payload;
    const out = await someLibFn(args);
    return send(res, statusFromOut(out), out);
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: { code: 'SERVER_ERROR', message: e?.message || '처리 실패' }
    });
  }
}