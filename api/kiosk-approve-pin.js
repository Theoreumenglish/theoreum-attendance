import { approveKioskPinDirect } from '../lib/staff-auth.js';

export async function handleKioskApprovePin(payload) {
  const args =
  payload?.args && typeof payload.args === 'object'
    ? payload.args
    : (payload && typeof payload === 'object' ? payload : {});
  const traceId = String(
    payload?.traceId ||
    payload?.trace_id ||
    args?.traceId ||
    args?.trace_id ||
    ('vercel-pin-' + Date.now().toString(36))
  ).trim();

  return await approveKioskPinDirect({
    sessionToken: args.sessionToken || payload?.sessionToken || '',
    pin: args.pin || '',
    student_id: args.student_id || args.sid || ''
  }, traceId);
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
    const out = await handleKioskApprovePin(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'kiosk.approvePin 처리 실패'
      }
    });
  }
}