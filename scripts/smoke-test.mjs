#!/usr/bin/env node
// TheOreum live API smoke test
// Usage:
//   SMOKE_BASE_URL=https://your-app.vercel.app npm run smoke-test
//   SMOKE_BASE_URL=... SMOKE_STAFF_ID=... SMOKE_PASSWORD=... npm run smoke-test
//   Or create .env.smoke.local with scripts/setup-smoke-env.ps1 and run npm run smoke-test

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SMOKE_REQUIRED_OPS = [
  'meta.supportedOps',
  'admin.phoneIdentity.audit',
  'admin.lectureAssignment.list',
  'studentToday.publicGet',
  'admin.studentTodayLink.create'
];

function staleDeploymentHint() {
  return 'BAD_OP 또는 /student-today.html 404가 나오면 오래된 Vercel preview URL일 수 있습니다. 최신 production URL(https://theoreum-attendance.vercel.app) 또는 최신 preview URL로 다시 실행하세요.';
}

function parseEnvValue(raw) {
  const v = String(raw || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
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
const logDir = resolve(process.cwd(), '_logs');
const smokeCopyPath = resolve(logDir, 'LAST_SMOKE_TO_SEND.txt');

let failed = 0;
const failureDetails = [];
const ok = msg => console.log('OK', msg);

function looksLikeMissingMigration(text = '') {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('does not exist') ||
    s.includes('schema cache') ||
    s.includes('could not find the table') ||
    s.includes('relation') && s.includes('not exist') ||
    s.includes('student_today_links') ||
    s.includes('student_lecture_assignments') ||
    s.includes('word_records') ||
    s.includes('word_books') ||
    s.includes('word_book_ranges')
  );
}

function migrationHintFor(label = '', body = {}) {
  const raw = `${label}\n${body?.error?.message || ''}\n${body?.error?.hint || ''}\n${JSON.stringify(body?.error?.details || {})}`;
  if (String(body?.error?.code || '') === 'BAD_OP' || String(body?.error?.message || '').includes('지원하지 않는 op')) return staleDeploymentHint();
  if (!looksLikeMissingMigration(raw)) return '';
  const hints = [];
  if (raw.includes('student_lecture_assignments') || label.includes('lectureAssignment')) {
    hints.push('Apply docs/supabase-online-lecture-assignment-v1.sql in Supabase SQL Editor.');
  }
  if (raw.includes('student_today_links') || label.includes('studentToday')) {
    hints.push('Apply docs/supabase-student-today-link-v1.sql in Supabase SQL Editor.');
  }
  if (raw.includes('word_records') || label.includes('wordRecord')) {
    hints.push('Apply docs/supabase-student-word-records-v1.sql in Supabase SQL Editor.');
  }
  if (raw.includes('word_books') || raw.includes('word_book_ranges') || label.includes('wordCatalog')) {
    hints.push('Apply docs/supabase-word-catalog-v1.sql in Supabase SQL Editor.');
  }
  if (hints.length === 0) hints.push('A Supabase SQL migration is probably missing. Check docs/supabase-*.sql and _logs/LAST_SQL_TO_APPLY.txt if present.');
  return Array.from(new Set(hints)).join(' ');
}

function fail(msg, detail = {}) {
  failed += 1;
  console.error('FAIL', msg);
  failureDetails.push({ message: msg, ...detail });
}

if (!baseUrl) {
  console.error('SMOKE_BASE_URL이 필요합니다. 예:');
  console.error('  $env:SMOKE_BASE_URL="https://your-app.vercel.app"; npm run smoke-test');
  process.exit(2);
}


async function getPage(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(baseUrl + pathname, { method: 'GET', signal: controller.signal });
    return { op: 'GET ' + pathname, httpStatus: res.status, ms: Date.now() - started, body: { ok: res.ok, error: res.ok ? null : { code: 'HTTP_' + res.status, message: 'GET ' + pathname + ' failed' } } };
  } catch (e) {
    return { op: 'GET ' + pathname, httpStatus: 0, ms: Date.now() - started, body: { ok: false, error: { code: e?.name || 'FETCH_ERROR', message: e?.message || String(e) } } };
  } finally {
    clearTimeout(timer);
  }
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
    return { op, httpStatus: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { op, httpStatus: 0, ms: Date.now() - started, body: { ok: false, error: { message: e?.name === 'AbortError' ? 'TIMEOUT' : (e?.message || String(e)) } } };
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

  const message = body?.error?.message || JSON.stringify(body).slice(0, 500);
  const hint = body?.error?.hint || migrationHintFor(label, body);
  const detailLine = [
    `${label} failed`,
    `op=${out.op || label}`,
    `http=${out.httpStatus}`,
    `ms=${out.ms}`,
    code ? `code=${code}` : '',
    `message=${message}`,
    hint ? `hint=${hint}` : ''
  ].filter(Boolean).join(' | ');
  fail(detailLine, { label, op: out.op || label, httpStatus: out.httpStatus, ms: out.ms, code, message, hint, body });
  return body;
}

function writeSmokeFailureSummary() {
  if (failed <= 0) return;
  try {
    mkdirSync(dirname(smokeCopyPath), { recursive: true });
    const migrationHints = Array.from(new Set(failureDetails.map(f => f.hint).filter(Boolean)));
    const body = [
      '=== COPY FROM HERE ===',
      'TheOreum smoke-test failed.',
      '',
      `Base URL: ${baseUrl}`,
      `Failure count: ${failed}`,
      '',
      'Likely next action:',
      migrationHints.length > 0
        ? migrationHints.map((h, idx) => `${idx + 1}. ${h}`).join('\n')
        : 'Send this whole block to ChatGPT with _logs/LAST_FAILURE_TO_SEND.txt if available.',
      '',
      'Failures:',
      ...failureDetails.map((f, idx) => [
        `${idx + 1}. ${f.label || f.op || 'unknown'}`,
        `   op: ${f.op || ''}`,
        `   http: ${f.httpStatus ?? ''}`,
        `   code: ${f.code || ''}`,
        `   message: ${f.message || f.messageText || ''}`,
        f.hint ? `   hint: ${f.hint}` : ''
      ].filter(Boolean).join('\n')),
      '=== COPY TO HERE ==='
    ].join('\n');
    writeFileSync(smokeCopyPath, body, 'utf8');
    console.error(`\nSmoke failure summary written: ${smokeCopyPath}`);
  } catch (e) {
    console.error('Could not write smoke failure summary:', e?.message || String(e));
  }
}

console.log('== TheOreum live API smoke test ==');
console.log('Base:', baseUrl);

assertOk('page /', await getPage('/'));
assertOk('page /student-today.html', await getPage('/student-today.html'));

const supported = await rpc('meta.supportedOps');
const supportedBody = assertOk('meta.supportedOps', supported);
const supportedOps = supportedBody?.data?.required_ops || supportedBody?.data?.supported_ops || [];
if (Array.isArray(supportedOps) && supportedOps.length) {
  const missing = SMOKE_REQUIRED_OPS.filter(op => !supportedOps.includes(op));
  if (missing.length) fail('deployment required ops missing: ' + missing.join(', ') + ' | ' + staleDeploymentHint(), { label: 'meta.supportedOps required ops', op: 'meta.supportedOps', code: 'DEPLOYMENT_OUT_OF_DATE', message: missing.join(', ') });
  else ok('deployment required ops present');
}

const ping = await rpc('meta.ping');
assertOk('meta.ping', ping);

const meGuest = await rpc('auth.me');
assertOk('auth.me guest shape', meGuest);

let sessionToken = '';
if (staffId && password) {
  const login = await rpc('auth.login', { staff_id: staffId, password });
  const loginBody = assertOk('auth.login', login);
  sessionToken = String(loginBody?.data?.sessionToken || loginBody?.data?.session_token || '').trim();
  if (!sessionToken) fail('auth.login response did not include sessionToken.', { label: 'auth.login sessionToken', op: 'auth.login' });

  if (sessionToken) {
    assertOk('auth.me staff', await rpc('auth.me', { sessionToken }));
    assertOk('admin.getOpsOverview', await rpc('admin.getOpsOverview', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.finalReadiness', await rpc('admin.finalReadiness', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.phoneIdentity.audit', await rpc('admin.phoneIdentity.audit', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.lectureAssignment.list', await rpc('admin.lectureAssignment.list', { sessionToken, student_id: '0000', limit: 1 }), { allowAuthFail: true });
    assertOk('clinic.listTasks', await rpc('clinic.listTasks', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('clinic.todayBoard', await rpc('clinic.todayBoard', { sessionToken, limit: 1 }), { allowAuthFail: true });
    assertOk('assistant.listClassOptions', await rpc('assistant.listClassOptions', { sessionToken, limit: 5, fallback: true }), { allowAuthFail: true });
    assertOk('admin.master.searchStudents', await rpc('admin.master.searchStudents', { sessionToken, q: '0', limit: 1 }), { allowAuthFail: true });
    assertOk('admin.central.props.get', await rpc('admin.central.props.get', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.central.staff.list', await rpc('admin.central.staff.list', { sessionToken }), { allowAuthFail: true });
    assertOk('admin.staffClock.listLogs', await rpc('admin.staffClock.listLogs', { sessionToken, staff_id: 'fubao', yyyymmdd: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '') }), { allowAuthFail: true });
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
  writeSmokeFailureSummary();
  console.error(`\nSmoke test failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
