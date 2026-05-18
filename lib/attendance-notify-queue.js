import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';
import {
  notifyParentOnAttendanceDirect,
  notifyParentOnAbsenceDirect
} from './attendance-notify.js';

function toPositiveInt(value, fallback, min = 1, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normPhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(raw) {
  const ms = Date.parse(String(raw || '').trim());
  return Number.isFinite(ms) ? ms : NaN;
}

function absentQueueMaxAgeMin() {
  return toPositiveInt(
    process.env.ABSENT_QUEUE_MAX_AGE_MIN,
    20,
    1,
    240
  );
}

function isExpiredAbsentQueueRow(row, nowMs = Date.now()) {
  const action = String(row?.action_type || '').trim().toUpperCase();
  if (!action.startsWith('ABSENT_')) return false;

  const baseMs = parseIsoMs(row?.occurred_at || row?.created_at || '');
  if (!Number.isFinite(baseMs)) return false;

  return (nowMs - baseMs) > (absentQueueMaxAgeMin() * 60 * 1000);
}

function shortErrorText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

async function recordNotifyWorkerRun(supabase, args = {}) {
  const summary = args.summary && typeof args.summary === 'object' ? args.summary : {};
  const errorText = shortErrorText(args.error || '');

  const row = {
    source: String(args.source || 'WORKER').trim().toUpperCase(),
    status: String(args.status || (errorText ? 'FAILED' : 'OK')).trim().toUpperCase(),
    scanned: Number(summary.scanned || 0) || 0,
    claimed: Number(summary.claimed || 0) || 0,
    done: Number(summary.done || 0) || 0,
    failed: Number(summary.failed || 0) || 0,
    requeued: Number(summary.requeued || 0) || 0,
    skipped: Number(summary.skipped || 0) || 0,
    detail_json: summary,
    error: errorText
  };

  try {
    await supabase
      .from('notify_worker_runs')
      .insert([row]);
  } catch {
    // worker 본 작업을 audit 실패 때문에 실패 처리하지 않음
  }
}

function isDuplicateKeyError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const detail = String(error?.details || '').toLowerCase();

  return (
    code === '23505' ||
    message.includes('duplicate key') ||
    detail.includes('duplicate key')
  );
}

async function reclaimStaleProcessing(supabase, staleSec) {
  const sec = Number(staleSec);
  if (!Number.isFinite(sec) || sec <= 0) return null;

  const cutoffIso = new Date(Date.now() - (sec * 1000)).toISOString();

  const { error } = await supabase
    .from('attendance_notify_queue')
    .update({
      status: 'PENDING',
      claimed_at: null,
      processed_at: null,
      last_error: 'STALE_PROCESSING_RECOVERED'
    })
    .eq('status', 'PROCESSING')
    .lt('claimed_at', cutoffIso);

  return error || null;
}

