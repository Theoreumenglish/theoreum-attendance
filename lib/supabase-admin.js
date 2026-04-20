import { createClient } from '@supabase/supabase-js';

let _client = null;

export function getSupabaseAdmin() {
  if (_client) return _client;

  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (!url) throw new Error('SUPABASE_URL 누락');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY 누락');

  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return _client;
}