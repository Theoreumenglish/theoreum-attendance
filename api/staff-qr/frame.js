import { staffQrSessionFrame } from '../../lib/staff-qr-core.js';

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' } });
  }

  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const args = payload.args && typeof payload.args === 'object' ? payload.args : payload;
    const out = await staffQrSessionFrame(args);
    return send(res, out.ok ? 200 : 400, out);
  } catch (e) {
    return send(res, 500, { ok: false, error: { code: 'SERVER_ERROR', message: e?.message || 'staff frame 실패' } });
  }
}