export async function enqueueAttendanceNotify(student, actionType, traceId) {
  const attNotify = String(process.env.ATT_NOTIFY_PARENTS || 'N').trim().toUpperCase() === 'Y';
  if (!attNotify) {
    return {
      attempted: false,
      queued: false,
      ok: true,
      channel: '',
      error: '',
      reason: 'ATT_NOTIFY_PARENTS_OFF'
    };
  }

  const to = normPhone(student?.parent_phone);
  if (!to) {
    return {
      attempted: false,
      queued: false,
      ok: false,
      channel: '',
      error: '학부모 전화번호 없음',
      reason: 'NO_PARENT_PHONE'
    };
  }

  const supabase = getSupabaseAdmin();
  const studentId = String(student?.student_id || '').trim();
  const action = String(actionType || '').trim().toUpperCase();
  const trace = String(traceId || '').trim();

  if (!studentId) {
    return {
      attempted: false,
      queued: false,
      ok: false,
      channel: '',
      error: 'student_id 없음',
      reason: 'INVALID_STUDENT_ID'
    };
  }

  if (action !== 'CHECK_IN' && action !== 'CHECK_OUT') {
    return {
      attempted: false,
      queued: false,
      ok: false,
      channel: '',
      error: '출결 알림은 CHECK_IN / CHECK_OUT만 허용',
      reason: 'INVALID_ACTION'
    };
  }

  if (!trace) {
    return {
      attempted: false,
      queued: false,
      ok: false,
      channel: '',
      error: 'trace_id 없음',
      reason: 'INVALID_TRACE_ID'
    };
  }

  const { data: existing, error: existingErr } = await supabase
    .from('attendance_notify_queue')
    .select('queue_id, status, attempts, sent_channel, last_error, processed_at')
    .eq('trace_id', trace)
    .eq('action_type', action)
    .maybeSingle();

  if (existingErr) {
    return {
      attempted: true,
      queued: false,
      ok: false,
      channel: '',
      error: existingErr.message || 'queue 조회 실패',
      reason: 'QUEUE_SELECT_FAILED'
    };
  }

  if (existing) {
    return {
      attempted: true,
      queued: true,
      duplicate: true,
      ok: true,
      queue_id: existing.queue_id,
      status: existing.status,
      attempts: existing.attempts || 0,
      channel: existing.sent_channel || '',
      error: existing.last_error || '',
      processed_at: existing.processed_at || null
    };
  }

  const row = {
    queue_id: randomUUID(),
    trace_id: trace,
    student_id: studentId,
    action_type: action,
    parent_phone: to,
    school: String(student?.school || '').trim(),
    grade: String(student?.grade || '').trim(),
    student_name: String(student?.student_name || '').trim(),
    occurred_at: nowIso(),
    status: 'PENDING',
    attempts: 0,
    sent_channel: '',
    last_error: '',
    processed_at: null
  };

  const { data, error } = await supabase
    .from('attendance_notify_queue')
    .insert([row])
    .select('queue_id, status, attempts, sent_channel, last_error, processed_at')
    .single();

  if (error) {
    if (isDuplicateKeyError(error)) {
      const { data: dup, error: dupErr } = await supabase
        .from('attendance_notify_queue')
        .select('queue_id, status, attempts, sent_channel, last_error, processed_at')
        .eq('trace_id', trace)
        .eq('action_type', action)
        .maybeSingle();

      if (!dupErr && dup) {
        return {
          attempted: true,
          queued: true,
          duplicate: true,
          ok: true,
          queue_id: dup.queue_id,
          status: dup.status,
          attempts: dup.attempts || 0,
          channel: dup.sent_channel || '',
          error: dup.last_error || '',
          processed_at: dup.processed_at || null
        };
      }
    }

    return {
      attempted: true,
      queued: false,
      ok: false,
      channel: '',
      error: error.message || 'queue insert 실패',
      reason: 'QUEUE_INSERT_FAILED'
    };
  }

  return {
    attempted: true,
    queued: true,
    duplicate: false,
    ok: true,
    queue_id: data.queue_id,
    status: data.status,
    attempts: data.attempts || 0,
    channel: '',
    error: '',
    processed_at: data.processed_at || null
  };
}

function normalizeQueueStatus(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (['PENDING', 'PROCESSING', 'DONE', 'FAILED'].includes(s)) return s;
  return '';
}

function normalizeActionPrefix(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'ABSENT') return 'ABSENT_';
  if (s === 'ATTENDANCE') return 'CHECK_';
  return '';
}

export async function listAttendanceNotifyQueueDirect(args = {}) {
  const supabase = getSupabaseAdmin();

  const status = normalizeQueueStatus(args.status || '');
  const actionPrefix = normalizeActionPrefix(args.action_prefix || args.actionPrefix || '');
  const limit = toPositiveInt(args.limit, 100, 1, 500);

  let query = supabase
    .from('attendance_notify_queue')
    .select(
      'queue_id, trace_id, student_id, action_type, parent_phone, school, grade, student_name, occurred_at, status, attempts, sent_channel, last_error, claimed_at, processed_at, created_at'
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) {
    query = query.eq('status', status);
  }

  if (actionPrefix) {
    query = query.ilike('action_type', actionPrefix + '%');
  }

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      error: {
        code: 'QUEUE_READ_FAILED',
        message: error.message || 'attendance_notify_queue 조회 실패'
      }
    };
  }

  const rows = Array.isArray(data) ? data : [];
  const counts = rows.reduce((acc, row) => {
    const key = normalizeQueueStatus(row.status) || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    ok: true,
    data: {
      count: rows.length,
      counts,
      items: rows
    }
  };
}

