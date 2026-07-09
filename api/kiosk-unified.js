import { handleKioskMark } from './kiosk-mark.js';
import { handleStaffClock } from './staff-clock.js';

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
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

function pickArgs(payload) {
  return payload?.args && typeof payload.args === 'object'
    ? payload.args
    : (payload && typeof payload === 'object' ? payload : {});
}

function normalizeAction(input) {
  const text = String(input || '').trim().toUpperCase();
  if (text === 'IN' || text === 'CHECKIN' || text === 'CHECK_IN') return 'CHECK_IN';
  if (text === 'OUT' || text === 'CHECKOUT' || text === 'CHECK_OUT') return 'CHECK_OUT';
  if (text === 'MOVE') return 'MOVE';
  if (text === 'OUTING') return 'OUTING';
  return text;
}

function normalizeDigits(input) {
  return String(input || '').replace(/[^0-9]/g, '');
}

function normalizePhoneTail8(input) {
  const digits = normalizeDigits(input);
  if (/^010\d{8}$/.test(digits)) return digits.slice(-8);
  if (/^\d{8}$/.test(digits)) return digits;
  return '';
}

function isQrInput(input) {
  const raw = String(input || '').trim();
  return /^(?:QR(?:1|2)|Q3|STAFFQR1)\./i.test(raw);
}

function isStudentNotFound(out) {
  const code = String(out?.body?.error?.code || '').trim();
  return out?.status === 404 && [
    'PHONE_NOT_FOUND',
    'STUDENT_NOT_FOUND',
    'NOT_FOUND'
  ].includes(code);
}

function success(body) {
  return { status: 200, body };
}

export async function handleKioskUnified(payload) {
  const args = pickArgs(payload);
  const action = normalizeAction(args.action || args.type || '');
  const input = String(args.input || args.phone_tail8 || args.phone || '').trim();
  const phoneTail8 = normalizePhoneTail8(input);
  const traceId = String(
    payload?.traceId ||
    payload?.trace_id ||
    args?.traceId ||
    args?.trace_id ||
    ('vercel-unified-' + Date.now().toString(36))
  ).trim();

  if (!action) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'INVALID_INPUT', message: '출결 종류를 선택하세요.' } }
    };
  }

  const studentOut = await handleKioskMark({
    ...payload,
    traceId,
    trace_id: traceId,
    args: {
      ...args,
      action,
      input
    }
  });

  if (studentOut?.body?.ok) {
    const data = studentOut.body.data || {};
    return success({
      ...studentOut.body,
      data: {
        ...data,
        identity_type: 'student',
        unified: true,
        perf: {
          ...(data.perf || {}),
          unified_path: 'student_first_v33'
        }
      }
    });
  }

  // 교실 이동/외출·복귀, QR은 학생 전용이다. 학생 실패를 직원 처리로 바꾸지 않는다.
  if (!['CHECK_IN', 'CHECK_OUT'].includes(action) || isQrInput(input) || !phoneTail8 || !isStudentNotFound(studentOut)) {
    return studentOut;
  }

  const staffAction = action === 'CHECK_OUT' ? 'OUT' : 'IN';
  const staffOut = await handleStaffClock({
    ...payload,
    traceId: traceId + '-staff',
    trace_id: traceId + '-staff',
    args: {
      action: staffAction,
      phone_tail8: phoneTail8,
      input_mode: 'PHONE_LAST8',
      note: 'KIOSK_UNIFIED_PHONE_LAST8'
    }
  });

  if (!staffOut?.body?.ok) return staffOut;

  const staffData = staffOut.body.data?.data || staffOut.body.data || {};
  const name = String(staffData.name || '직원').trim();
  const title = staffAction === 'OUT' ? '직원 퇴근' : '직원 출근';

  return success({
    ok: true,
    data: {
      ok: true,
      duplicate: !!staffData.duplicate,
      alreadyDone: false,
      identity_type: 'staff',
      unified: true,
      staff: staffData,
      perf: {
        path: 'unified_staff_fallback_v33',
        staff_path: staffData.perf?.path || '',
        phone_lookup_fast: staffData.perf?.phone_lookup_fast || ''
      },
      ui: {
        title,
        message: name + ' (직원)'
      }
    },
    traceId,
    record: staffOut.body.record || null,
    daily: staffOut.body.daily || null,
    monthly: staffOut.body.monthly || null
  });
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
      error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' }
    });
  }

  try {
    const out = await handleKioskUnified(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: 'SERVER_ERROR', message: e?.message || '통합 키오스크 처리 실패' }
    });
  }
}
