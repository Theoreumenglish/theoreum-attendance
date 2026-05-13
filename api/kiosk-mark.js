import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { studentQrVerify } from '../lib/student-qr-core.js';
import { enqueueAttendanceNotify } from '../lib/attendance-notify-queue.js';
import { hasValidPinApproval } from '../lib/staff-auth.js';
import { readRuntimeMeta, normalizeFloor, normalizeYn } from './_runtime-meta.js';

const ALLOWED_ACTIONS = new Set(['CHECK_IN', 'CHECK_OUT', 'MOVE', 'OUTING']);
const ALLOWED_FLOORS = new Set(['5F', '7F']);
const MOVE_DEDUPE_MS = 90000;

function normalizeStudentId(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^QR1\./i.test(text)) return '';
  if (!/^\d{1,4}$/.test(text)) return '';
  return text.padStart(4, '0');
}

function isStudentQrText(input) {
  return /^QR1\./i.test(String(input || '').trim());
}

function normalizeAction(input) {
  const text = String(input || '').trim().toUpperCase();
  if (text === 'IN' || text === 'CHECKIN' || text === 'CHECK_IN') return 'CHECK_IN';
  if (text === 'OUT' || text === 'CHECKOUT' || text === 'CHECK_OUT') return 'CHECK_OUT';
  if (text === 'MOVE') return 'MOVE';
  if (text === 'OUTING') return 'OUTING';
  return text;
}


function formatYmdKst(date = new Date()) {
  const kstMs = date.getTime() + (9 * 60 * 60 * 1000);
  return new Date(kstMs).toISOString().slice(0, 10).replace(/-/g, '');
}

