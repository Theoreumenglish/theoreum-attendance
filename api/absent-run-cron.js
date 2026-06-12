import { runAbsenceDetectionDirect } from '../lib/absent-direct.js';
import { recordAbsenceRunDirect } from '../lib/absence-run-audit.js';

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
  const workerMode = 'SEPARATE_WORKER_CRON';

  try {
    const detection = await runAbsenceDetectionDirect({
      stages: process.env.ABSENT_STAGE_MINUTES || '5,20',
      dry_run: 'N'
    });

    if (!detection.ok) {
      const finishedAt = new Date();
      const errorMessage = detection.error?.message || '미등원 감지 실패';

      const audit = await recordAbsenceRunDirect({
        source: 'CRON',
        status: 'FAILED',
        run_by: '__CRON__',
        detection: {},
        worker: null,
        error: errorMessage,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        meta: {
          stage: 'DETECTION',
          workerMode
        }
      });

      return sendJson(res, 500, {
        ok: false,
        error: {
          code: detection.error?.code || 'ABSENT_DETECTION_FAILED',
          message: errorMessage
        },
        worker_mode: workerMode,
        audit,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString()
      });
    }

    const finishedAt = new Date();
    const audit = await recordAbsenceRunDirect({
      source: 'CRON',
      status: 'OK',
      run_by: '__CRON__',
      detection: detection.data || {},
      worker: null,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      meta: {
        workerMode
      }
    });

    return sendJson(res, 200, {
      ok: true,
      data: {
        detection: detection.data || {},
        worker: null,
        worker_mode: workerMode,
        audit,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString()
      }
    });
  } catch (e) {
    const finishedAt = new Date();
    const errorMessage = e?.message || 'cron 실행 중 오류';

    const audit = await recordAbsenceRunDirect({
      source: 'CRON',
      status: 'ERROR',
      run_by: '__CRON__',
      detection: {},
      worker: null,
      error: errorMessage,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      meta: {
        stage: 'THROWN',
        workerMode
      }
    });

    return sendJson(res, 500, {
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: errorMessage
      },
      worker_mode: workerMode,
      audit,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString()
    });
  }
}
