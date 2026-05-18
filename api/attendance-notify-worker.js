import { runAttendanceNotifyWorker } from '../lib/attendance-notify-queue.js';

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
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

  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  return {};
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.min(20, Math.floor(n)));
}

function readLimit(req, body) {
  const fromQuery = normalizeLimit(req?.query?.limit);
  if (fromQuery) return fromQuery;

  return normalizeLimit(body?.limit);
}

function getWorkerKey() {
  return String(process.env.NOTIFY_WORKER_KEY || '').trim();
}

function isCronBearer(req) {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  if (!cronSecret) return false;

  const authHeader = String(req?.headers?.authorization || '').trim();
  return authHeader === `Bearer ${cronSecret}`;
}

function isWorkerAuthorized(req, body) {
  const workerKey = getWorkerKey();
  const cronSecret = String(process.env.CRON_SECRET || '').trim();

  const authHeader = String(req?.headers?.authorization || '').trim();
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  const fromHeader = String(
    req?.headers?.['x-worker-key'] ||
    req?.headers?.['x-notify-worker-key'] ||
    ''
  ).trim();

  const fromBody = String(body?.worker_key || '').trim();
  const fromQuery = String(req?.query?.worker_key || '').trim();

  const provided = bearer || fromHeader || fromBody || fromQuery;

  if (!provided) return false;

  if (workerKey && provided === workerKey) return true;
  if (cronSecret && provided === cronSecret) return true;

  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return send(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'GET 또는 POST만 허용됩니다.'
      }
    });
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch (e) {
    return send(res, 400, {
      ok: false,
      error: {
        code: 'BAD_JSON',
        message: '요청 JSON 형식이 올바르지 않습니다.'
      }
    });
  }

  if (!getWorkerKey() && !String(process.env.CRON_SECRET || '').trim()) {
    return send(res, 500, {
      ok: false,
      error: {
        code: 'CONFIG_REQUIRED',
        message: 'NOTIFY_WORKER_KEY 또는 CRON_SECRET이 설정되지 않았습니다.'
      }
    });
  }

  if (!isWorkerAuthorized(req, body)) {
    return send(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'worker 호출 인증 실패'
      }
    });
  }

  try {
    const limit = readLimit(req, body);
    const out = await runAttendanceNotifyWorker({
      limit,
      source: isCronBearer(req) ? 'CRON' : 'API_WORKER'
    });
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