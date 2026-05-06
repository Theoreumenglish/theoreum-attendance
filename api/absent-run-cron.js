import { runAbsenceDetectionDirect } from '../lib/absent-direct.js';
import { runAttendanceNotifyWorker } from '../lib/attendance-notify-queue.js';

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

function getAuthHeader(req) {
  return String(
    req.headers?.authorization ||
    req.headers?.Authorization ||
    ''
  ).trim();
}

function toPositiveInt(value, fallback, min = 1, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cronAllowed(req) {
  const expected = String(process.env.CRON_SECRET || '').trim();
  if (!expected) {
    return {
      ok: false,
      code: 'CRON_SECRET_MISSING',
      message: 'CRON_SECRET 환경변수가 설정되지 않았습니다.'
    };
  }

  const auth = getAuthHeader(req);
  if (auth !== `Bearer ${expected}`) {
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'cron 인증이 올바르지 않습니다.'
    };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return sendJson(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'GET 또는 POST만 허용됩니다.'
      }
    });
  }

  const auth = cronAllowed(req);
  if (!auth.ok) {
    return sendJson(res, 401, {
      ok: false,
      error: {
        code: auth.code,
        message: auth.message
      }
    });
  }

  const startedAt = new Date();
  const workerLimit = toPositiveInt(
    process.env.ABSENT_CRON_WORKER_LIMIT,
    20,
    1,
    50
  );

  try {
    const detection = await runAbsenceDetectionDirect({
      stages: process.env.ABSENT_STAGE_MINUTES || '10,30',
      dry_run: 'N'
    });

    if (!detection.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: {
          code: detection.error?.code || 'ABSENT_DETECTION_FAILED',
          message: detection.error?.message || '미등원 감지 실패'
        },
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString()
      });
    }

    const worker = await runAttendanceNotifyWorker({
      limit: workerLimit
    });

    if (!worker.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: {
          code: worker.error?.code || 'NOTIFY_WORKER_FAILED',
          message: worker.error?.message || '알림 queue worker 실패'
        },
        detection: detection.data || null,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString()
      });
    }

    return sendJson(res, 200, {
      ok: true,
      data: {
        detection: detection.data || {},
        worker: worker.data || {},
        worker_limit: workerLimit,
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString()
      }
    });
  } catch (e) {
    return sendJson(res, 500, {
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'cron 실행 중 오류'
      },
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString()
    });
  }
}