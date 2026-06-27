#!/usr/bin/env node
// TheOreum production/preview QA runner.
// Reads QA_BASE_URL, QA_STAFF_ID, QA_PASSWORD from env or .env.qa.local.
// Does not store secrets in logs.
// v2 adds deployment parity checks so stale Vercel preview URLs are caught early.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REQUIRED_OPS = [
  'meta.supportedOps',
  'auth.login',
  'auth.me',
  'admin.finalReadiness',
  'admin.phoneIdentity.audit',
  'admin.central.staff.list',
  'assistant.listClassOptions',
  'admin.master.searchStudents',
  'admin.studentTodayLink.create',
  'studentToday.publicGet',
  'admin.lectureAssignment.list',
  'admin.lectureAssignment.save',
  'wordCatalog.list',
  'wordRecord.list',
  'clinic.todayBoard'
];

function parseEnvValue(raw) {
  const v = String(raw || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function loadLocalQaEnv() {
  for (const file of ['.env.qa.local', '.env.smoke.local', '.env.local']) {
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
      if (/^(QA|SMOKE)_[A-Z0-9_]+$/.test(key)) process.env[key] = value;
    }
  }
}

loadLocalQaEnv();
const argv = new Set(process.argv.slice(2));
const writeMode = argv.has('--write') || String(process.env.QA_WRITE || '').toUpperCase() === '1' || String(process.env.QA_WRITE || '').toUpperCase() === 'Y';
const baseUrl = String(process.env.QA_BASE_URL || process.env.SMOKE_BASE_URL || '').trim().replace(/\/+$/, '');
const staffId = String(process.env.QA_STAFF_ID || process.env.SMOKE_STAFF_ID || '').trim();
const password = String(process.env.QA_PASSWORD || process.env.SMOKE_PASSWORD || '').trim();
const qaStudentQuery = String(process.env.QA_STUDENT_QUERY || process.env.QA_STUDENT_ID || 'QA학생').trim();
const qaStudentId = String(process.env.QA_STUDENT_ID || '').trim();
const qaStaffTail8 = String(process.env.QA_STAFF_TAIL8 || '').replace(/[^0-9]/g, '').slice(-8);
const timeoutMs = Number(process.env.QA_TIMEOUT_MS || 15000) || 15000;
const logDir = resolve(process.cwd(), '_logs');
const reportPath = resolve(logDir, 'PRODUCTION_QA_REPORT.md');
const copyPath = resolve(logDir, 'PRODUCTION_QA_TO_SEND.txt');

const results = [];
const diagnostics = [];
function push(status, label, detail = '') { results.push({ status, label, detail }); console.log(`${status} ${label}${detail ? ' - ' + detail : ''}`); }
function ok(label, detail = '') { push('OK', label, detail); }
function warn(label, detail = '') { push('WARN', label, detail); }
function fail(label, detail = '') { push('FAIL', label, detail); }
function note(detail) { diagnostics.push(detail); console.log('NOTE', detail); }

if (!baseUrl || !staffId || !password) {
  console.error('QA_BASE_URL, QA_STAFF_ID, QA_PASSWORD가 필요합니다.');
  process.exit(2);
}

function looksLikeImmutablePreview(url) {
  try {
    const host = new URL(url).hostname;
    return /-[a-z0-9]{6,}-[^.]+\.vercel\.app$/i.test(host) && !host.startsWith('theoreum-attendance.vercel.app');
  } catch {
    return false;
  }
}

function staleDeploymentHint() {
  const stable = 'https://theoreum-attendance.vercel.app';
  return [
    '현재 URL이 이전 Vercel preview deployment일 가능성이 큽니다.',
    `가능하면 QA_BASE_URL을 최신 production URL(${stable}) 또는 방금 배포된 최신 preview URL로 바꿔 다시 실행하세요.`,
    '증상: /student-today.html 404 또는 admin.phoneIdentity.audit/admin.lectureAssignment.list BAD_OP.'
  ].join(' ');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { httpStatus: res.status, ms: Date.now() - started, text, ok: res.ok, headers: Object.fromEntries(res.headers.entries()) };
  } catch (e) {
    return { httpStatus: 0, ms: Date.now() - started, text: '', ok: false, error: { code: e?.name || 'FETCH_ERROR', message: e?.message || String(e) } };
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(op, args = {}) {
  const out = await fetchWithTimeout(baseUrl + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args })
  });
  let body;
  try { body = JSON.parse(out.text || '{}'); } catch { body = { ok: false, error: { message: (out.text || '').slice(0, 600) } }; }
  return { op, httpStatus: out.httpStatus, ms: out.ms, body };
}

