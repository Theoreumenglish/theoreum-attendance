import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const ALLOWED_ACTIONS = new Set([
  'CHECK_IN',
  'CHECK_OUT',
  'MANUAL_CHECK_IN',
  'MANUAL_CHECK_OUT',
  'MOVE',
  'OUTING',
  'OUTING_OUT',
  'OUTING_BACK'
]);

const ALLOWED_FLOORS = new Set(['5F', '7F']);
const ALLOWED_RESULTS = new Set(['OK', 'DENY']);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
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

  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  return {};
}

function normalizeMetaJson(value) {
  if (value == null || value === '') return {};
  if (isPlainObject(value)) return value;

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : { raw: parsed };
    } catch (_) {
      return { raw: value };
    }
  }

  return { raw: value };
}

function normalizeTimestamp(value) {
  const text = String(value || '').trim();
  const iso = text || new Date().toISOString();
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

function actionForState(raw) {
  const action = String(raw || '').trim().toUpperCase();

  if (action === 'MANUAL_CHECK_IN') return 'CHECK_IN';
  if (action === 'MANUAL_CHECK_OUT') return 'CHECK_OUT';

  return action;
}

function isoToMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function msToIso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function emptyTodayState() {
  return {
    checkedIn: false,
    checkedOut: false,
    outingActive: false,
    lastActionType: '',
    lastActionTs: 0,
    lastMoveTs: 0,
    lastMoveFloor: '',
    lastCheckInTs: 0,
    lastCheckOutTs: 0
  };
}

function stateFromRow(row) {
  if (!row) return emptyTodayState();

  return {
    checkedIn: row.checked_in === true,
    checkedOut: row.checked_out === true,
    outingActive: row.outing_active === true,
    lastActionType: String(row.last_action_type || '').trim().toUpperCase(),
    lastActionTs: isoToMs(row.last_action_ts),
    lastMoveTs: isoToMs(row.last_move_ts),
    lastMoveFloor: String(row.last_move_floor || '').trim().toUpperCase(),
    lastCheckInTs: isoToMs(row.last_check_in_ts),
    lastCheckOutTs: isoToMs(row.last_check_out_ts)
  };
}

function applyLogToState(currentState, record) {
  const rawAction = String(record.action_type || '').trim().toUpperCase();
  let action = actionForState(rawAction);

  if (rawAction === 'OUTING') {
    action = currentState?.outingActive ? 'OUTING_BACK' : 'OUTING_OUT';
  }

  const tsMs = isoToMs(record.ts);

  const next = {
    checkedIn: !!currentState?.checkedIn,
    checkedOut: !!currentState?.checkedOut,
    outingActive: !!currentState?.outingActive,
    lastActionType: rawAction || action,
    lastActionTs: tsMs,
    lastMoveTs: Number(currentState?.lastMoveTs || 0),
    lastMoveFloor: String(currentState?.lastMoveFloor || '').trim().toUpperCase(),
    lastCheckInTs: Number(currentState?.lastCheckInTs || 0),
    lastCheckOutTs: Number(currentState?.lastCheckOutTs || 0)
  };

  if (action === 'CHECK_IN') {
    next.checkedIn = true;
    next.checkedOut = false;
    next.outingActive = false;
    next.lastCheckInTs = tsMs;
  }

  if (action === 'CHECK_OUT') {
    next.checkedOut = true;
    next.outingActive = false;
    next.lastCheckOutTs = tsMs;
  }

  if (action === 'MOVE') {
    next.lastMoveTs = tsMs;
    next.lastMoveFloor = String(record.kiosk_floor || '').trim().toUpperCase();
  }

  if (action === 'OUTING_OUT') {
    next.outingActive = true;
  }

  if (action === 'OUTING_BACK') {
    next.outingActive = false;
  }

  return next;
}

async function upsertTodayStateForAttendanceLog(supabase, record) {
  if (record.result !== 'OK') {
    return {
      ok: true,
      skipped: true,
      reason: 'RESULT_NOT_OK'
    };
  }

  const rawAction = String(record.action_type || '').trim().toUpperCase();
  const baseAction = actionForState(rawAction);

  if (!['CHECK_IN', 'CHECK_OUT', 'MOVE', 'OUTING', 'OUTING_OUT', 'OUTING_BACK'].includes(baseAction)) {
    return {
      ok: true,
      skipped: true,
      reason: 'STATE_ACTION_NOT_REQUIRED'
    };
  }

  const { data: stateRow, error: readErr } = await supabase
    .from('today_student_state')
    .select(
      'yyyymmdd, student_id, checked_in, checked_out, outing_active, last_action_type, last_action_ts, last_move_ts, last_move_floor, last_check_in_ts, last_check_out_ts, meta_json'
    )
    .eq('yyyymmdd', record.yyyymmdd)
    .eq('student_id', record.student_id)
    .maybeSingle();

  if (readErr) {
    return {
      ok: false,
      error: readErr.message || 'today_student_state 조회 실패'
    };
  }

  const currentState = stateFromRow(stateRow);
  const stateMeta = stateRow?.meta_json && typeof stateRow.meta_json === 'object'
    ? stateRow.meta_json
    : {};

  if (
    rawAction === 'OUTING' &&
    String(stateMeta.trace_id || '').trim() === String(record.trace_id || '').trim() &&
    String(stateMeta.raw_action_type || '').trim().toUpperCase() === 'OUTING'
  ) {
    return {
      ok: true,
      skipped: true,
      reason: 'DUPLICATE_OUTING_ALREADY_APPLIED'
    };
  }

  const normalizedRecord = {
    ...record,
    action_type:
      rawAction === 'OUTING'
        ? (currentState.outingActive ? 'OUTING_BACK' : 'OUTING_OUT')
        : record.action_type
  };

  const next = applyLogToState(currentState, normalizedRecord);
  const row = {
    yyyymmdd: normalizedRecord.yyyymmdd,
    student_id: normalizedRecord.student_id,
    checked_in: next.checkedIn,
    checked_out: next.checkedOut,
    outing_active: next.outingActive,
    last_action_type: next.lastActionType,
    last_action_ts: msToIso(next.lastActionTs),
    last_move_ts: msToIso(next.lastMoveTs),
    last_move_floor: next.lastMoveFloor,
    last_check_in_ts: msToIso(next.lastCheckInTs),
    last_check_out_ts: msToIso(next.lastCheckOutTs),
    updated_at: new Date().toISOString(),
    meta_json: {
      source: 'api.attendance-log',
      trace_id: normalizedRecord.trace_id,
      record_id: normalizedRecord.record_id,
      raw_action_type: rawAction
    }
  };

  const { error } = await supabase
    .from('today_student_state')
    .upsert([row], { onConflict: 'yyyymmdd,student_id' });

  if (error) {
    return {
      ok: false,
      error: error.message || 'today_student_state upsert 실패'
    };
  }

  return {
    ok: true,
    skipped: false
  };
}

async function normalizeRecordForPersistence(supabase, record) {
  const rawAction = String(record.action_type || '').trim().toUpperCase();
  if (rawAction !== 'OUTING') {
    return {
      ok: true,
      record
    };
  }

  const { data: stateRow, error } = await supabase
    .from('today_student_state')
    .select('outing_active')
    .eq('yyyymmdd', record.yyyymmdd)
    .eq('student_id', record.student_id)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: error.message || 'today_student_state 조회 실패'
    };
  }

  const finalAction = stateRow?.outing_active === true ? 'OUTING_BACK' : 'OUTING_OUT';
  const meta = record.meta_json && typeof record.meta_json === 'object'
    ? { ...record.meta_json }
    : {};

  return {
    ok: true,
    record: {
      ...record,
      action_type: finalAction,
      meta_json: {
        ...meta,
        raw_action_type: rawAction,
        outing: finalAction === 'OUTING_BACK' ? 'RETURN' : 'START'
      }
    }
  };
}

