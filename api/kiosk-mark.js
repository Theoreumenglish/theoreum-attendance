import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { studentQrVerify } from '../lib/student-qr-core.js';

const DEFAULT_TIMEOUT_MS = 25000;
const ALLOWED_ACTIONS = new Set(['CHECK_IN', 'CHECK_OUT']);
const ALLOWED_FLOORS = new Set(['5F', '7F']);

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
  return payload?.args && typeof payload.args === 'object' ? payload.args : {};
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
    .select('student_id, student_name, status, qr_id, is_exception')
    .eq('student_id', sid)
    .maybeSingle();

  return { data, error };
}

async function findTodayClassIds(supabase, sid, yyyymmdd) {
  const { data: rels, error: relErr } = await supabase
    .from('class_students')
    .select('class_id')
    .eq('student_id', sid);

  if (relErr) return { error: relErr };

  const classIds = Array.from(
    new Set((rels || []).map(x => String(x.class_id || '').trim()).filter(Boolean))
  );

  if (!classIds.length) return { data: [] };

  const { data: schedules, error: schErr } = await supabase
    .from('class_schedule')
    .select('class_id, class_name, teacher, start, end, status, reason')
    .eq('yyyymmdd', yyyymmdd)
    .in('class_id', classIds)
    .eq('status', 'SCHEDULED')
    .order('start', { ascending: true });

  if (schErr) return { error: schErr };

  return { data: schedules || [] };
}

