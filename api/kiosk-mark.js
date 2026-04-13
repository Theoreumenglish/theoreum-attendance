import { getSupabaseAdmin } from '../lib/supabase-admin.js';

const DEFAULT_TIMEOUT_MS = 25000;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeStudentId(input) {
  const digits = String(input || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
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

export async function handleKioskMark(payload) {
  const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
  const action = String(payload?.args?.action || '').trim().toUpperCase();
  const input = String(payload?.args?.input || '').trim();

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

  console.info('[kiosk.mark] entered', {
    action,
    inputPreview: input.slice(0, 20),
    hasSessionToken: !!payload?.sessionToken
  });

  const sid = normalizeStudentId(input);

  if (sid) {
    try {
      const supabase = getSupabaseAdmin();

      const { data: student, error: studentErr } = await supabase
        .from('students')
        .select('student_id, student_name, status, qr_id, is_exception')
        .eq('student_id', sid)
        .maybeSingle();

      if (studentErr) {
        console.error('[kiosk.mark] supabase student read failed', {
          sid,
          message: studentErr.message || String(studentErr)
        });

        if (gasUrl) {
          return await proxyToGas(payload, gasUrl);
        }

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

      if (student) {
        console.info('[kiosk.mark] supabase direct hit', {
          sid: student.student_id,
          source: 'supabase-direct'
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
              student,
              ui: {
                title: 'Supabase 직조회 성공',
                message: (student.student_name || '학생') + ' (' + student.student_id + ')'
              }
            },
            traceId: 'supabase-direct-' + Date.now()
          }
        };
      }

      console.warn('[kiosk.mark] student not found in supabase, fallback to gas', {
        sid
      });
    } catch (e) {
      console.error('[kiosk.mark] supabase direct exception', {
        sid,
        message: e?.message || String(e)
      });
    }
  }

  if (!gasUrl) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'CONFIG_REQUIRED',
          message: 'Vercel 환경변수 GAS_WEBAPP_URL이 없습니다.'
        }
      }
    };
  }

  return await proxyToGas(payload, gasUrl);
}