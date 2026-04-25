import crypto from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

function normalizeStaffId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

function normalizeStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'inactive';
  if (['active', '재직', '활성', 'enabled', '1', 'y', 'yes', 'true'].includes(v)) return 'active';
  if (['inactive', '비활성', '퇴사', 'disabled', '0', 'n', 'no', 'false'].includes(v)) return 'inactive';
  return 'inactive';
}

function normalizeRevoked(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return ['y', 'yes', '1', 'true', 'revoked', '중지', '해지', '퇴사'].includes(v) ? 'Y' : 'N';
}

function getPepper() {
  const pepper = String(
    process.env.AUTH_PEPPER ||
    process.env.SYS_PEPPER ||
    ''
  ).trim();

  if (!pepper) {
    throw new Error('AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.');
  }

  return pepper;
}

function hashWithSalt(plain, salt) {
  const pepper = getPepper();
  let hashStr = String(plain || '') + '|' + String(salt || '') + '|' + pepper;

  for (let i = 0; i < 3000; i++) {
    hashStr = crypto.createHash('sha256').update(hashStr, 'utf8').digest('hex');
  }
  return hashStr;
}

async function readStaffPinRecord(supabase, staffId) {
  const sid = normalizeStaffId(staffId);

  const { data: snap, error: snapErr } = await supabase
    .from('staff_snapshot')
    .select('staff_id, pin_hash, pin_salt, status, revoked')
    .eq('staff_id', sid)
    .maybeSingle();

  if (snapErr) return { data: null, error: snapErr };
  if (snap) return { data: snap, error: null };

  const { data: staff, error: staffErr } = await supabase
    .from('staff')
    .select('staff_id, pin_hash, pin_salt, status, revoked')
    .eq('staff_id', sid)
    .maybeSingle();

  return { data: staff || null, error: staffErr };
}

export async function verifyAdminPinByStaffId(staffId, pin) {
  const sid = normalizeStaffId(staffId);
  const plainPin = String(pin || '').trim();

  if (!sid) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: 'staff_id가 필요합니다.' }
    };
  }

  if (!plainPin) {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: '관리자 PIN이 필요합니다.' }
    };
  }

  const supabase = getSupabaseAdmin();
  const { data: staff, error } = await readStaffPinRecord(supabase, sid);

  if (error) {
    return {
      ok: false,
      error: { code: 'DB_SELECT_FAILED', message: error.message || 'staff PIN 조회 실패' }
    };
  }

  if (!staff) {
    return {
      ok: false,
      error: { code: 'NOT_FOUND', message: '직원 계정을 찾지 못했습니다.' }
    };
  }

  if (normalizeStatus(staff.status) !== 'active' || normalizeRevoked(staff.revoked) === 'Y') {
    return {
      ok: false,
      error: { code: 'NOT_ALLOWED', message: '현재 사용 가능한 직원 계정이 아닙니다.' }
    };
  }

  const salt = String(staff.pin_salt || '').trim();
  const hash = String(staff.pin_hash || '').trim();

  if (!salt || !hash) {
    return {
      ok: false,
      error: { code: 'AUTH_FAILED', message: 'PIN이 설정되지 않은 계정입니다.' }
    };
  }

  try {
    if (hashWithSalt(plainPin, salt) !== hash) {
      return {
        ok: false,
        error: { code: 'AUTH_FAILED', message: '관리자 PIN이 올바르지 않습니다.' }
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: { code: 'CONFIG_REQUIRED', message: e?.message || 'AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.' }
    };
  }

  return { ok: true };
}