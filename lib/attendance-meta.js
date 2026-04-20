import { proxyRpcToGas } from './gas-rpc-proxy.js';

let _metaCache = null;
let _metaCacheExp = 0;
let _metaInflight = null;

function toPositiveInt(value, fallback, min = 500, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowMs() {
  return Date.now();
}

function normalizeMeta(data = {}) {
  return {
    version: String(data.version || ''),
    tz: String(data.tz || 'Asia/Seoul'),
    kiosk_floor: String(data.kiosk_floor || '5F').trim() || '5F',
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

  if (_metaInflight) {
    return _metaInflight;
  }

  _metaInflight = (async () => {
    const gas = await proxyRpcToGas('meta.ping', {}, '');

    if (gas.body && gas.body.ok === true) {
      const meta = normalizeMeta(gas.body.data || {});
      _metaCache = meta;
      _metaCacheExp = nowMs() + ttlMs;

      return {
        ok: true,
        data: meta,
        source: 'gas-meta',
        stale: false
      };
    }

    if (_metaCache) {
      return {
        ok: true,
        data: _metaCache,
        source: 'stale-cache',
        stale: true
      };
    }

    return {
      ok: false,
      error: {
        code:
          (gas.body && gas.body.error && gas.body.error.code) ||
          'META_UNAVAILABLE',
        message:
          (gas.body && gas.body.error && gas.body.error.message) ||
          '운영 메타 정보를 읽지 못했습니다.'
      }
    };
  })();

  try {
    return await _metaInflight;
  } finally {
    _metaInflight = null;
  }
}