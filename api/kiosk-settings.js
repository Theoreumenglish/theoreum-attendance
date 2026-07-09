import crypto from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  readRuntimeMeta,
  writeRuntimeConfig,
  appendRuntimeConfigAudit,
  normalizeFloor
} from './_runtime-meta.js';

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

function normalizeStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (['active', '재직', '활성', 'enabled', '1', 'y', 'yes', 'true'].includes(v)) return 'active';
  return 'inactive';
}

function normalizeRevoked(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return ['y', 'yes', '1', 'true', 'revoked', '중지', '해지', '퇴사'].includes(v) ? 'Y' : 'N';
}

function normalizeRole(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (['owner', '오너', '원장'].includes(v)) return 'owner';
  if (['admin', '관리자'].includes(v)) return 'admin';
  if (['teacher', '강사'].includes(v)) return 'teacher';
  if (['assistant', 'staff', '조교'].includes(v)) return 'assistant';
  return v || 'assistant';
}

function getPepper() {
  const pepper = String(process.env.AUTH_PEPPER || process.env.SYS_PEPPER || '').trim();
  if (!pepper) throw new Error('AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.');
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

function isMissingTableError(tableName, error) {
  const table = String(tableName || '').toLowerCase();
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  return (
    code === 'PGRST205' ||
    message.includes('could not find the table') ||
    message.includes(table + "'") ||
    message.includes(table + '"') ||
    details.includes(table)
  );
}

async function readPinRowsFrom(tableName) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(tableName)
    .select('staff_id, name, role, status, revoked, pin_hash, pin_salt')
    .not('pin_hash', 'is', null)
    .not('pin_salt', 'is', null)
    .limit(100);

  if (error) return { data: [], error, table: tableName };
  return { data: Array.isArray(data) ? data : [], error: null, table: tableName };
}

async function verifyAnyActiveStaffPin(pin) {
  const plainPin = String(pin || '').replace(/\D/g, '').slice(0, 8);
  if (!plainPin) {
    return { ok: false, status: 400, error: { code: 'INVALID_INPUT', message: 'PIN을 입력하세요.' } };
  }

  let hashError = null;
  const reads = await Promise.all([
    readPinRowsFrom('staff_snapshot'),
    readPinRowsFrom('staff')
  ]);

  const rows = [];
  for (const read of reads) {
    if (!read.error || isMissingTableError(read.table, read.error)) {
      rows.push(...read.data);
      continue;
    }
    return {
      ok: false,
      status: 500,
      error: { code: 'DB_SELECT_FAILED', message: read.error.message || '직원 PIN 조회 실패' }
    };
  }

  const byId = new Map();
  for (const row of rows) {
    const staffId = String(row?.staff_id || '').trim();
    if (!staffId || byId.has(staffId)) continue;
    byId.set(staffId, row);
  }

  for (const row of byId.values()) {
    if (normalizeStatus(row.status) !== 'active' || normalizeRevoked(row.revoked) === 'Y') continue;

    const salt = String(row.pin_salt || '').trim();
    const hash = String(row.pin_hash || '').trim();
    if (!salt || !hash) continue;

    try {
      if (hashWithSalt(plainPin, salt) === hash) {
        return {
          ok: true,
          staff_id: String(row.staff_id || '').trim(),
          name: String(row.name || row.staff_id || '').trim(),
          role: normalizeRole(row.role || '')
        };
      }
    } catch (e) {
      hashError = e;
    }
  }

  if (hashError) {
    return {
      ok: false,
      status: 500,
      error: { code: 'CONFIG_REQUIRED', message: hashError?.message || 'AUTH_PEPPER 또는 SYS_PEPPER가 필요합니다.' }
    };
  }

  return {
    ok: false,
    status: 401,
    error: { code: 'AUTH_FAILED', message: 'PIN이 올바르지 않습니다.' }
  };
}

export async function handleKioskSettings(payload) {
  const args = payload?.args && typeof payload.args === 'object'
    ? payload.args
    : (payload && typeof payload === 'object' ? payload : {});

  const floor = normalizeFloor(args.kiosk_floor || args.floor || args.kioskFloor || '');
  const pin = String(args.pin || args.kiosk_pin || args.kioskPin || '').replace(/\D/g, '').slice(0, 8);

  if (!floor || !['5F', '7F'].includes(floor)) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'INVALID_INPUT', message: '층은 5F 또는 7F만 가능합니다.' } }
    };
  }

  const pinCheck = await verifyAnyActiveStaffPin(pin);
  if (!pinCheck.ok) {
    return { status: pinCheck.status || 401, body: { ok: false, error: pinCheck.error } };
  }

  const beforeMeta = await readRuntimeMeta(true);
  if (!beforeMeta.ok) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: beforeMeta.error?.code || 'DB_SELECT_FAILED',
          message: beforeMeta.error?.message || 'runtime_config 조회 실패'
        }
      }
    };
  }

  const writer = pinCheck.staff_id || 'kiosk-settings';
  const write = await writeRuntimeConfig('kiosk_floor', { value: floor }, writer);
  if (write.error) {
    return {
      status: 500,
      body: { ok: false, error: { code: 'DB_UPSERT_FAILED', message: write.error.message || '층 설정 저장 실패' } }
    };
  }

  const audit = await appendRuntimeConfigAudit({
    key: 'kiosk_floor',
    before_json: { value: beforeMeta.data?.kiosk_floor || '' },
    after_json: { value: floor },
    changed_by: writer
  });

  if (!audit.ok) {
    return {
      status: 500,
      body: { ok: false, error: { code: 'DB_AUDIT_FAILED', message: audit.error?.message || '층 설정 감사 로그 저장 실패' } }
    };
  }

  const meta = await readRuntimeMeta(true);
  return {
    status: 200,
    body: {
      ok: true,
      data: {
        ...(meta.data || {}),
        kiosk_floor: floor,
        changed_by: writer,
        changed_by_name: pinCheck.name || writer,
        source: 'kiosk-settings-pin-v33',
        perf: { path: 'kiosk_settings_pin_no_admin_session_v33' }
      }
    }
  };
}

export default async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' } });
  }

  let payload = {};
  try {
    payload = parseBody(req);
  } catch (_) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' } });
  }

  try {
    const out = await handleKioskSettings(payload);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: { code: 'SERVER_ERROR', message: e?.message || '키오스크 설정 저장 실패' }
    });
  }
}