function resultLine(out) {
  const code = out.body?.error?.code || '';
  const msg = out.body?.error?.message || '';
  const hint = out.body?.error?.hint || out.body?.error?.detail?.hint || '';
  return `http=${out.httpStatus}, ${out.ms}ms${code ? ', code=' + code : ''}${msg ? ', msg=' + msg : ''}${hint ? ', hint=' + hint : ''}`;
}

function isBadOp(out) {
  return String(out?.body?.error?.code || '') === 'BAD_OP' || String(out?.body?.error?.message || '').includes('지원하지 않는 op');
}

function expectOk(label, out, options = {}) {
  const allowAuth = options.allowAuthFail === true;
  const code = String(out.body?.error?.code || '');
  if (out.body?.ok === true) { ok(label, resultLine(out)); return out.body; }
  if (allowAuth && ['UNAUTHORIZED', 'FORBIDDEN', 'AUTH_REQUIRED'].includes(code)) {
    warn(label + ' auth skipped', resultLine(out));
    return out.body;
  }
  if (isBadOp(out)) {
    fail(label, resultLine(out) + ' | ' + staleDeploymentHint());
    return out.body;
  }
  fail(label, resultLine(out));
  return out.body;
}

function requiredOpsMissing(supported = []) {
  const set = new Set((Array.isArray(supported) ? supported : []).map(String));
  return REQUIRED_OPS.filter(op => !set.has(op));
}

console.log('== TheOreum production QA runner ==');
console.log('Base:', baseUrl);
console.log('Mode:', writeMode ? 'write-enabled QA' : 'read-only QA');

if (looksLikeImmutablePreview(baseUrl)) {
  warn('immutable preview URL', 'Vercel preview URL은 배포마다 바뀔 수 있습니다. 오래된 preview면 최신 기능이 BAD_OP/404로 보입니다.');
}

const pageRoot = await fetchWithTimeout(baseUrl + '/');
if (pageRoot.ok) ok('page /', `http=${pageRoot.httpStatus}, ${pageRoot.ms}ms`);
else fail('page /', `http=${pageRoot.httpStatus}, ${pageRoot.ms}ms, msg=${pageRoot.error?.message || 'GET / failed'}`);

const pageStudent = await fetchWithTimeout(baseUrl + '/student-today.html');
if (pageStudent.ok) ok('page /student-today.html', `http=${pageStudent.httpStatus}, ${pageStudent.ms}ms`);
else fail('page /student-today.html', `http=${pageStudent.httpStatus}, ${pageStudent.ms}ms, msg=GET student page failed | ${staleDeploymentHint()}`);

const supported = await rpc('meta.supportedOps');
const supportedBody = expectOk('meta.supportedOps', supported);
const supportedOps = supportedBody?.data?.required_ops || supportedBody?.data?.supported_ops || [];
if (supportedBody?.data?.release_tag) ok('deployment release tag', supportedBody.data.release_tag);
const missingOps = requiredOpsMissing(supportedOps);
if (missingOps.length) {
  fail('deployment parity required ops', `missing=${missingOps.join(', ')} | ${staleDeploymentHint()}`);
} else {
  ok('deployment parity required ops', `${REQUIRED_OPS.length} required ops present`);
}

