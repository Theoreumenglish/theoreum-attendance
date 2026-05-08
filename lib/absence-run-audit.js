import { getSupabaseAdmin } from './supabase-admin.js';

function nowIso() {
  return new Date().toISOString();
}

function str(value, fallback = '') {
  return String(value || fallback || '').trim();
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

function pickWorkerData(workerOut) {
  if (!workerOut || typeof workerOut !== 'object') return {};
  if (workerOut.data && typeof workerOut.data === 'object') return workerOut.data;
  if (workerOut.body && workerOut.body.data && typeof workerOut.body.data === 'object') return workerOut.body.data;
  return {};
}

export async function recordAbsenceRunDirect(args = {}) {
  const detection = safeJson(args.detection);
  const worker = pickWorkerData(args.worker);
  const errorText = str(args.error);

  const row = {
    source: str(args.source, 'UNKNOWN').toUpperCase(),
    status: str(args.status, errorText ? 'FAILED' : 'OK').toUpperCase(),
    run_by: str(args.run_by),
    yyyymmdd: str(detection.yyyymmdd || args.yyyymmdd),
    started_at: str(args.started_at) || null,
    finished_at: str(args.finished_at) || nowIso(),

    scheduled_class_count: int(detection.scheduledClassCount),
    candidate_count: int(detection.candidateCount || detection.candidates),
    queued_count: int(detection.queuedCount),
    duplicate_count: int(detection.duplicateCount),
    failed_count: int(detection.failedCount),
    sent_count: int(args.sentCount || detection.sentCount || worker.done),

    worker_done: int(worker.done),
    worker_failed: int(worker.failed),
    worker_requeued: int(worker.requeued),

    detail_json: {
      detection,
      worker,
      meta: safeJson(args.meta)
    },
    error: errorText
  };

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('absence_detection_runs')
      .insert([row])
      .select('run_id, created_at')
      .single();

    if (error) {
      return {
        ok: false,
        error: {
          code: 'ABSENCE_RUN_AUDIT_FAILED',
          message: error.message || 'absence_detection_runs insert 실패'
        }
      };
    }

    return {
      ok: true,
      data
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'ABSENCE_RUN_AUDIT_THROWN',
        message: e?.message || 'absence_detection_runs 기록 실패'
      }
    };
  }
}