#!/usr/bin/env node
// TheOreum live API smoke test
// Usage:
//   SMOKE_BASE_URL=https://your-app.vercel.app npm run smoke-test
//   SMOKE_BASE_URL=... SMOKE_STAFF_ID=... SMOKE_PASSWORD=... npm run smoke-test
//   Or create .env.smoke.local with scripts/setup-smoke-env.ps1 and run npm run smoke-test

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnvValue(raw) {
  const v = String(raw || '').trim();
  if ((v.startsWith('\"') && v.endsWith('\"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function loadLocalSmokeEnv() {
  const files = ['.env.smoke.local', '.env.local'];
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    const body = readFileSync(path, 'utf8');
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = parseEnvValue(trimmed.slice(idx + 1));
      if (!key || process.env[key]) continue;
      if (key === 'SMOKE_PASSWORD') process.env[key] = value;
      else if (/^SMOKE_[A-Z0-9_]+$/.test(key)) process.env[key] = value;
    }
  }
}

loadLocalSmokeEnv();
const baseUrl = String(process.env.SMOKE_BASE_URL || process.env.VERCEL_URL || '').trim().replace(/\/+$/, '');
const staffId = String(process.env.SMOKE_STAFF_ID || '').trim();
const password = String(process.env.SMOKE_PASSWORD || '').trim();
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 10000) || 10000;

let failed = 0;
const ok = msg => console.log('OK', msg);
const fail = msg => { failed += 1; console.error('FAIL', msg); };

if (!baseUrl) {
  console.error('SMOKE_BASE_URL이 필요합니다. 예:');
  console.error('  $env:SMOKE_BASE_URL="https://your-app.vercel.app"; npm run smoke-test');
  process.exit(2);
}

async function rpc(op, args = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(baseUrl + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args }),
      signal: controller.signal
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { ok: false, error: { message: text.slice(0, 500) } }; }
    return { httpStatus: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { httpStatus: 0, ms: Date.now() - started, body: { ok: false, error: { message: e?.name === 'AbortError' ? 'TIMEOUT' : (e?.message || String(e)) } } };
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(label, out, opts = {}) {
  const body = out.body || {};
  const allowAuthFail = opts.allowAuthFail === true;
  const code = String(body?.error?.code || '').trim();
  if (body.ok === true || (allowAuthFail && ['UNAUTHORIZED', 'FORBIDDEN', 'AUTH_REQUIRED'].includes(code))) {
    ok(`${label} (${out.httpStatus}, ${out.ms}ms)`);
    return body;
  }
  fail(`${label} 실패 (${out.httpStatus}, ${out.ms}ms): ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
  return body;
}

console.log('== TheOreum live API smoke test ==');
console.log('Base:', baseUrl);

const ping = await rpc('meta.ping');
assertOk('meta.ping', ping);

const meGuest = await rpc('auth.me');
assertOk('auth.me guest shape', meGuest);

let sessionToken = '';
if (staffId && password) {
  const login = await rpc('auth.login', { staff_id: staffId, password });
  const loginBody = assertOk('auth.login', login);
  sessionToken = String(loginBody?.data?.sessionToken || loginBody?.data?.session_token || '').trim();
  if (!sessionToken) fail('auth.login 응답에서 sessionToken을 찾지 못했습니다.');

  if (sessionToken) {
    assertOk('auth.me staff', await rpc('auth.me', { sessionToken }));
    assertOk('admin.getOpsOverview', await rpc('admin.getOpsOverview', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.finalReadiness', await rpc('admin.finalReadiness', { sessionToken }), { allowAuthFail: true });
    assertOk('clinic.listTasks', await rpc('clinic.listTasks', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('clinic.todayBoard', await rpc('clinic.todayBoard', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('assistant.listClassOptions', await rpc('assistant.listClassOptions', { sessionToken, limit: 5, fallback: true }), { allowAuthFail: true });
    assertOk('admin.master.searchStudents', await rpc('admin.master.searchStudents', { sessionToken, q: '0', limit: 1 }), { allowAuthFail: true });
    assertOk('admin.central.props.get', await rpc('admin.central.props.get', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.central.staff.list', await rpc('admin.central.staff.list', { sessionToken }), { allowAuthFail: true });
    assertOk('assistant.listAbsenceExcuses', await rpc('assistant.listAbsenceExcuses', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('assistant.todayAbsenceBoard', await rpc('assistant.todayAbsenceBoard', { sessionToken }), { allowAuthFail: true });
    assertOk('wordCatalog.list', await rpc('wordCatalog.list', { sessionToken, limit_books: 1, limit_ranges: 1 }), { allowAuthFail: true });
    assertOk('wordRecord.list', await rpc('wordRecord.list', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('wordTest.listSessions', await rpc('wordTest.listSessions', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('report.listSnapshots', await rpc('report.listSnapshots', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('auth.logout', await rpc('auth.logout', { sessionToken }));
  }
} else {
  console.log('SMOKE_STAFF_ID/SMOKE_PASSWORD가 없어 로그인 이후 보호 API smoke는 건너뜁니다.');
}

if (failed > 0) {
  console.error(`\nSmoke test failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