async function findExistingTodayAction(supabase, sid, yyyymmdd, actionType) {
  const { data, error } = await supabase
    .from('attendance_logs')
    .select('record_id, action_type, ts, trace_id')
    .eq('student_id', sid)
    .eq('yyyymmdd', yyyymmdd)
    .eq('action_type', actionType)
    .eq('result', 'OK')
    .order('ts', { ascending: false })
    .limit(1)
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

async function insertAttendanceLog(supabase, record) {
  const { data, error } = await supabase
    .from('attendance_logs')
    .insert([record])
    .select()
    .single();

  return { data, error };
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

export async function handleKioskMark(payload) {
  const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
  const args = pickArgs(payload);

  const action = normalizeAction(args.action || args.type);
  const input = String(args.input || '').trim();
  const kioskFloor = normalizeFloor(args.kiosk_floor || args.floor || args.kioskFloor || '5F');
  const traceId = buildTraceId(payload);

  if (!action) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'BAD_ACTION',
          message: 'action 값이 필요합니다.'
        }
      }
    };
  }

  if (!ALLOWED_ACTIONS.has(action)) {
    if (gasUrl) {
      return await proxyToGas(payload, gasUrl);
    }

    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'BAD_ACTION',
          message: '현재 Vercel 직처리는 CHECK_IN / CHECK_OUT만 지원합니다.'
        }
      }
    };
  }

  if (!input) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'BAD_INPUT',
          message: 'input 값이 필요합니다.'
        }
      }
    };
  }

  if (!ALLOWED_FLOORS.has(kioskFloor)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'BAD_KIOSK_FLOOR',
          message: 'kiosk_floor는 5F 또는 7F여야 합니다.'
        }
      }
    };
  }

  const isQr = isStudentQrText(input);
  const sidFromIdInput = normalizeStudentId(input);

  console.info('[kiosk.mark] entered', {
    action,
    kioskFloor,
    isQr,
    inputPreview: input.slice(0, 24),
    hasSessionToken: !!payload?.sessionToken
  });

  // 예외학생 4자리 입력 경로는 정책 보존을 위해 GAS에 남긴다.
  // 본질적 속도 패치는 학생 QR 등/하원 핫패스만 Vercel 직처리한다.
  if (!isQr && sidFromIdInput && gasUrl) {
    return await proxyToGas(payload, gasUrl);
  }

  if (!isQr && !sidFromIdInput) {
    if (gasUrl) {
      return await proxyToGas(payload, gasUrl);
    }

    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'QR_REQUIRED',
          message: '등/하원은 전용 QR만 사용할 수 있습니다.'
        }
      }
    };
  }

  try {
    const supabase = getSupabaseAdmin();
    const yyyymmdd = formatYmdKst(new Date());

    const { data: traceExisting, error: traceErr } = await findExistingTrace(supabase, traceId);
    if (traceErr) {
      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: 'DB_SELECT_FAILED',
            message: traceErr.message || 'attendance_logs trace 조회 실패'
          }
        }
      };
    }

    if (traceExisting) {
      return {
        status: 200,
        body: {
          ok: true,
          duplicate: true,
          record: traceExisting,
          traceId
        }
      };
    }

    let sid = sidFromIdInput;
    let inputMode = 'ID';
    let qrId = '';
    let verifiedStudentName = '';

    if (isQr) {
      const verifyOut = await verifyStudentQrDirect(input);

      if (!verifyOut.ok) {
        return mapQrVerifyError(verifyOut.error);
      }

      sid = normalizeStudentId(verifyOut.data?.student_id);
      inputMode = 'QR';
      qrId = String(verifyOut.data?.qr_id || '').trim();
      verifiedStudentName = String(verifyOut.data?.student_name || '').trim();

      if (!sid) {
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'SERVER_ERROR',
              message: 'QR 검증 결과에 student_id가 없습니다.'
            }
          }
        };
      }
    }

    const { data: student, error: studentErr } = await findStudent(supabase, sid);
    if (studentErr) {
      console.error('[kiosk.mark] student read failed', {
        sid,
        message: studentErr.message || String(studentErr)
      });

      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: 'SUPABASE_STUDENT_READ_FAIL',
            message: studentErr.message || 'students 조회 실패'
          }
        }
      };
    }

    if (!student) {
      return {
        status: 404,
        body: {
          ok: false,
          error: {
            code: 'STUDENT_NOT_FOUND',
            message: '학생을 찾지 못했습니다.'
          }
        }
      };
    }

    if (!isActiveStudentStatus(student.status)) {
      return {
        status: 403,
        body: {
          ok: false,
          error: {
            code: 'NOT_ACTIVE',
            message: '재원 상태 학생만 출결 처리할 수 있습니다.'
          }
        }
      };
    }

    const { data: todaySchedules, error: scheduleErr } = await findTodayClassIds(supabase, sid, yyyymmdd);
    if (scheduleErr) {
      console.error('[kiosk.mark] today schedule read failed', {
        sid,
        yyyymmdd,
        message: scheduleErr.message || String(scheduleErr)
      });

      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: 'SUPABASE_SCHEDULE_READ_FAIL',
            message: scheduleErr.message || 'class_schedule 조회 실패'
          }
        }
      };
    }

    const schedules = Array.isArray(todaySchedules) ? todaySchedules : [];
    const hasTodaySchedule = schedules.length > 0;
    const primarySchedule = hasTodaySchedule ? schedules[0] : null;

    const now = new Date();
    const nowMs = now.getTime();

    const { data: existingAction, error: existingErr } = await findExistingTodayAction(
      supabase,
      sid,
      yyyymmdd,
      action
    );

    if (existingErr) {
      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: 'DB_SELECT_FAILED',
            message: existingErr.message || '기존 출결 조회 실패'
          }
        }
      };
    }

    const sameActionCooldownMs = toPositiveInt(
      process.env.KIOSK_SAME_ACTION_COOLDOWN_MS,
      15000
    );

    if (existingAction) {
      const prevTs = Date.parse(String(existingAction.ts || ''));
      const diffMs = Number.isFinite(prevTs) ? (nowMs - prevTs) : Number.MAX_SAFE_INTEGER;

      if (diffMs >= 0 && diffMs < sameActionCooldownMs) {
        return {
          status: 200,
          body: {
            ok: true,
            data: {
              duplicate: false,
              alreadyDone: true,
              source: 'supabase-direct',
              action,
              input,
              student,
              schedule: primarySchedule,
              ui: {
                title: action === 'CHECK_IN' ? '중복 등원 스캔' : '중복 하원 스캔',
                message: `${student.student_name} (${student.student_id}) · ${Math.ceil((sameActionCooldownMs - diffMs) / 1000)}초 이내 중복 스캔`
              }
            },
            traceId
          }
        };
      }
    }

    const record = {
      record_id: buildRecordId(),
      ts: now.toISOString(),
      yyyymmdd,
      student_id: sid,
      action_type: action,
      kiosk_floor: kioskFloor,
      meta_json: {
        actor: '__VERCEL__',
        input_mode: inputMode,
        source: 'supabase-direct',
        has_today_schedule: hasTodaySchedule ? 'Y' : 'N',
        class_id: primarySchedule ? primarySchedule.class_id : '',
        class_name: primarySchedule ? (primarySchedule.class_name || '') : '',
        today_class_ids: schedules.map(x => String(x.class_id || '').trim()).filter(Boolean),
        qr_verify_direct: inputMode === 'QR' ? 'Y' : 'N'
      },
      result: 'OK',
      deny_reason: '',
      qr_id: inputMode === 'QR'
        ? (qrId || String(student.qr_id || '').trim())
        : '',
      trace_id: traceId
    };

    const { data: inserted, error: insertErr } = await insertAttendanceLog(supabase, record);
    if (insertErr) {
      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: 'DB_INSERT_FAILED',
            message: insertErr.message || 'attendance_logs insert 실패'
          }
        }
      };
    }

    console.info('[kiosk.mark] supabase direct success', {
      sid,
      yyyymmdd,
      action,
      classId: primarySchedule ? primarySchedule.class_id : '',
      hasTodaySchedule,
      inputMode,
      traceId
    });

    return {
      status: 200,
      body: {
        ok: true,
        data: {
          duplicate: false,
          alreadyDone: false,
          source: 'supabase-direct',
          action,
          input,
          student: {
            ...student,
            student_name: student.student_name || verifiedStudentName || ''
          },
          schedule: primarySchedule,
          ui: {
            title: action === 'CHECK_IN' ? '등원 완료' : '하원 완료',
            message: hasTodaySchedule
              ? `${student.student_name || verifiedStudentName} (${student.student_id})`
              : `${student.student_name || verifiedStudentName} (${student.student_id}) · 오늘 수업 정보 없음`
          }
        },
        traceId,
        record: inserted
      }
    };
  } catch (e) {
    console.error('[kiosk.mark] direct handler exception', {
      message: e?.message || String(e)
    });

    if (gasUrl) {
      return await proxyToGas(payload, gasUrl);
    }

    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'SERVER_ERROR',
          message: e?.message || 'kiosk.mark 처리 실패'
        }
      }
    };
  }
}