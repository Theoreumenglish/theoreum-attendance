// NOTE:
// Central DB GAS doPost currently allows bridge.* only.
// getAttendanceMetaCached() is not used by the current runtime path.
// Do not call proxyRpcToGas('meta.ping') unless GAS doPost explicitly allows it.

let _metaCache = null;
let _metaCacheExp = 0;
let _metaCacheFetchedAt = 0;
let _metaInflight = null;

function toPositiveInt(value, fallback, min = 500, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowMs() {
  return Date.now();
}

function normalizeKioskFloor(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === '5층'.toUpperCase()) return '5F';
  if (text === '7층'.toUpperCase()) return '7F';
  if (text === '5F' || text === '7F') return text;
  return '5F';
}

function normalizeMeta(data = {}) {
  return {
    version: String(data.version || ''),
    tz: String(data.tz || 'Asia/Seoul'),
    kiosk_floor: normalizeKioskFloor(data.kiosk_floor || '5F'),
    safe: {
      mode: String(data?.safe?.mode || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
      message: String(data?.safe?.message || '')
    },
    props_missing: Array.isArray(data.props_missing) ? data.props_missing : [],
    staff_mode: String(data.staff_mode || ''),
    disabled_ops: Array.isArray(data.disabled_ops) ? data.disabled_ops : [],
    logo_url_set: !!data.logo_url_set,
    logo_url_normalized: String(data.logo_url_normalized || '')
  };
}

export async function getAttendanceMetaCached(options = {}) {
  const force = options.force === true;
  const ttlMs = toPositiveInt(process.env.ATT_META_CACHE_MS, 3000);
  const now = nowMs();

  if (!force && _metaCache && now < _metaCacheExp) {
    return {
      ok: true,
      data: _metaCache,
      source: 'memory-cache',
      stale: false
    };
  }

  const meta = normalizeMeta({
    version: String(process.env.APP_VERSION || 'vercel-direct'),
    tz: 'Asia/Seoul',
    kiosk_floor: process.env.KIOSK_FLOOR || '5F',
    safe: {
      mode: 'N',
      message: ''
    },
    props_missing: [],
    staff_mode: 'supabase',
    disabled_ops: [],
    logo_url_set: !!process.env.BRAND_LOGO_URL,
    logo_url_normalized: process.env.BRAND_LOGO_URL || ''
  });

  _metaCache = meta;
  _metaCacheExp = now + ttlMs;
  _metaCacheFetchedAt = now;

  return {
    ok: true,
    data: meta,
    source: 'local-runtime',
    stale: false
  };
}
