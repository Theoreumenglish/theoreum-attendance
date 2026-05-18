import { getSupabaseAdmin } from './supabase-admin.js';
import { proxyRpcToGas } from './gas-rpc-proxy.js';
import { authMeDirect } from './staff-auth.js';

function normalizeRole(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'assistant';
  if (['assistant', 'staff', '조교'].includes(v)) return 'assistant';
  if (['teacher', '강사'].includes(v)) return 'teacher';
  if (['admin', 'owner', '관리자', '오너', '원장'].includes(v)) {
    return v === 'owner' || v === '오너' || v === '원장' ? 'owner' : 'admin';
  }
  return v;
}

function roleLevel(role) {
  const r = normalizeRole(role);
  if (r === 'assistant') return 1;
  if (r === 'teacher') return 2;
  if (r === 'admin' || r === 'owner') return 4;
  return 0;
}

function hasRoleAtLeast(role, need) {
  return roleLevel(role) >= roleLevel(need);
}

function normalizeStudentId(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

function isStrictYmd(raw) {
  const v = String(raw || '').trim();
  if (!/^\d{8}$/.test(v)) return false;

  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));

  if (m < 1 || m > 12 || d < 1 || d > 31) return false;

  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === (m - 1) &&
    dt.getUTCDate() === d;
}

function endOfKstDayIso(yyyymmdd) {
  const y = Number(String(yyyymmdd || '').slice(0, 4));
  const m = Number(String(yyyymmdd || '').slice(4, 6));
  const d = Number(String(yyyymmdd || '').slice(6, 8));

  return new Date(Date.UTC(y, m - 1, d, 14, 59, 59, 999)).toISOString();
}

function normalizeUntilIso(raw, yyyymmdd) {
  const s = String(raw || '').trim();

  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  return endOfKstDayIso(yyyymmdd);
}

export async function adminSetStudentExceptionHybrid(args = {}, sessionToken = '') {
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const yn = String(args.is_exception || args.isException || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N';
  const note = String(args.exception_note || args.note || '').trim().slice(0, 200);

  if (!sid) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: '학번 4자리가 필요합니다.'
        }
      }
    };
  }

  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });
  if (!me || !me.loggedIn) {
    return {
      status: 401,
      body: {
        ok: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: '로그인이 필요합니다.'
        }
      }
    };
  }

  if (!hasRoleAtLeast(me.role, 'admin')) {
    return {
      status: 403,
      body: {
        ok: false,
        error: {
          code: 'NO_PERMISSION',
          message: '상시 학번 직접 출결 허용 학생은 관리자/원장만 변경할 수 있습니다.'
        }
      }
    };
  }

  const gasResult = await proxyRpcToGas(
    'bridge.student.exception.set',
    {
      student_id: sid,
      is_exception: yn,
      exception_note: note,
      actor_staff_id: me.staff_id,
      actor_role: normalizeRole(me.role),
      actor_name: String(me.name || '')
    },
    ''
  );

  if (!gasResult.body || gasResult.body.ok !== true) {
    return gasResult;
  }

  let replicaPatched = false;
  let replicaPatchError = '';

  try {
    const supabase = getSupabaseAdmin();

    const { data: patched, error } = await supabase
      .from('students')
      .update({
        is_exception: yn,
        exception_note: yn === 'Y' ? note : ''
      })
      .eq('student_id', sid)
      .select('student_id, student_name, is_exception, exception_note')
      .maybeSingle();

    if (error) {
      replicaPatchError = error.message || 'students update 실패';
    } else if (!patched) {
      replicaPatchError = 'students replica row 없음';
    } else {
      replicaPatched = true;
    }
  } catch (e) {
    replicaPatchError = e?.message || 'students replica patch 실패';
  }

  return {
    status: gasResult.status || 200,
    body: {
      ...gasResult.body,
      data: {
        ...(gasResult.body.data || {}),
        student_id: sid,
        is_exception: yn,
        exception_note: yn === 'Y' ? note : '',
        source: 'central_db_bridge',
        replicaPatched,
        replicaPatchError
      }
    }
  };
}