expectOk('meta.ping', await rpc('meta.ping'));
const login = expectOk('auth.login', await rpc('auth.login', { staff_id: staffId, password }));
const sessionToken = String(login?.data?.sessionToken || login?.data?.session_token || '').trim();
if (!sessionToken) {
  fail('sessionToken', '로그인 응답에 sessionToken이 없습니다. 이후 보호 API는 건너뜁니다.');
} else {
  expectOk('auth.me staff', await rpc('auth.me', { sessionToken }));
  expectOk('admin.finalReadiness', await rpc('admin.finalReadiness', { sessionToken }), { allowAuthFail: true });
  expectOk('admin.phoneIdentity.audit', await rpc('admin.phoneIdentity.audit', { sessionToken }), { allowAuthFail: true });
  expectOk('admin.central.staff.list', await rpc('admin.central.staff.list', { sessionToken, force: true }), { allowAuthFail: true });
  expectOk('assistant.listClassOptions', await rpc('assistant.listClassOptions', { sessionToken, limit: 10, fallback: true }), { allowAuthFail: true });
  const search = expectOk('admin.master.searchStudents', await rpc('admin.master.searchStudents', { sessionToken, q: qaStudentId || qaStudentQuery, limit: 5 }), { allowAuthFail: true });
  const students = Array.isArray(search?.data?.students) ? search.data.students : (Array.isArray(search?.data?.items) ? search.data.items : []);
  const student = students.find(s => !qaStudentId || String(s.student_id || '') === qaStudentId) || students[0] || null;
  if (student?.student_id) {
    const sid = String(student.student_id || '').trim();
    ok('QA student found', `${sid} ${student.student_name || ''}`.trim());
    expectOk('admin.lectureAssignment.list QA student', await rpc('admin.lectureAssignment.list', { sessionToken, student_id: sid, include_archived: true, limit: 5 }), { allowAuthFail: true });
    if (writeMode) {
      const link = expectOk('admin.studentTodayLink.create QA student', await rpc('admin.studentTodayLink.create', { sessionToken, student_id: sid, origin: baseUrl, expires_days: 1 }), { allowAuthFail: true });
      const publicUrl = String(link?.data?.public_url || '');
      if (publicUrl) {
        ok('student today public URL created', publicUrl.replace(/t=[^&]+/, 't=***'));
        const token = publicUrl.includes('t=') ? decodeURIComponent(publicUrl.split('t=')[1].split('&')[0]) : '';
        if (token) expectOk('studentToday.publicGet created token', await rpc('studentToday.publicGet', { token }));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      expectOk('admin.lectureAssignment.save QA', await rpc('admin.lectureAssignment.save', {
        sessionToken,
        student_id: sid,
        title: 'QA 온라인강의 테스트 ' + stamp,
        url: 'https://example.com/theoreum-qa-lecture',
        status: 'ARCHIVED',
        visible_to_student: false,
        note: 'production QA runner 자동 점검용 숨김 항목'
      }), { allowAuthFail: true });
    } else {
      warn('write checks skipped', 'QA_WRITE=1 또는 npm run prod:qa:write로 학생 링크 생성/강의 저장까지 확인할 수 있습니다.');
    }
  } else {
    warn('QA student not found', `query=${qaStudentId || qaStudentQuery}`);
  }

  if (qaStaffTail8) {
    const out = await fetchWithTimeout(baseUrl + '/api/staff-clock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'IN', phone_tail8: qaStaffTail8, input_mode: 'WEB', note: 'production QA runner test' })
    });
    let body;
    try { body = JSON.parse(out.text || '{}'); } catch { body = { ok: false, error: { message: 'non-json' } }; }
    const wrapped = { op: 'api/staff-clock', httpStatus: out.httpStatus, ms: out.ms, body };
    if (writeMode) expectOk('staff phone clock IN QA', wrapped);
    else warn('staff phone clock skipped', '근태 write 테스트는 prod:qa:write에서만 권장합니다.');
  }

  expectOk('wordCatalog.list', await rpc('wordCatalog.list', { sessionToken, limit_books: 1, limit_ranges: 1 }), { allowAuthFail: true });
  expectOk('wordRecord.list', await rpc('wordRecord.list', { sessionToken, limit: 1 }), { allowAuthFail: true });
  expectOk('clinic.todayBoard', await rpc('clinic.todayBoard', { sessionToken, limit: 5 }), { allowAuthFail: true });
  expectOk('auth.logout', await rpc('auth.logout', { sessionToken }));
}

const failed = results.filter(r => r.status === 'FAIL').length;
const warned = results.filter(r => r.status === 'WARN').length;
mkdirSync(logDir, { recursive: true });
const report = [
  '# TheOreum Production QA Report',
  '',
  `- Base URL: ${baseUrl}`,
  `- Mode: ${writeMode ? 'write-enabled QA' : 'read-only QA'}`,
  `- Generated at: ${new Date().toISOString()}`,
  `- Failed: ${failed}`,
  `- Warnings: ${warned}`,
  '',
  '## Diagnosis',
  failed
    ? '실패가 BAD_OP 또는 /student-today.html 404라면 코드 문제가 아니라 오래된 Vercel preview URL을 보고 있을 가능성이 큽니다. 최신 production URL 또는 방금 배포된 최신 preview URL로 다시 실행하세요.'
    : '핵심 production QA가 통과했습니다.',
  diagnostics.length ? diagnostics.join('\n') : '',
  '',
  '## Results',
  ...results.map(r => `- ${r.status} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
].join('\n');
writeFileSync(reportPath, report, 'utf8');
writeFileSync(copyPath, ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n'), 'utf8');
console.log('\nReport:', reportPath);
console.log('Copy block:', copyPath);
if (failed) process.exit(1);