export async function retryAttendanceNotifyQueueDirect(args = {}) {
  const supabase = getSupabaseAdmin();

  const status = normalizeQueueStatus(args.status || 'FAILED') || 'FAILED';
  if (!['FAILED', 'PROCESSING'].includes(status)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_RETRY_STATUS',
        message: '재처리는 FAILED 또는 PROCESSING 상태만 허용됩니다.'
      }
    };
  }

  const actionPrefix = normalizeActionPrefix(args.action_prefix || args.actionPrefix || '');
  if (!actionPrefix) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ACTION_PREFIX',
        message: '재처리 대상 action_prefix가 필요합니다. ABSENT 또는 ATTENDANCE만 허용됩니다.'
      }
    };
  }

  const limit = toPositiveInt(args.limit, 50, 1, 200);
  const workerLimit = toPositiveInt(args.worker_limit || args.workerLimit, Math.min(limit, 20), 1, 20);
  const resetAttempts = String(args.reset_attempts || args.resetAttempts || 'N').trim().toUpperCase() === 'Y';

  let selectQuery = supabase
    .from('attendance_notify_queue')
    .select('queue_id, trace_id, action_type, status, attempts, last_error, occurred_at, created_at')
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (actionPrefix) {
    selectQuery = selectQuery.ilike('action_type', actionPrefix + '%');
  }

  const { data: targets, error: readErr } = await selectQuery;
  if (readErr) {
    return {
      ok: false,
      error: {
        code: 'QUEUE_READ_FAILED',
        message: readErr.message || '재처리 대상 queue 조회 실패'
      }
    };
  }

  const allRows = Array.isArray(targets) ? targets : [];
  const retryNowMs = Date.now();
  const expiredBlockedRows = status === 'FAILED' && actionPrefix === 'ABSENT_'
    ? allRows.filter(row =>
        String(row?.last_error || '').trim() === 'ABSENT_SEND_WINDOW_EXPIRED' ||
        isExpiredAbsentQueueRow(row, retryNowMs)
      )
    : [];

  const expiredBlockedIds = new Set(
    expiredBlockedRows.map(row => String(row?.queue_id || '').trim()).filter(Boolean)
  );

  const rows = expiredBlockedIds.size
    ? allRows.filter(row => !expiredBlockedIds.has(String(row?.queue_id || '').trim()))
    : allRows;

  if (!rows.length) {
    return {
      ok: true,
      data: {
        selected: 0,
        reset: 0,
        excluded_expired: expiredBlockedRows.length,
        worker: null,
        items: []
      }
    };
  }

  const ids = rows.map(row => row.queue_id).filter(Boolean);
  const patch = {
    status: 'PENDING',
    claimed_at: null,
    processed_at: null,
    sent_channel: '',
    last_error: 'ADMIN_RETRY'
  };

  if (resetAttempts) {
    patch.attempts = 0;
  }

  const { data: resetRows, error: updateErr } = await supabase
    .from('attendance_notify_queue')
    .update(patch)
    .in('queue_id', ids)
    .select('queue_id, trace_id, action_type, status, attempts, last_error, occurred_at, created_at')

  if (updateErr) {
    return {
      ok: false,
      error: {
        code: 'QUEUE_UPDATE_FAILED',
        message: updateErr.message || 'queue 재처리 상태 변경 실패'
      }
    };
  }

  const worker = await runAttendanceNotifyWorker({
    limit: Math.min(workerLimit, ids.length),
    source: 'ADMIN_RETRY'
  });

  return {
    ok: true,
    data: {
      selected: rows.length,
      reset: Array.isArray(resetRows) ? resetRows.length : 0,
      excluded_expired: expiredBlockedRows.length,
      resetAttempts,
      workerLimit,
      worker,
      items: resetRows || []
    }
  };
}