export async function assistantUpsertAbsenceExcuseHybrid(args = {}, sessionToken = '') {
  const classId = String(args.class_id || '').trim();
  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');
  const reason = String(args.reason || '').trim().slice(0, 300);
  const untilMin = Number(args.until_min || args.untilMin || 0);

  if (!classId || classId === '*') {
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'class_id가 필요합니다.' }
      }
    };
  }

  if (!isStrictYmd(yyyymmdd)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'yyyymmdd 8자리가 필요합니다.' }
      }
    };
  }

  if (!sid) {
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: 'INVALID_INPUT', message: '학번 4자리가 필요합니다.' }
      }
    };
  }

  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });
  if (!me || !me.loggedIn) {
    return {
      status: 401,
      body: {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' }
      }
    };
  }

  if (!hasRoleAtLeast(me.role, 'assistant')) {
    return {
      status: 403,
      body: {
        ok: false,
        error: { code: 'NO_PERMISSION', message: '조교 이상 권한이 필요합니다.' }
      }
    };
  }

  const gasResult = await proxyRpcToGas(
    'bridge.absence_excuse.upsert',
    {
      class_id: classId,
      yyyymmdd,
      student_id: sid,
      reason,
      until_min: Number.isFinite(untilMin) ? untilMin : 0,
      actor_staff_id: me.staff_id,
      actor_role: normalizeRole(me.role),
      actor_name: String(me.name || '')
    },
    ''
  );

  if (!gasResult.body || gasResult.body.ok !== true) {
    return gasResult;
  }

  const item = gasResult.body?.data?.item || {};
  let replicaPatched = false;
  let replicaPatchError = '';

  try {
    if (!item.excuse_id) {
      replicaPatchError = 'bridge 응답에 excuse_id가 없습니다.';
    } else {
      const supabase = getSupabaseAdmin();
      const now = new Date().toISOString();

      const row = {
        excuse_id: String(item.excuse_id || '').trim(),
        class_id: classId,
        yyyymmdd,
        student_id: sid,
        reason: String(item.reason || reason).trim(),
        until_ts: normalizeUntilIso(item.until_ts, yyyymmdd),
        created_at: String(item.created_at || now),
        created_by: String(item.created_by || me.staff_id),
        updated_at: String(item.updated_at || now),
        updated_by: String(item.updated_by || me.staff_id),
        synced_at: now
      };

      const { error } = await supabase
        .from('absence_excuses')
        .upsert([row], {
          onConflict: 'class_id,yyyymmdd,student_id'
        });

      if (error) {
        replicaPatchError = error.message || 'absence_excuses upsert 실패';
      } else {
        replicaPatched = true;
      }
    }
  } catch (e) {
    replicaPatchError = e?.message || 'absence_excuses replica patch 실패';
  }

  return {
    status: gasResult.status || 200,
    body: {
      ...gasResult.body,
      data: {
        ...(gasResult.body.data || {}),
        source: 'central_db_bridge',
        replicaPatched,
        replicaPatchError
      }
    }
  };
}

export async function assistantRemoveAbsenceExcuseHybrid(args = {}, sessionToken = '') {
  const classId = String(args.class_id || '').trim();
  const yyyymmdd = String(args.yyyymmdd || args.ymd || '').trim();
  const sid = normalizeStudentId(args.student_id || args.sid || '');

  if (!classId || !isStrictYmd(yyyymmdd) || !sid) {
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: '삭제 시 class_id / yyyymmdd / 학번이 모두 필요합니다.'
        }
      }
    };
  }

  const me = await authMeDirect(String(sessionToken || '').trim(), { touch: true });
  if (!me || !me.loggedIn) {
    return {
      status: 401,
      body: {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' }
      }
    };
  }

  if (!hasRoleAtLeast(me.role, 'assistant')) {
    return {
      status: 403,
      body: {
        ok: false,
        error: { code: 'NO_PERMISSION', message: '조교 이상 권한이 필요합니다.' }
      }
    };
  }

  const gasResult = await proxyRpcToGas(
    'bridge.absence_excuse.remove',
    {
      class_id: classId,
      yyyymmdd,
      student_id: sid,
      actor_staff_id: me.staff_id,
      actor_role: normalizeRole(me.role),
      actor_name: String(me.name || '')
    },
    ''
  );

  if (!gasResult.body || gasResult.body.ok !== true) {
    return gasResult;
  }

  let replicaPatched = false;
  let replicaPatchError = '';

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('absence_excuses')
      .delete()
      .eq('class_id', classId)
      .eq('yyyymmdd', yyyymmdd)
      .eq('student_id', sid);

    if (error) {
      replicaPatchError = error.message || 'absence_excuses delete 실패';
    } else {
      replicaPatched = true;
    }
  } catch (e) {
    replicaPatchError = e?.message || 'absence_excuses replica delete 실패';
  }

  return {
    status: gasResult.status || 200,
    body: {
      ...gasResult.body,
      data: {
        ...(gasResult.body.data || {}),
        source: 'central_db_bridge',
        replicaPatched,
        replicaPatchError
      }
    }
  };
}