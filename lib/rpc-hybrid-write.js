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

export async function teacherSetExceptionHybrid(args = {}, sessionToken = '') {
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

  if (!hasRoleAtLeast(me.role, 'teacher')) {
    return {
      status: 403,
      body: {
        ok: false,
        error: {
          code: 'NO_PERMISSION',
          message: 'teacher 이상 권한이 필요합니다.'
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