export async function runAttendanceNotifyWorker(args = {}) {
  const supabase = getSupabaseAdmin();
  const limit = toPositiveInt(
    args?.limit,
    toPositiveInt(process.env.ATT_NOTIFY_WORKER_BATCH, 5),
    1,
    20
  );
  const maxAttempts = toPositiveInt(process.env.ATT_NOTIFY_MAX_ATTEMPTS, 3, 1, 10);
  const staleSec = toPositiveInt(process.env.ATT_NOTIFY_STALE_SEC, 180, 30, 3600);

  const reclaimErr = await reclaimStaleProcessing(supabase, staleSec);
  if (reclaimErr) {
    await recordNotifyWorkerRun(supabase, {
      source: args.source || 'WORKER',
      status: 'FAILED',
      summary: {
        ok: false,
        scanned: 0,
        claimed: 0,
        done: 0,
        failed: 1,
        requeued: 0,
        skipped: 0,
        items: []
      },
      error: reclaimErr.message || 'stale queue 복구 실패'
    });

    return {
      ok: false,
      error: {
        code: 'QUEUE_RECLAIM_FAILED',
        message: reclaimErr.message || 'stale queue 복구 실패'
      }
    };
  }

  const summary = {
    ok: true,
    scanned: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    requeued: 0,
    skipped: 0,
    expired_absent_skipped: 0,
    items: []
  };

  const { data: rows, error: readErr } = await supabase
    .from('attendance_notify_queue')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (readErr) {
    await recordNotifyWorkerRun(supabase, {
      source: args.source || 'WORKER',
      status: 'FAILED',
      summary,
      error: readErr.message || 'queue 조회 실패'
    });

    return {
      ok: false,
      error: {
        code: 'QUEUE_READ_FAILED',
        message: readErr.message || 'queue 조회 실패'
      }
    };
  }

  const pending = Array.isArray(rows) ? rows : [];
  summary.scanned = pending.length;

  const workerNowMs = Date.now();

  for (const row of pending) {
    if (isExpiredAbsentQueueRow(row, workerNowMs)) {
      const { error: expireErr } = await supabase
        .from('attendance_notify_queue')
        .update({
          status: 'FAILED',
          last_error: 'ABSENT_SEND_WINDOW_EXPIRED',
          processed_at: nowIso(),
          claimed_at: null
        })
        .eq('queue_id', row.queue_id)
        .eq('status', 'PENDING');

      if (expireErr) {
        summary.failed++;
        summary.items.push({
          queue_id: row.queue_id,
          status: 'FAILED',
          error: expireErr.message || '오래된 미등원 queue 만료 처리 실패'
        });
      } else {
        summary.skipped++;
        summary.expired_absent_skipped++;
        summary.items.push({
          queue_id: row.queue_id,
          status: 'SKIPPED',
          error: 'ABSENT_SEND_WINDOW_EXPIRED'
        });
      }

      continue;
    }

    const nextAttempts = (Number(row.attempts || 0) || 0) + 1;

    const { data: claimed, error: claimErr } = await supabase
      .from('attendance_notify_queue')
      .update({
        status: 'PROCESSING',
        attempts: nextAttempts,
        last_error: '',
        claimed_at: nowIso()
      })
      .eq('queue_id', row.queue_id)
      .eq('status', 'PENDING')
      .select('*')
      .maybeSingle();

    if (claimErr) {
      summary.failed++;
      summary.items.push({
        queue_id: row.queue_id,
        status: 'FAILED',
        error: claimErr.message || 'queue claim 실패'
      });
      continue;
    }

    if (!claimed) {
      summary.skipped++;
      continue;
    }

    summary.claimed++;

    let notifyResult = null;
    try {
      const claimedAction = String(claimed.action_type || '').trim().toUpperCase();
      const studentPayload = {
        student_id: claimed.student_id,
        student_name: claimed.student_name,
        school: claimed.school,
        grade: claimed.grade,
        parent_phone: claimed.parent_phone
      };

      if (claimedAction.startsWith('ABSENT_')) {
        notifyResult = await notifyParentOnAbsenceDirect(
          studentPayload,
          claimed.trace_id,
          claimed.occurred_at || ''
        );
      } else {
        notifyResult = await notifyParentOnAttendanceDirect(
          studentPayload,
          claimed.action_type,
          claimed.trace_id,
          claimed.occurred_at || ''
        );
      }
    } catch (e) {
      notifyResult = {
        ok: false,
        error: e?.message || 'SEND_THROWN',
        reason: 'SEND_THROWN'
      };
    }

    if (notifyResult && notifyResult.ok) {
      const { error: doneErr } = await supabase
        .from('attendance_notify_queue')
        .update({
          status: 'DONE',
          sent_channel: String(notifyResult.channel || '').trim(),
          last_error: '',
          processed_at: nowIso(),
          claimed_at: null
        })
        .eq('queue_id', claimed.queue_id);

      if (doneErr) {
        summary.failed++;
        summary.items.push({
          queue_id: claimed.queue_id,
          status: 'FAILED',
          error: doneErr.message || 'queue 완료 업데이트 실패'
        });
        continue;
      }

      summary.done++;
      summary.items.push({
        queue_id: claimed.queue_id,
        status: 'DONE',
        channel: String(notifyResult.channel || '').trim()
      });
      continue;
    }

    const failText = shortErrorText(
      notifyResult?.error || notifyResult?.reason || 'SEND_FAILED'
    );
    const nextStatus = nextAttempts >= maxAttempts ? 'FAILED' : 'PENDING';

    const { error: failErr } = await supabase
      .from('attendance_notify_queue')
      .update({
        status: nextStatus,
        sent_channel: '',
        last_error: failText,
        processed_at: nextStatus === 'FAILED' ? nowIso() : null,
        claimed_at: null
      })
      .eq('queue_id', claimed.queue_id);

    if (failErr) {
      summary.failed++;
      summary.items.push({
        queue_id: claimed.queue_id,
        status: 'FAILED',
        error: failErr.message || 'queue 실패 업데이트 실패'
      });
      continue;
    }

    if (nextStatus === 'FAILED') {
      summary.failed++;
    } else {
      summary.requeued++;
    }

    summary.items.push({
      queue_id: claimed.queue_id,
      status: nextStatus,
      error: failText
    });
  }

  await recordNotifyWorkerRun(supabase, {
    source: args.source || 'WORKER',
    status: summary.failed > 0 ? 'PARTIAL' : 'OK',
    summary
  });

  return { ok: true, data: summary };
}