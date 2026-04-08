import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })
  }

  const sharedSecret = req.headers['x-api-shared-secret']
  if (!sharedSecret || sharedSecret !== process.env.API_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' })
  }
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        ok: false,
        error: 'MISSING_ENV',
        detail: {
          hasSupabaseUrl: !!supabaseUrl,
          hasSupabaseServiceRoleKey: !!supabaseKey
        }
      })
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {})

    const record = {
      record_id: body.record_id || randomUUID(),
      ts: body.ts || new Date().toISOString(),
      staff_id: String(body.staff_id || '').trim(),
      name: String(body.name || '').trim(),
      role: String(body.role || '').trim().toLowerCase(),
      action: String(body.action || '').trim().toUpperCase(),
      note: String(body.note || '').trim(),
      trace_id: String(body.trace_id || randomUUID()).trim(),
      input_mode: String(body.input_mode || 'QR').trim().toUpperCase()
    }

    if (!record.staff_id) {
      return res.status(400).json({ ok: false, error: 'BAD_STAFF_ID' })
    }

    if (!record.action || !['IN', 'OUT'].includes(record.action)) {
      return res.status(400).json({ ok: false, error: 'BAD_ACTION' })
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

    return res.status(200).json({
      ok: true,
      record: data
    })
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      detail: e?.message || String(e)
    })
  }
}
