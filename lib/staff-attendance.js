import { getSupabaseAdmin } from './supabase-admin.js';

const ALLOWED_ACTIONS = new Set(['IN', 'OUT']);
const ALLOWED_INPUT_MODES = new Set(['QR', 'WEB', 'MANUAL']);
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(value, fallback, min = 1, max = 86400) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeStaffId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

function normalizeAction(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_ACTIONS.has(s) ? s : '';
}

function normalizeInputMode(input) {
  const s = String(input || '').trim().toUpperCase();
  return ALLOWED_INPUT_MODES.has(s) ? s : 'MANUAL';
}

function normalizeText(input, maxLen = 200) {
  return String(input || '').trim().slice(0, maxLen);
}

function normalizeTimestamp(value) {
  const text = String(value || '').trim();
  const base = text || new Date().toISOString();
  const ms = Date.parse(base);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function kstYmdFromIso(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  const kst = new Date(ms + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function kstYyyymmFromYmd(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  return /^\d{8}$/.test(s) ? s.slice(0, 6) : '';
}

function utcRangeForKstYmd(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!/^\d{8}$/.test(s)) return null;

  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));

  const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - KST_OFFSET_MS;
  const endUtcMs = startUtcMs + (24 * 60 * 60 * 1000);

  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString()
  };
}

