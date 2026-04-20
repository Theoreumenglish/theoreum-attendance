import { getSupabaseAdmin } from './supabase-admin.js';
import { proxyRpcToGas } from './gas-rpc-proxy.js';

function normalizeStudentId(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.slice(-4).padStart(4, '0');
}

export async function teacherSetExceptionHybrid(args = {}, sessionToken = '') {
  const sid = normalizeStudentId(args.student_id);
  const yn = String(args.is_exception || args.isException || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N';
  const note = String(args.exception_note || args.note || '').trim();

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

  const gasResult = await proxyRpcToGas(
    'teacher.setException',
    {
      ...args,
      student_id: sid,
      is_exception: yn,
      exception_note: note
    },
    sessionToken
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
        is_exception: yn
      })
      .eq('student_id', sid)
      .select('student_id')
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

  const body = {
    ...gasResult.body,
    data: {
      ...(gasResult.body.data || {}),
      student_id: sid,
      is_exception: yn,
      exception_note: note,
      replicaPatched,
      replicaPatchError
    }
  };

  return {
    status: gasResult.status || 200,
    body
  };
}