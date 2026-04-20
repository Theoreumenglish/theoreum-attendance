import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase-admin.js';
import { notifyParentOnAttendanceDirect } from './attendance-notify.js';

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

function shortErrorText(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500);
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
  if (!Number.isFinite(sec) || sec <= 0) return;

  const cutoffIso = new Date(Date.now() - (sec * 1000)).toISOString();

  await supabase
    .from('attendance_notify_queue')
    .update({
      status: 'PENDING',
      claimed_at: null,
      last_error: 'STALE_PROCESSING_RECOVERED'
    })
    .eq('status', 'PROCESSING')
    .lt('claimed_at', cutoffIso);
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

  await reclaimStaleProcessing(supabase, staleSec);

  const summary = {
    ok: true,
    scanned: 0,
    claimed: 0,
    done: 0,
    failed: 0,
    requeued: 0,
    skipped: 0,
    items: []
  };

  const { data: rows, error: readErr } = await supabase
    .from('attendance_notify_queue')
    .select('*')
    .eq('status', 'PENDING')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (readErr) {
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

  for (const row of pending) {
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
      notifyResult = await notifyParentOnAttendanceDirect(
        {
          student_id: claimed.student_id,
          student_name: claimed.student_name,
          school: claimed.school,
          grade: claimed.grade,
          parent_phone: claimed.parent_phone
        },
        claimed.action_type,
        claimed.trace_id
      );
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

  return { ok: true, data: summary };
}