function nextYyyymm(yyyymm) {
  const s = String(yyyymm || '').trim();
  if (!/^\d{6}$/.test(s)) return '';
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const next = new Date(Date.UTC(y, m, 1));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

function hours2(minutes) {
  return (Number(minutes || 0) / 60).toFixed(2);
}

function parseMinutes(value) {
  const n = parseInt(String(value || '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

function isDuplicateKeyError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const detail = String(error?.details || '').toLowerCase();

  return (
    code === '23505' ||
    message.includes('duplicate key') ||
    detail.includes('duplicate key')
  );
}

async function findExistingByTrace(supabase, traceId) {
  const trace = String(traceId || '').trim();
  if (!trace) return { data: null, error: null };

  const { data, error } = await supabase
    .from('staff_clock_logs')
    .select('*')
    .eq('trace_id', trace)
    .limit(1)
    .maybeSingle();

  return { data: data || null, error };
}

async function findRecentDuplicate(supabase, staffId, action, dedupeSec) {
  const sec = Number(dedupeSec || 0);
  if (!Number.isFinite(sec) || sec <= 0) return { data: null, error: null };

  const cutoffIso = new Date(Date.now() - (sec * 1000)).toISOString();

  const { data, error } = await supabase
    .from('staff_clock_logs')
    .select('*')
    .eq('staff_id', staffId)
    .eq('action', action)
    .gte('ts', cutoffIso)
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();

  return { data: data || null, error };
}

async function insertClockLog(supabase, row) {
  const { data, error } = await supabase
    .from('staff_clock_logs')
    .insert([row])
    .select()
    .single();

  return { data, error };
}

async function loadDayLogs(supabase, staffId, yyyymmdd) {
  const range = utcRangeForKstYmd(yyyymmdd);
  if (!range) return { data: [], error: null };

  const { data, error } = await supabase
    .from('staff_clock_logs')
    .select('ts, staff_id, name, role, action, input_mode, note, trace_id')
    .eq('staff_id', staffId)
    .gte('ts', range.startIso)
    .lt('ts', range.endIso)
    .order('ts', { ascending: true });

  return { data: Array.isArray(data) ? data : [], error };
}

function recalcDailyFromRows(staffId, yyyymmdd, rows) {
  let openIn = null;
  let firstInTs = null;
  let lastOutTs = null;
  let workedMinutes = 0;
  let pairCount = 0;
  let status = 'EMPTY';
  let name = '';
  let role = '';

  for (const r of rows) {
    name = String(r?.name || '').trim() || name;
    role = String(r?.role || '').trim() || role;

    const action = String(r?.action || '').trim().toUpperCase();
    const ts = normalizeTimestamp(r?.ts);

    if (!ts) continue;

    if (action === 'IN') {
      if (!firstInTs) firstInTs = ts;
      if (!openIn) openIn = ts;
      continue;
    }

    if (action === 'OUT') {
      if (openIn) {
        const diff = Math.max(
          0,
          Math.floor((Date.parse(ts) - Date.parse(openIn)) / 60000)
        );
        workedMinutes += diff;
        pairCount += 1;
        lastOutTs = ts;
        openIn = null;
      } else {
        status = 'MISSING_IN';
        lastOutTs = ts;
      }
    }
  }

  if (rows.length && pairCount > 0 && !openIn && status !== 'MISSING_IN') {
    status = 'OK';
  } else if (openIn) {
    status = 'MISSING_OUT';
  } else if (rows.length && pairCount === 0 && status !== 'MISSING_IN') {
    status = 'NO_PAIR';
  }

  return {
    yyyymmdd,
    staff_id: staffId,
    name,
    role,
    first_in_ts: firstInTs,
    last_out_ts: lastOutTs,
    worked_minutes: workedMinutes,
    worked_hours: Number(hours2(workedMinutes)),
    pair_count: pairCount,
    status,
    note: '',
    updated_at: nowIso()
  };
}

async function upsertDaily(supabase, row) {
  const { data, error } = await supabase
    .from('staff_daily')
    .upsert([row], { onConflict: 'yyyymmdd,staff_id' })
    .select()
    .single();

  return { data, error };
}

async function recalcMonthly(supabase, staffId, yyyymm) {
  const monthEnd = nextYyyymm(yyyymm);
  if (!monthEnd) {
    return { data: null, error: new Error('잘못된 yyyymm') };
  }

  const { data: items, error } = await supabase
    .from('staff_daily')
    .select('*')
    .eq('staff_id', staffId)
    .gte('yyyymmdd', `${yyyymm}01`)
    .lt('yyyymmdd', `${monthEnd}01`)
    .order('yyyymmdd', { ascending: true });

  if (error) return { data: null, error };

  let totalMinutes = 0;
  let workDays = 0;
  let missingDays = 0;
  let name = '';
  let role = '';

  for (const r of items || []) {
    name = String(r?.name || '').trim() || name;
    role = String(r?.role || '').trim() || role;

    totalMinutes += parseMinutes(r?.worked_minutes);
    const status = String(r?.status || '').trim();

    if (status === 'OK') workDays += 1;
    if (status.startsWith('MISSING_')) missingDays += 1;
  }

  const monthlyRow = {
    yyyymm,
    staff_id: staffId,
    name,
    role,
    total_minutes: totalMinutes,
    total_hours: Number(hours2(totalMinutes)),
    work_days: workDays,
    missing_days: missingDays,
    updated_at: nowIso()
  };

  const { data, error: upsertErr } = await supabase
    .from('staff_monthly')
    .upsert([monthlyRow], { onConflict: 'yyyymm,staff_id' })
    .select()
    .single();

  return { data, error: upsertErr };
}

export async function writeStaffClockAndRollup(payload, options = {}) {
  const supabase = getSupabaseAdmin();

  const ts = normalizeTimestamp(payload?.ts);
  const staffId = normalizeStaffId(payload?.staff_id);
  const name = normalizeText(payload?.name, 100);
  const role = normalizeText(payload?.role, 40).toLowerCase();
  const action = normalizeAction(payload?.action);
  const inputMode = normalizeInputMode(payload?.input_mode);
  const note = normalizeText(payload?.note, 200);
  const traceId = normalizeText(payload?.trace_id, 120);

  if (!ts) {
    return { ok: false, status: 400, error: 'INVALID_TS', detail: '유효한 ts가 필요합니다.' };
  }
  if (!staffId) {
    return { ok: false, status: 400, error: 'INVALID_STAFF_ID', detail: 'staff_id가 필요합니다.' };
  }
  if (!action) {
    return { ok: false, status: 400, error: 'INVALID_ACTION', detail: '허용되지 않는 action 입니다.' };
  }
  if (!traceId) {
    return { ok: false, status: 400, error: 'INVALID_TRACE_ID', detail: 'trace_id가 필요합니다.' };
  }

  const { data: existing, error: existingErr } = await findExistingByTrace(supabase, traceId);
  if (existingErr) {
    return { ok: false, status: 500, error: 'DB_SELECT_FAILED', detail: existingErr.message };
  }
  if (existing) {
    return {
      ok: true,
      status: 200,
      duplicate: true,
      record: existing
    };
  }

  const dedupeSec = toPositiveInt(options?.recentDedupeSec, 0, 0, 600);
  if (dedupeSec > 0) {
    const { data: dup, error: dupErr } = await findRecentDuplicate(supabase, staffId, action, dedupeSec);
    if (dupErr) {
      return { ok: false, status: 500, error: 'DB_SELECT_FAILED', detail: dupErr.message };
    }
    if (dup) {
      return {
        ok: true,
        status: 200,
        duplicate: true,
        record: dup
      };
    }
  }

  const row = {
    ts,
    staff_id: staffId,
    name,
    role,
    action,
    note,
    trace_id: traceId,
    input_mode: inputMode
  };

  const { data: inserted, error: insertErr } = await insertClockLog(supabase, row);
  if (insertErr) {
    if (isDuplicateKeyError(insertErr)) {
      const { data: dup, error: dupErr } = await findExistingByTrace(supabase, traceId);
      if (!dupErr && dup) {
        return {
          ok: true,
          status: 200,
          duplicate: true,
          record: dup
        };
      }
    }

    return { ok: false, status: 500, error: 'DB_INSERT_FAILED', detail: insertErr.message };
  }
  const yyyymmdd = kstYmdFromIso(ts);
  const yyyymm = kstYyyymmFromYmd(yyyymmdd);

  const { data: dayRows, error: dayErr } = await loadDayLogs(supabase, staffId, yyyymmdd);
  if (dayErr) {
    return { ok: false, status: 500, error: 'DB_SELECT_FAILED', detail: dayErr.message };
  }

  const dailyRow = recalcDailyFromRows(staffId, yyyymmdd, dayRows);
  const { data: daily, error: dailyErr } = await upsertDaily(supabase, dailyRow);
  if (dailyErr) {
    return { ok: false, status: 500, error: 'DB_UPSERT_FAILED', detail: dailyErr.message };
  }

  const { data: monthly, error: monthlyErr } = await recalcMonthly(supabase, staffId, yyyymm);
  if (monthlyErr) {
    return { ok: false, status: 500, error: 'DB_UPSERT_FAILED', detail: monthlyErr.message };
  }

  return {
    ok: true,
    status: 200,
    duplicate: false,
    record: inserted,
    daily,
    monthly
  };
}