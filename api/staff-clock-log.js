import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const ALLOWED_ACTIONS = new Set(['IN', 'OUT'])
const ALLOWED_INPUT_MODES = new Set(['QR', 'WEB', 'MANUAL'])

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function parseBody(req) {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8').trim()
    return text ? JSON.parse(text) : {}
  }

  if (typeof req.body === 'string') {
    const text = req.body.trim()
    return text ? JSON.parse(text) : {}
  }

  if (req.body == null) return {}
  if (typeof req.body === 'object') return req.body
  return {}
}

function normalizeTimestamp(value) {
  const text = String(value || '').trim()
  const iso = text || new Date().toISOString()
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function buildSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return {
      error: {
        ok: false,
        error: 'MISSING_ENV',
        detail: {
          hasSupabaseUrl: !!supabaseUrl,
          hasSupabaseServiceRoleKey: !!supabaseKey
        }
      }
    }
  }

  return {
    client: createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })
  }

  const sharedSecret = String(req.headers['x-api-shared-secret'] || '').trim()
  if (!sharedSecret || sharedSecret !== process.env.API_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' })
  }

  let body = {}
  try {
    body = parseBody(req)
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: 'BAD_JSON',
      detail: e?.message || String(e)
    })
  }

  if (!isPlainObject(body)) {
    return res.status(400).json({ ok: false, error: 'BAD_PAYLOAD' })
  }

  const ts = normalizeTimestamp(body.ts)
  if (!ts) {
    return res.status(400).json({ ok: false, error: 'BAD_TS' })
  }

  const traceId = String(body.trace_id || '').trim()
  if (!traceId) {
    return res.status(400).json({ ok: false, error: 'BAD_TRACE_ID' })
  }

  const record = {
    record_id: String(body.record_id || randomUUID()).trim(),
    ts,
    staff_id: String(body.staff_id || '').trim(),
    name: String(body.name || '').trim(),
    role: String(body.role || '').trim().toLowerCase(),
    action: String(body.action || '').trim().toUpperCase(),
    note: String(body.note || '').trim(),
    trace_id: traceId,
    input_mode: String(body.input_mode || 'QR').trim().toUpperCase()
  }

  if (!record.staff_id) {
    return res.status(400).json({ ok: false, error: 'BAD_STAFF_ID' })
  }

  if (!ALLOWED_ACTIONS.has(record.action)) {
    return res.status(400).json({ ok: false, error: 'BAD_ACTION' })
  }

  if (!ALLOWED_INPUT_MODES.has(record.input_mode)) {
    return res.status(400).json({ ok: false, error: 'BAD_INPUT_MODE' })
  }

  const { client: supabase, error: envError } = buildSupabase()
  if (envError) {
    return res.status(500).json(envError)
  }

  try {
    const { data: existing, error: existingError } = await supabase
      .from('staff_clock_logs')
      .select('*')
      .eq('trace_id', record.trace_id)
      .limit(1)
      .maybeSingle()

    if (existingError) {
      return res.status(500).json({
        ok: false,
        error: 'DB_SELECT_FAILED',
        detail: existingError.message
      })
    }

    if (existing) {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        record: existing
      })
    }

    const { data, error } = await supabase
      .from('staff_clock_logs')
      .insert([record])
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        detail: error.message
      })
    }

    return res.status(200).json({ ok: true, record: data })
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      detail: e?.message || String(e)
    })
  }
}