function buildRecordId() {
  return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function buildTraceId(payload) {
  const candidates = [
    payload?.traceId,
    payload?.trace_id,
    payload?.args?.traceId,
    payload?.args?.trace_id
  ];

  for (const c of candidates) {
    const v = String(c || '').trim();
    if (v) return v;
  }

  return 'vercel-kiosk-' + randomUUID();
}

function isActiveStudentStatus(raw) {
  const s = String(raw || '').trim();
  return s === '재원' || s.toLowerCase() === 'active';
}

function pickArgs(payload) {
  return payload?.args && typeof payload.args === 'object'
    ? payload.args
    : (payload && typeof payload === 'object' ? payload : {});
}

function getVerifySharedSecret() {
  return String(
    process.env.STUDENT_QR_VERIFY_SHARED_SECRET ||
    process.env.VERIFY_SHARED_SECRET ||
    ''
  ).trim();
}

async function findStudent(supabase, sid) {
  const { data, error } = await supabase
    .from('students')
    .select('student_id, student_name, school, grade, parent_phone, status, qr_id, is_exception')
    .eq('student_id', sid)
    .maybeSingle();

  return { data, error };
}

async function findExistingTrace(supabase, traceId) {
  const { data, error } = await supabase
    .from('attendance_logs')
    .select('*')
    .eq('trace_id', traceId)
    .limit(1)
    .maybeSingle();

  return { data, error };
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

async function insertAttendanceLog(supabase, record) {
  const { data, error } = await supabase
    .from('attendance_logs')
    .insert([record])
    .select()
    .single();

  return { data, error };
}

async function getTodayLogs(supabase, sid, yyyymmdd) {
  const { data, error } = await supabase
    .from('attendance_logs')
    .select('ts, action_type, kiosk_floor, meta_json, trace_id')
    .eq('student_id', sid)
    .eq('yyyymmdd', yyyymmdd)
    .eq('result', 'OK')
    .order('ts', { ascending: true });

  return { data: data || [], error };
}

function parseOutingFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const v = String(meta.outing || '').trim().toUpperCase();
  if (v === 'START' || v === 'OUT' || v === 'OUTING_OUT') return 'START';
  if (v === 'RETURN' || v === 'BACK' || v === 'OUTING_BACK') return 'RETURN';
  return '';
}

function buildTodayState(logs) {
  const state = {
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

  for (const row of logs) {
    const action = String(row?.action_type || '').trim().toUpperCase();
    const ts = Date.parse(String(row?.ts || ''));
    const ms = Number.isFinite(ts) ? ts : 0;

    state.lastActionType = action || state.lastActionType;
    state.lastActionTs = ms || state.lastActionTs;

    if (action === 'CHECK_IN') {
      state.checkedIn = true;
      state.checkedOut = false;
      state.outingActive = false;
      state.lastCheckInTs = ms;
      continue;
    }

    if (action === 'CHECK_OUT') {
      state.checkedOut = true;
      state.outingActive = false;
      state.lastCheckOutTs = ms;
      continue;
    }

    if (action === 'MOVE') {
      state.lastMoveTs = ms;
      state.lastMoveFloor = String(row?.kiosk_floor || '').trim().toUpperCase();
      continue;
    }

    if (action === 'OUTING_OUT') {
      state.outingActive = true;
      continue;
    }

    if (action === 'OUTING_BACK') {
      state.outingActive = false;
      continue;
    }

    if (action === 'OUTING') {
      const outing = parseOutingFromMeta(row?.meta_json);
      if (outing === 'START') state.outingActive = true;
      if (outing === 'RETURN') state.outingActive = false;
    }
  }

  return state;
}

function isoToMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function stateFromRow(row) {
  if (!row) return null;

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

async function getTodayStateRow(supabase, sid, yyyymmdd) {
  const { data, error } = await supabase
    .from('today_student_state')
    .select(
      'yyyymmdd, student_id, checked_in, checked_out, outing_active, last_action_type, last_action_ts, last_move_ts, last_move_floor, last_check_in_ts, last_check_out_ts'
    )
    .eq('yyyymmdd', yyyymmdd)
    .eq('student_id', sid)
    .maybeSingle();

  return { data, error };
}

async function loadCurrentTodayState(supabase, sid, yyyymmdd) {
  const stateRow = await getTodayStateRow(supabase, sid, yyyymmdd);

  if (!stateRow.error && stateRow.data) {
    return {
      state: stateFromRow(stateRow.data),
      source: 'today_student_state',
      error: null
    };
  }

  const { data: todayLogs, error: logsErr } = await getTodayLogs(supabase, sid, yyyymmdd);
  if (logsErr) {
    return {
      state: null,
      source: stateRow.error ? 'state_error_then_logs_error' : 'logs_error',
      error: logsErr
    };
  }

  return {
    state: buildTodayState(todayLogs),
    source: stateRow.error ? 'logs_fallback_after_state_error' : 'logs_fallback',
    error: null
  };
}

function applyActionToTodayState(currentState, finalAction, kioskFloor, now) {
  const nowMs = now.getTime();
  const action = String(finalAction || '').trim().toUpperCase();

  const next = {
    checkedIn: !!currentState?.checkedIn,
    checkedOut: !!currentState?.checkedOut,
    outingActive: !!currentState?.outingActive,
    lastActionType: action,
    lastActionTs: nowMs,
    lastMoveTs: Number(currentState?.lastMoveTs || 0),
    lastMoveFloor: String(currentState?.lastMoveFloor || '').trim().toUpperCase(),
    lastCheckInTs: Number(currentState?.lastCheckInTs || 0),
    lastCheckOutTs: Number(currentState?.lastCheckOutTs || 0)
  };

  if (action === 'CHECK_IN') {
    next.checkedIn = true;
    next.checkedOut = false;
    next.outingActive = false;
    next.lastCheckInTs = nowMs;
  }

  if (action === 'CHECK_OUT') {
    next.checkedOut = true;
    next.outingActive = false;
    next.lastCheckOutTs = nowMs;
  }

  if (action === 'MOVE') {
    next.lastMoveTs = nowMs;
    next.lastMoveFloor = String(kioskFloor || '').trim().toUpperCase();
  }

  if (action === 'OUTING_OUT') {
    next.outingActive = true;
  }

  if (action === 'OUTING_BACK') {
    next.outingActive = false;
  }

  return next;
}

function msToIso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

async function upsertTodayStateAfterAction({
  supabase,
  yyyymmdd,
  sid,
  currentState,
  finalAction,
  kioskFloor,
  now,
  stateSource
}) {
  const next = applyActionToTodayState(currentState, finalAction, kioskFloor, now);

  const row = {
    yyyymmdd,
    student_id: sid,
    checked_in: next.checkedIn,
    checked_out: next.checkedOut,
    outing_active: next.outingActive,
    last_action_type: next.lastActionType,
    last_action_ts: msToIso(next.lastActionTs),
    last_move_ts: msToIso(next.lastMoveTs),
    last_move_floor: next.lastMoveFloor,
    last_check_in_ts: msToIso(next.lastCheckInTs),
    last_check_out_ts: msToIso(next.lastCheckOutTs),
    updated_at: now.toISOString(),
    meta_json: {
      source: 'kiosk-mark',
      state_source: stateSource || '',
      kiosk_floor: kioskFloor || ''
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
    state: next
  };
}

async function upsertTodayStateFromExistingRecord(supabase, record, stateSource = 'duplicate_trace') {
  const sid = normalizeStudentId(record?.student_id);
  const yyyymmdd = String(record?.yyyymmdd || '').trim();
  const action = String(record?.action_type || '').trim().toUpperCase();
  const kioskFloor = String(record?.kiosk_floor || '').trim().toUpperCase();
  const ts = new Date(record?.ts || new Date().toISOString());

  if (!sid || !/^\d{8}$/.test(yyyymmdd) || Number.isNaN(ts.getTime())) {
    return {
      ok: false,
      error: '기존 출결 record의 student_id / yyyymmdd / ts가 올바르지 않습니다.'
    };
  }

  if (!['CHECK_IN', 'CHECK_OUT', 'MOVE', 'OUTING_OUT', 'OUTING_BACK'].includes(action)) {
    return {
      ok: true,
      skipped: true,
      reason: 'STATE_ACTION_NOT_REQUIRED'
    };
  }

  const stateOut = await loadCurrentTodayState(supabase, sid, yyyymmdd);
  if (stateOut.error) {
    return {
      ok: false,
      error: stateOut.error.message || '기존 출결 상태 조회 실패'
    };
  }

  const currentState = stateOut.state || {
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

  return upsertTodayStateAfterAction({
    supabase,
    yyyymmdd,
    sid,
    currentState,
    finalAction: action,
    kioskFloor,
    now: ts,
    stateSource
  });
}

function mapQrVerifyError(err) {
  const code = String(err?.code || '').trim();
  const message = String(err?.message || '').trim();

  if (code === 'EXPIRED') {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'QR_EXPIRED',
          message: '시간이 초과되었습니다. 학생 앱에서 새 QR을 발급하세요.'
        }
      }
    };
  }

  if (code === 'SESSION_EXPIRED') {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'QR_EXPIRED',
          message: '이미 새 QR로 교체되었습니다. 학생 앱에서 다시 발급하세요.'
        }
      }
    };
  }

  if (
    code === 'ALREADY_USED' ||
    code === 'BAD_SIG' ||
    code === 'BAD_FORMAT' ||
    code === 'BAD_PAYLOAD' ||
    code === 'BAD_NONCE' ||
    code === 'NOT_ISSUED' ||
    code === 'BAD_SID'
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'QR_INVALID',
          message: '이미 사용했거나 유효하지 않은 QR입니다.'
        }
      }
    };
  }

  if (code === 'NOT_FOUND') {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: '등록되지 않은 학생입니다. 데스크에 문의하세요.'
        }
      }
    };
  }

  if (code === 'NOT_ALLOWED') {
    return {
      status: 403,
      body: {
        ok: false,
        error: {
          code: 'NOT_ACTIVE',
          message: '현재 재원 상태가 아닙니다. 데스크에 문의하세요.'
        }
      }
    };
  }

  if (
    code === 'CONFIG_REQUIRED' ||
    code === 'CALLER_AUTH_FAILED' ||
    code === 'DB_SELECT_FAILED' ||
    code === 'DB_UPDATE_FAILED'
  ) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: code || 'SERVER_ERROR',
          message: message || 'QR 검증 서버 설정 또는 DB 오류'
        }
      }
    };
  }

  return {
    status: 400,
    body: {
      ok: false,
      error: {
        code: code || 'QR_INVALID',
        message: message || 'QR 검증 실패'
      }
    }
  };
}

