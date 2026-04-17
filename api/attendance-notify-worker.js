import { runAttendanceNotifyWorker } from '../lib/attendance-notify-queue.js';

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function readLimit(req) {
  const fromQuery = Number(req?.query?.limit);
  if (Number.isFinite(fromQuery) && fromQuery > 0) return Math.floor(fromQuery);

  const body = req?.body;
  if (body && typeof body === 'object') {
    const fromBody = Number(body.limit);
    if (Number.isFinite(fromBody) && fromBody > 0) return Math.floor(fromBody);
  }

  return undefined;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'POST만 허용됩니다.'
      }
    });
  }

  try {
    const limit = readLimit(req);
    const out = await runAttendanceNotifyWorker({ limit });
    return send(res, out.ok ? 200 : 500, out);
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'attendance notify worker 실패'
      }
    });
  }
}