function buildSupabase() {
  try {
    return {
      client: getSupabaseAdmin()
    };
  } catch (e) {
    return {
      error: {
        ok: false,
        error: 'CONFIG_REQUIRED',
        detail: e?.message || String(e)
      }
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const expectedSecret = String(process.env.API_SHARED_SECRET || '').trim();
  if (!expectedSecret) {
    return res.status(500).json({
      ok: false,
      error: 'CONFIG_REQUIRED',
      detail: 'API_SHARED_SECRET 누락'
    });
  }

  const sharedSecret = String(req.headers['x-api-shared-secret'] || '').trim();
  if (!sharedSecret || sharedSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: 'BAD_JSON',
      detail: e?.message || String(e)
    });
  }

  if (!isPlainObject(body)) {
    return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' });
  }

  const ts = normalizeTimestamp(body.ts);
  if (!ts) {
    return res.status(400).json({ ok: false, error: 'BAD_TS' });
  }

  const traceId = String(body.trace_id || '').trim();
  if (!traceId) {
    return res.status(400).json({ ok: false, error: 'BAD_TRACE_ID' });
  }

  let record = {
    record_id: String(body.record_id || randomUUID()).trim(),
    ts,
    yyyymmdd: String(body.yyyymmdd || '').trim(),
    student_id: String(body.student_id || '').trim(),
    action_type: String(body.action_type || '').trim().toUpperCase(),
    kiosk_floor: String(body.kiosk_floor || '').trim().toUpperCase(),
    meta_json: normalizeMetaJson(body.meta_json),
    result: String(body.result || 'OK').trim().toUpperCase(),
    deny_reason: String(body.deny_reason || '').trim(),
    qr_id: String(body.qr_id || '').trim(),
    trace_id: traceId
  };

  if (!/^\d{8}$/.test(record.yyyymmdd)) {
    return res.status(400).json({ ok: false, error: 'BAD_YYYYMMDD' });
  }

  if (!/^\d{4}$/.test(record.student_id)) {
    return res.status(400).json({ ok: false, error: 'BAD_STUDENT_ID' });
  }

  if (!ALLOWED_ACTIONS.has(record.action_type)) {
    return res.status(400).json({ ok: false, error: 'BAD_ACTION_TYPE' });
  }

  if (!ALLOWED_FLOORS.has(record.kiosk_floor)) {
    return res.status(400).json({ ok: false, error: 'BAD_KIOSK_FLOOR' });
  }

  if (!ALLOWED_RESULTS.has(record.result)) {
    return res.status(400).json({ ok: false, error: 'BAD_RESULT' });
  }

  const { client: supabase, error: envError } = buildSupabase();
  if (envError) {
    return res.status(500).json(envError);
  }
  
  try {
    const { data: existing, error: existingError } = await supabase
      .from('attendance_logs')
      .select('*')
      .eq('trace_id', record.trace_id)
      .limit(1)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({
        ok: false,
        error: 'DB_SELECT_FAILED',
        detail: existingError.message
      });
    }

    if (existing) {
      const stateWrite = await upsertTodayStateForAttendanceLog(supabase, existing);

      return res.status(200).json({
        ok: true,
        duplicate: true,
        record: existing,
        state: {
          write_ok: !!stateWrite.ok,
          skipped: !!stateWrite.skipped,
          reason: stateWrite.reason || '',
          error: stateWrite.ok ? '' : String(stateWrite.error || ''),
          warning: stateWrite.ok ? '' : 'ATTENDANCE_LOG_DUPLICATE_BUT_STATE_WRITE_FAILED'
        }
      });
    }

    const normalizedRecord = await normalizeRecordForPersistence(supabase, record);
    if (!normalizedRecord.ok) {
      return res.status(500).json({
        ok: false,
        error: 'STATE_PREPARE_FAILED',
        detail: normalizedRecord.error || '출결 상태 계산 실패'
      });
    }

    record = normalizedRecord.record;

    const { data, error } = await supabase
      .from('attendance_logs')
      .insert([record])
      .select()
      .single();

    if (error) {
      if (isDuplicateKeyError(error)) {
        const { data: dup, error: dupReadError } = await supabase
          .from('attendance_logs')
          .select('*')
          .eq('trace_id', record.trace_id)
          .limit(1)
          .maybeSingle();

        if (!dupReadError && dup) {
          const stateWrite = await upsertTodayStateForAttendanceLog(supabase, dup);

          return res.status(200).json({
            ok: true,
            duplicate: true,
            record: dup,
            state: {
              write_ok: !!stateWrite.ok,
              skipped: !!stateWrite.skipped,
              reason: stateWrite.reason || '',
              error: stateWrite.ok ? '' : String(stateWrite.error || ''),
              warning: stateWrite.ok ? '' : 'ATTENDANCE_LOG_DUPLICATE_BUT_STATE_WRITE_FAILED'
            }
          });
        }
      }

      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        detail: error.message
      });
    }

    const stateWrite = await upsertTodayStateForAttendanceLog(supabase, data);

    return res.status(200).json({
      ok: true,
      duplicate: false,
      record: data,
      state: {
        write_ok: !!stateWrite.ok,
        skipped: !!stateWrite.skipped,
        reason: stateWrite.reason || '',
        error: stateWrite.ok ? '' : String(stateWrite.error || ''),
        warning: stateWrite.ok ? '' : 'ATTENDANCE_LOG_SAVED_BUT_STATE_WRITE_FAILED'
      }
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      detail: e?.message || String(e)
    });
  }
}