async function verifyStudentQrDirect(qrText) {
  const sharedSecret = getVerifySharedSecret();

  if (!sharedSecret) {
    return {
      ok: false,
      error: {
        code: 'CONFIG_REQUIRED',
        message: '학생 QR 검증 secret이 설정되지 않았습니다.'
      }
    };
  }

  return await studentQrVerify({
    qrText,
    consume: 'Y',
    shared_secret: sharedSecret
  });
}

function fail(status, code, message, detail = {}) {
  return {
    status,
    body: {
      ok: false,
      error: { code, message, detail }
    }
  };
}

function perfSnapshot(startMs, extra = {}) {
  return {
    total_ms: Math.max(0, Date.now() - Number(startMs || Date.now())),
    ...extra
  };
}

function success(body) {
  return { status: 200, body };
}

export async function handleKioskMark(payload) {
  const perfStartMs = Date.now();
  const args = pickArgs(payload);

  const requestedAction = normalizeAction(args.action || args.type);
  const input = String(args.input || '').trim();
  const traceId = buildTraceId(payload);

  const meta = await readRuntimeMeta();
  if (!meta.ok) {
    return fail(
      503,
      'META_UNAVAILABLE',
      meta.error?.message || '운영 상태를 확인할 수 없습니다.'
    );
  }

  const authoritativeFloor = normalizeFloor(String(meta.data?.kiosk_floor || '5F').trim()) || '5F';
  if (!ALLOWED_FLOORS.has(authoritativeFloor)) {
    return fail(500, 'CONFIG_REQUIRED', 'runtime_config 또는 KIOSK_FLOOR 설정이 올바르지 않습니다.');
  }

  const kioskFloor = authoritativeFloor;
  const safeMode = normalizeYn(meta.data?.safe?.mode || 'N') === 'Y';
  const safeMessage = String(meta.data?.safe?.message || '').trim();

  if (safeMode) {
    return fail(503, 'SAFE_MODE', safeMessage || '현재 점검 모드입니다. 데스크에 문의하세요.');
  }

  if (!requestedAction) {
    return fail(400, 'BAD_ACTION', 'action 값이 필요합니다.');
  }

  if (!ALLOWED_ACTIONS.has(requestedAction)) {
    return fail(400, 'BAD_ACTION', '지원하지 않는 action 입니다.');
  }

  if (!input) {
    return fail(400, 'BAD_INPUT', 'input 값이 필요합니다.');
  }

  if (!ALLOWED_FLOORS.has(kioskFloor)) {
    return fail(400, 'BAD_KIOSK_FLOOR', 'kiosk_floor는 5F 또는 7F여야 합니다.');
  }

  const isQr = isStudentQrText(input);
  const sidFromIdInput = normalizeStudentId(input);

  if ((requestedAction === 'CHECK_IN' || requestedAction === 'CHECK_OUT') && !isQr && !sidFromIdInput) {
    return fail(
      400,
      'QR_REQUIRED',
      '등/하원은 전용 QR 또는 관리자 허용 학생의 학번 직접 출결만 가능합니다.'
    );
  }

  if ((requestedAction === 'MOVE' || requestedAction === 'OUTING') && !sidFromIdInput) {
    return fail(400, 'BAD_INPUT', '교실이동/외출복귀는 학번 4자리 입력만 가능합니다.');
  }

  try {
    const supabase = getSupabaseAdmin();
    const yyyymmdd = formatYmdKst(new Date());
    const now = new Date();
    const nowMs = now.getTime();

    const { data: existingTrace, error: traceErr } = await findExistingTrace(supabase, traceId);
    if (traceErr) {
      return fail(500, 'DB_SELECT_FAILED', traceErr.message || 'attendance_logs trace 조회 실패');
    }
    if (existingTrace) {
      const stateWrite = await upsertTodayStateFromExistingRecord(
        supabase,
        existingTrace,
        'duplicate_trace'
      );

      return success({
        ok: true,
        data: {
          duplicate: true,
          alreadyDone: false,
          source: 'supabase-direct',
          perf: perfSnapshot(perfStartMs, { path: 'duplicate_trace' }),
          state: {
            write_ok: !!stateWrite.ok,
            skipped: !!stateWrite.skipped,
            reason: stateWrite.reason || '',
            error: stateWrite.ok ? '' : String(stateWrite.error || ''),
            warning: stateWrite.ok ? '' : 'DUPLICATE_TRACE_STATE_WRITE_FAILED'
          },
          ui: {
            title: '중복 입력',
            message: '이미 처리된 요청입니다.'
          }
        },
        traceId,
        record: existingTrace
      });
    }

    let sid = sidFromIdInput;
    let inputMode = 'ID';
    if ((requestedAction === 'CHECK_IN' || requestedAction === 'CHECK_OUT') && !isQr && sidFromIdInput) {
      inputMode = 'EXCEPTION_ID';
    }
    let qrId = '';
    let verifiedStudentName = '';

    if (isQr) {
      const verifyOut = await verifyStudentQrDirect(input);
      if (!verifyOut.ok) return mapQrVerifyError(verifyOut.error);

      sid = normalizeStudentId(verifyOut.data?.student_id);
      inputMode = 'QR';
      qrId = String(verifyOut.data?.qr_id || '').trim();
      verifiedStudentName = String(verifyOut.data?.student_name || '').trim();

      if (!sid) {
        return fail(500, 'SERVER_ERROR', 'QR 검증 결과에 student_id가 없습니다.');
      }
    }

    const { data: student, error: studentErr } = await findStudent(supabase, sid);
    if (studentErr) {
      return fail(500, 'SUPABASE_STUDENT_READ_FAIL', studentErr.message || 'students 조회 실패');
    }
    if (!student) {
      return fail(404, 'STUDENT_NOT_FOUND', '학생을 찾지 못했습니다.');
    }
    if (!isActiveStudentStatus(student.status)) {
      return fail(403, 'NOT_ACTIVE', '재원 상태 학생만 출결 처리할 수 있습니다.');
    }

    if ((requestedAction === 'CHECK_IN' || requestedAction === 'CHECK_OUT') && !isQr && sidFromIdInput) {
      const isException = String(student.is_exception || '').trim().toUpperCase() === 'Y';
      if (!isException) {
        return fail(
          400,
          'NOT_EXCEPTION',
          '학번 직접 등/하원 허용 학생만 학번으로 처리할 수 있습니다.'
        );
      }

      const approved = await hasValidPinApproval(sid);
      if (!approved) {
        return fail(400, 'NEED_PIN', '학번 직접 출결 학생은 데스크 PIN 승인이 필요합니다.', {
          needPin: true,
          student_id: sid,
          student_name: student.student_name || ''
        });
      }
    }

    const stateOut = await loadCurrentTodayState(supabase, sid, yyyymmdd);
    if (stateOut.error) {
      return fail(500, 'DB_SELECT_FAILED', stateOut.error.message || '오늘 출결 상태 조회 실패');
    }

    const state = stateOut.state || {
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
    const stateSource = stateOut.source || 'unknown';

    let finalAction = requestedAction;
    let title = '';
    const message = `${student.student_name || verifiedStudentName} (${student.student_id})`;
    const metaJson = {
      actor: '__VERCEL__',
      source: 'supabase-direct',
      input_mode: inputMode,
      state_source: stateSource
    };

    if (inputMode === 'EXCEPTION_ID') {
      metaJson.exception = 'Y';
    }

    if (requestedAction === 'CHECK_IN') {
      if (state.checkedIn && !state.checkedOut) {
        return success({
          ok: true,
          data: {
            duplicate: false,
            alreadyDone: true,
            source: 'supabase-direct',
            action: 'CHECK_IN',
            student,
            ui: {
              title: '이미 등원 처리됨',
              message
            }
          },
          traceId
        });
      }

      finalAction = 'CHECK_IN';
      title = '등원 완료';
    }

    if (requestedAction === 'CHECK_OUT') {
      if (!state.checkedIn) {
        return fail(400, 'NOT_CHECKED_IN', '아직 등원 처리되지 않은 학생입니다.');
      }
      if (state.checkedOut) {
        return success({
          ok: true,
          data: {
            duplicate: false,
            alreadyDone: true,
            source: 'supabase-direct',
            action: 'CHECK_OUT',
            student,
            ui: {
              title: '이미 하원 처리됨',
              message
            }
          },
          traceId
        });
      }
      if (state.outingActive) {
        return fail(400, 'OUTING_ACTIVE', '외출 중에는 하원 처리할 수 없습니다. 먼저 복귀 처리하세요.');
      }

      finalAction = 'CHECK_OUT';
      title = '하원 완료';
    }

    if (requestedAction === 'MOVE') {
      if (!state.checkedIn) {
        return fail(400, 'NOT_CHECKED_IN', '등원 후에만 교실 이동을 사용할 수 있습니다.');
      }
      if (state.checkedOut) {
        return fail(400, 'ALREADY_CHECKED_OUT', '이미 하원 처리된 학생입니다.');
      }
      if (state.outingActive) {
        return fail(400, 'OUTING_ACTIVE', '외출 중에는 교실 이동을 사용할 수 없습니다.');
      }

      if (
        state.lastActionType === 'MOVE' &&
        state.lastMoveFloor === kioskFloor &&
        state.lastMoveTs > 0 &&
        nowMs - state.lastMoveTs < MOVE_DEDUPE_MS
      ) {
        return success({
          ok: true,
          data: {
            duplicate: false,
            alreadyDone: true,
            source: 'supabase-direct',
            action: 'MOVE',
            student,
            ui: {
              title: '중복 교실 이동',
              message: `${message} · ${Math.ceil((MOVE_DEDUPE_MS - (nowMs - state.lastMoveTs)) / 1000)}초 이내 중복 입력`
            }
          },
          traceId
        });
      }

      finalAction = 'MOVE';
      title = '교실 이동 완료';
    }

    if (requestedAction === 'OUTING') {
      if (!state.checkedIn) {
        return fail(400, 'NOT_CHECKED_IN', '등원 후에만 외출/복귀를 사용할 수 있습니다.');
      }
      if (state.checkedOut) {
        return fail(400, 'ALREADY_CHECKED_OUT', '이미 하원 처리된 학생입니다.');
      }

      if (state.outingActive) {
        finalAction = 'OUTING_BACK';
        title = '복귀 완료';
        metaJson.outing = 'RETURN';
      } else {
        finalAction = 'OUTING_OUT';
        title = '외출 완료';
        metaJson.outing = 'START';
      }
    }

    const record = {
      record_id: buildRecordId(),
      ts: now.toISOString(),
      yyyymmdd,
      student_id: sid,
      action_type: finalAction,
      kiosk_floor: kioskFloor,
      meta_json: metaJson,
      result: 'OK',
      deny_reason: '',
      qr_id: inputMode === 'QR' ? (qrId || String(student.qr_id || '').trim()) : '',
      trace_id: traceId
    };

    const { data: inserted, error: insertErr } = await insertAttendanceLog(supabase, record);
    if (insertErr) {
      if (isDuplicateKeyError(insertErr)) {
        const { data: dupAfterRace, error: dupReadErr } = await findExistingTrace(supabase, traceId);
        if (!dupReadErr && dupAfterRace) {
          const stateWrite = await upsertTodayStateFromExistingRecord(
            supabase,
            dupAfterRace,
            'duplicate_race'
          );

          return success({
            ok: true,
            data: {
              duplicate: true,
              alreadyDone: false,
              source: 'supabase-direct',
              perf: perfSnapshot(perfStartMs, { path: 'duplicate_race' }),
              state: {
                write_ok: !!stateWrite.ok,
                skipped: !!stateWrite.skipped,
                reason: stateWrite.reason || '',
                error: stateWrite.ok ? '' : String(stateWrite.error || ''),
                warning: stateWrite.ok ? '' : 'DUPLICATE_RACE_STATE_WRITE_FAILED'
              },
              ui: {
                title: '중복 입력',
                message: '이미 처리된 요청입니다.'
              }
            },
            traceId,
            record: dupAfterRace
          });
        }
      }

      return fail(500, 'DB_INSERT_FAILED', insertErr.message || 'attendance_logs insert 실패');
    }

    let notifyResult = {
      attempted: false,
      queued: false,
      ok: true,
      channel: '',
      error: '',
      reason: 'NOT_ATTENDANCE_ACTION'
    };
  
    const stateWrite = await upsertTodayStateAfterAction({
      supabase,
      yyyymmdd,
      sid,
      currentState: state,
      finalAction,
      kioskFloor,
      now,
      stateSource
    });

    if (finalAction === 'CHECK_IN' || finalAction === 'CHECK_OUT') {
      notifyResult = await enqueueAttendanceNotify(
        {
          ...student,
          student_name: student.student_name || verifiedStudentName || ''
        },
        finalAction,
        traceId
      );
    }

    return success({
      ok: true,
      data: {
        duplicate: false,
        alreadyDone: false,
        source: 'supabase-direct',
        action: finalAction,
        student: {
          ...student,
          student_name: student.student_name || verifiedStudentName || ''
        },
        notify: notifyResult,
        perf: perfSnapshot(perfStartMs, {
          path: 'main',
          action: finalAction,
          input_mode: inputMode,
          state_source: stateSource
        }),
        state: {
          source: stateSource,
          write_ok: !!stateWrite.ok,
          error: stateWrite.ok ? '' : String(stateWrite.error || ''),
          warning: stateWrite.ok ? '' : 'ATTENDANCE_LOG_SAVED_BUT_STATE_WRITE_FAILED'
        },
        ui: {
          title,
          message
        }
      },
      traceId,
      record: inserted
    });
  } catch (e) {
    return fail(500, 'SERVER_ERROR', e?.message || 'kiosk.mark 처리 실패');
  }
}

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
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
  setNoStore(res);

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  let payload = {};
  try {
    payload = parseBody(req);
  } catch (_) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'BAD_JSON',
        message: '요청 JSON 형식이 올바르지 않습니다.'
      }
    });
  }

  try {
    const out = await handleKioskMark(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'SERVER_ERROR',
        message: e?.message || 'kiosk.mark 처리 실패'
      }
    });
  }
}