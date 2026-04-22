import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { studentQrVerify } from '../lib/student-qr-core.js';
import { enqueueAttendanceNotify } from '../lib/attendance-notify-queue.js';
import { hasValidPinApproval } from '../lib/staff-auth.js';
import { getAttendanceMetaCached } from '../lib/attendance-meta.js';

const DEFAULT_TIMEOUT_MS = 25000;
const ALLOWED_ACTIONS = new Set(['CHECK_IN', 'CHECK_OUT', 'MOVE', 'OUTING']);
const ALLOWED_FLOORS = new Set(['5F', '7F']);
const MOVE_DEDUPE_MS = 90000;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

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

function normalizeFloor(input) {
  const text = String(input || '').trim().toUpperCase();
  if (text === '5층') return '5F';
  if (text === '7층') return '7F';
  return text;
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
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  return text.replace(/-/g, '');
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

async function proxyToGas(payload, gasUrl) {
  const controller = new AbortController();
  const timeoutMs = toPositiveInt(process.env.GAS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store'
    });

    const text = await upstream.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      return {
        status: 502,
        body: {
          ok: false,
          error: {
            code: 'UPSTREAM_BAD_JSON',
            message: 'GAS 응답 JSON 파싱 실패',
            detail: {
              status: upstream.status,
              preview: String(text || '').slice(0, 400)
            }
          }
        }
      };
    }

    return {
      status: upstream.ok ? 200 : upstream.status,
      body: data || {
        ok: false,
        error: {
          code: 'EMPTY_RESPONSE',
          message: 'GAS 응답이 비어 있습니다.'
        }
      }
    };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      status: aborted ? 504 : 502,
      body: {
        ok: false,
        error: {
          code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAIL',
          message: aborted ? 'GAS 응답 시간 초과' : (e?.message || 'GAS 요청 실패')
        }
      }
    };
  } finally {
    clearTimeout(timer);
  }
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
  return await studentQrVerify({
    qrText,
    consume: 'Y',
    shared_secret: getVerifySharedSecret()
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

function success(body) {
  return { status: 200, body };
}

export async function handleKioskMark(payload) {
  const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
  const args = pickArgs(payload);

  const requestedAction = normalizeAction(args.action || args.type);
  const input = String(args.input || '').trim();
  const traceId = buildTraceId(payload);

  const meta = await getAttendanceMetaCached();
  if (!meta.ok) {
    return fail(
      503,
      'META_UNAVAILABLE',
      '운영 상태를 확인할 수 없습니다. 데스크에 문의하세요.'
    );
  }

  const authoritativeFloor = normalizeFloor(String(meta.data?.kiosk_floor || '5F').trim() || '5F');

  if (!ALLOWED_FLOORS.has(authoritativeFloor)) {
    return fail(500, 'CONFIG_REQUIRED', '운영 메타의 kiosk_floor 설정이 올바르지 않습니다.');
  }

  const kioskFloor = authoritativeFloor;

  const safeMode = String(meta.data?.safe?.mode || 'N').trim().toUpperCase() === 'Y';
  const safeMessage = String(meta.data?.safe?.message || '').trim();

  if (safeMode) {
    return fail(503, 'SAFE_MODE', safeMessage || '현재 점검 모드입니다. 데스크에 문의하세요.');
  }

  if (!requestedAction) {
    return fail(400, 'BAD_ACTION', 'action 값이 필요합니다.');
  }

  if (!ALLOWED_ACTIONS.has(requestedAction)) {
    if (gasUrl) return await proxyToGas(payload, gasUrl);
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

  // 예외학생 학번 등·하원도 direct 처리

  if ((requestedAction === 'CHECK_IN' || requestedAction === 'CHECK_OUT') && !isQr && !sidFromIdInput) {
    return fail(400, 'QR_REQUIRED', '등/하원은 전용 QR 또는 예외학생 학번 승인 경로만 사용할 수 있습니다.');
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
      return success({
        ok: true,
        data: {
          duplicate: true,
          alreadyDone: false,
          source: 'supabase-direct',
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
        return fail(400, 'NOT_EXCEPTION', '예외 등록된 학생만 학번으로 등/하원할 수 있습니다.');
      }

      const approved = await hasValidPinApproval(sid);
      if (!approved) {
        return fail(400, 'NEED_PIN', '예외학생은 데스크 PIN 승인이 필요합니다.');
      }
    }

    const { data: todayLogs, error: logsErr } = await getTodayLogs(supabase, sid, yyyymmdd);
    if (logsErr) {
      return fail(500, 'DB_SELECT_FAILED', logsErr.message || '오늘 출결 조회 실패');
    }

    const state = buildTodayState(todayLogs);

    let finalAction = requestedAction;
    let title = '';
    let message = `${student.student_name || verifiedStudentName} (${student.student_id})`;
    let metaJson = {
      actor: '__VERCEL__',
      source: 'supabase-direct',
      input_mode: inputMode
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
          return success({
            ok: true,
            data: {
              duplicate: true,
              alreadyDone: false,
              source: 'supabase-direct',
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