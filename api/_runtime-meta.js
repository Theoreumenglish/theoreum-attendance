import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

// v31 kiosk-speed: floor/safe-mode metadata should not hit Supabase on every check-in.
// Kiosk settings writes invalidate this cache; safe-mode changes may take up to 10s per warm runtime.
const RUNTIME_META_CACHE_TTL_MS = 10000;

let runtimeMetaCache = null;
let runtimeMetaCacheExp = 0;

export function normalizeFloor(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === '5층') return '5F';
  if (text === '7층') return '7F';
  if (text === '5F' || text === '7F') return text;
  return '';
}

export function normalizeYn(raw, fallback = 'N') {
  const text = String(raw == null ? fallback : raw).trim().toUpperCase();
  return text === 'Y' ? 'Y' : 'N';
}

function buildEnvMeta() {
  const kioskFloor = normalizeFloor(process.env.KIOSK_FLOOR || '5F') || '5F';
  const safeMode = normalizeYn(process.env.SAFE_MODE_DEFAULT || 'N');

  return {
    version: 'vercel-direct',
    tz: 'Asia/Seoul',
    kiosk_floor: kioskFloor,
    safe: {
      mode: safeMode,
      message: String(process.env.SAFE_MODE_MESSAGE || '').trim()
    },
    props_missing: [],
    staff_mode: '',
    disabled_ops: [],
    logo_url_set: false,
    logo_url_normalized: '',
    source: 'env'
  };
}

function isMissingTable(tableName, error) {
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const table = String(tableName || '').toLowerCase();

  return (
    (message.includes(table) && message.includes('does not exist')) ||
    (details.includes(table) && details.includes('does not exist'))
  );
}

function applyRuntimeRowsToMeta(rows, baseMeta) {
  const next = {
    ...baseMeta,
    safe: { ...(baseMeta.safe || {}) },
    source: 'runtime_config'
  };

  for (const row of rows || []) {
    const key = String(row?.key || '').trim();
    const value = row?.value_json && typeof row.value_json === 'object' ? row.value_json : {};

    if (key === 'kiosk_floor') {
      const floor = normalizeFloor(value.value || value.kiosk_floor || '');
      if (floor) next.kiosk_floor = floor;
      continue;
    }

    if (key === 'safe_mode') {
      next.safe.mode = normalizeYn(value.mode || value.value || next.safe.mode || 'N');
      next.safe.message = String(value.message || '').trim();
    }
  }

  return next;
}

export async function readRuntimeMeta(force = false) {
  const now = Date.now();
  if (!force && runtimeMetaCache && now < runtimeMetaCacheExp) {
    return { ok: true, data: runtimeMetaCache };
  }

  const envMeta = buildEnvMeta();
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('runtime_config')
    .select('key, value_json')
    .in('key', ['kiosk_floor', 'safe_mode']);

  if (error) {
    if (isMissingTable('runtime_config', error)) {
      runtimeMetaCache = envMeta;
      runtimeMetaCacheExp = now + RUNTIME_META_CACHE_TTL_MS;
      return { ok: true, data: envMeta };
    }

    return {
      ok: false,
      error: {
        code: 'DB_SELECT_FAILED',
        message: error.message || 'runtime_config 조회 실패'
      }
    };
  }

  const merged = applyRuntimeRowsToMeta(data || [], envMeta);
  runtimeMetaCache = merged;
  runtimeMetaCacheExp = now + RUNTIME_META_CACHE_TTL_MS;
  return { ok: true, data: merged };
}

export function invalidateRuntimeMetaCache() {
  runtimeMetaCache = null;
  runtimeMetaCacheExp = 0;
}

export async function writeRuntimeConfig(key, valueJson, updatedBy) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('runtime_config')
    .upsert([{
      key: String(key || '').trim(),
      value_json: valueJson && typeof valueJson === 'object' ? valueJson : {},
      updated_at: new Date().toISOString(),
      updated_by: String(updatedBy || '').trim()
    }], { onConflict: 'key' })
    .select('key, value_json, updated_at, updated_by')
    .single();

  if (!error) {
    invalidateRuntimeMetaCache();
  }

  return { data, error };
}

export async function appendRuntimeConfigAudit({
  key,
  before_json,
  after_json,
  changed_by
}) {
  const supabase = getSupabaseAdmin();

  const row = {
    audit_id: randomUUID(),
    key: String(key || '').trim(),
    before_json: before_json && typeof before_json === 'object' ? before_json : {},
    after_json: after_json && typeof after_json === 'object' ? after_json : {},
    changed_at: new Date().toISOString(),
    changed_by: String(changed_by || '').trim()
  };

  const { error } = await supabase
    .from('runtime_config_audit')
    .insert([row]);

  if (error && isMissingTable('runtime_config_audit', error)) {
    return { ok: true, skipped: true };
  }

  if (error) {
    return { ok: false, error };
  }

  return { ok: true };
}