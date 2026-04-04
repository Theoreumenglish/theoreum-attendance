const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function normalizeMetaJson(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (e) {
    return { raw: String(value) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const record = {
      record_id: body.record_id || randomUUID(),
      ts: body.ts || new Date().toISOString(),
      yyyymmdd: String(body.yyyymmdd || '').trim(),
      student_id: String(body.student_id || '').trim(),
      action_type: String(body.action_type || '').trim(),
      kiosk_floor: String(body.kiosk_floor || '').trim(),
      meta_json: normalizeMetaJson(body.meta_json),
      result: String(body.result || 'OK').trim(),
      deny_reason: String(body.deny_reason || '').trim(),
      qr_id: String(body.qr_id || '').trim(),
      trace_id: String(body.trace_id || randomUUID()).trim()
    };

    if (!record.yyyymmdd || !/^\d{8}$/.test(record.yyyymmdd)) {
      return res.status(400).json({ ok: false, error: 'BAD_YYYYMMDD' });
    }

    if (!record.student_id || !/^\d{4}$/.test(record.student_id)) {
      return res.status(400).json({ ok: false, error: 'BAD_STUDENT_ID' });
    }

    if (!record.action_type) {
      return res.status(400).json({ ok: false, error: 'BAD_ACTION_TYPE' });
    }

    const { data, error } = await supabase
      .from('attendance_logs')
      .insert([record])
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: 'DB_INSERT_FAILED',
        detail: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      record: data
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'SERVER_ERROR',
      detail: e && e.message ? e.message : String(e)
    });
  }
};
