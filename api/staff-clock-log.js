import { writeStaffClockAndRollup } from '../lib/staff-attendance.js';

const ALLOWED_INPUT_MODES = new Set(['QR', 'WEB', 'MANUAL']);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
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

  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  return {};
}

function normalizeInputMode(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_INPUT_MODES.has(s) ? s : 'MANUAL';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const sharedSecret = String(req.headers['x-api-shared-secret'] || '').trim();
  if (!sharedSecret || sharedSecret !== process.env.API_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: 'BAD_JSON',
      detail: e?.message || String(e)
    });
  }

  if (!isPlainObject(body)) {
    return res.status(400).json({ ok: false, error: 'BAD_BODY' });
  }

  const result = await writeStaffClockAndRollup({
    ts: body.ts,
    staff_id: body.staff_id,
    name: body.name,
    role: body.role,
    action: body.action,
    note: body.note,
    trace_id: body.trace_id,
    input_mode: normalizeInputMode(body.input_mode)
  }, {
    recentDedupeSec: 0
  });

  if (!result.ok) {
    return res.status(result.status || 500).json({
      ok: false,
      error: result.error || 'SERVER_ERROR',
      detail: result.detail || ''
    });
  }

  return res.status(200).json({
    ok: true,
    duplicate: !!result.duplicate,
    record: result.record || null,
    daily: result.daily || null,
    monthly: result.monthly || null
  });
}