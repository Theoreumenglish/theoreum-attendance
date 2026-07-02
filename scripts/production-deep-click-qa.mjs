#!/usr/bin/env node
// TheOreum production deep click QA runner.
// Runs on the user's PC, opens the real site with Playwright, logs in, clicks core screens,
// captures screenshots, console/page/network errors, and creates a copy-ready report.
// Secrets are read from env/.env.qa.local but are never written to reports.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let chromium = null;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch (e) {
  console.error('Playwright is not installed. Run: npm install --no-save playwright@1');
  process.exit(2);
}

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
const headless = argv.has('--headless') || String(process.env.QA_HEADLESS || '').toUpperCase() === '1';
const baseUrl = String(process.env.QA_BASE_URL || process.env.SMOKE_BASE_URL || '').trim().replace(/\/+$/, '');
const staffId = String(process.env.QA_STAFF_ID || process.env.SMOKE_STAFF_ID || '').trim();
const password = String(process.env.QA_PASSWORD || process.env.SMOKE_PASSWORD || '').trim();
const qaStudentQuery = String(process.env.QA_STUDENT_QUERY || process.env.QA_STUDENT_ID || 'QA학생').trim();
const qaStudentId = String(process.env.QA_STUDENT_ID || '').trim();
const qaStaffTail8 = String(process.env.QA_STAFF_TAIL8 || '').replace(/[^0-9]/g, '').slice(-8);
const qaStudentTail8 = String(process.env.QA_STUDENT_TAIL8 || '11112222').replace(/[^0-9]/g, '').slice(-8);
const timeoutMs = Number(process.env.QA_TIMEOUT_MS || 20000) || 20000;
const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const logDir = resolve(process.cwd(), '_logs');
const deepRoot = resolve(logDir, 'deep-qa');
const runDir = resolve(deepRoot, runId);
const reportPath = resolve(logDir, 'PRODUCTION_DEEP_QA_REPORT.md');
const copyPath = resolve(logDir, 'PRODUCTION_DEEP_QA_TO_SEND.txt');
const lastDirPath = resolve(logDir, 'PRODUCTION_DEEP_QA_LAST_DIR.txt');
const rawJsonPath = resolve(logDir, 'PRODUCTION_DEEP_QA_RAW.json');
const bundlePath = resolve(logDir, 'PRODUCTION_DEEP_QA_BUNDLE.zip');

mkdirSync(runDir, { recursive: true });

const results = [];
const consoleEvents = [];
const pageErrors = [];
const failedRequests = [];
const badResponses = [];
const screenshots = [];
const apiResults = [];
let stepFailed = 0;
let stepWarned = 0;
let browser = null;
let context = null;
let page = null;
let sessionToken = '';

function mask(value) {
  let out = String(value || '');
  for (const secret of [password, sessionToken]) {
    if (secret && secret.length >= 4) out = out.split(secret).join('***');
  }
  return out.replace(/(t=)[^&\s]+/g, '$1***').replace(/(sessionToken["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1***');
}

function push(status, label, detail = '') {
  if (status === 'FAIL') stepFailed += 1;
  if (status === 'WARN') stepWarned += 1;
  const item = { status, label, detail: mask(detail), at: new Date().toISOString() };
  results.push(item);
  console.log(`${status} ${label}${detail ? ' - ' + mask(detail) : ''}`);
}
const ok = (label, detail = '') => push('OK', label, detail);
const warn = (label, detail = '') => push('WARN', label, detail);
const fail = (label, detail = '') => push('FAIL', label, detail);

if (!baseUrl || !staffId || !password) {
  fail('missing QA env', 'QA_BASE_URL, QA_STAFF_ID, QA_PASSWORD are required.');
  finishAndExit(2);
}

function urlOf(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return baseUrl + (path.startsWith('/') ? path : '/' + path);
}

function pathSafe(label) {
  return String(label || 'screen').replace(/[^a-z0-9가-힣_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'screen';
}

function createScreenshotBundle() {
  try {
    if (!existsSync(runDir)) return { ok: false, reason: 'run_dir_missing' };
    if (process.platform === 'win32') {
      const ps = [
        '$ErrorActionPreference = "Stop"',
        `$src = ${JSON.stringify(join(runDir, '*'))}`,
        `$dest = ${JSON.stringify(bundlePath)}`,
        'if (Test-Path $dest) { Remove-Item $dest -Force }',
        'Compress-Archive -Path $src -DestinationPath $dest -Force'
      ].join('; ');
      const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
      if (out.status === 0 && existsSync(bundlePath)) return { ok: true, path: bundlePath, method: 'powershell_Compress-Archive' };
      return { ok: false, reason: (out.stderr || out.stdout || 'Compress-Archive failed').slice(0, 500) };
    }

    const out = spawnSync('zip', ['-qr', bundlePath, basename(runDir)], { cwd: dirname(runDir), encoding: 'utf8' });
    if (out.status === 0 && existsSync(bundlePath)) return { ok: true, path: bundlePath, method: 'zip' };
    return { ok: false, reason: (out.stderr || out.stdout || 'zip command failed').slice(0, 500) };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

function extractStudentsFromSearchPayload(payload) {
  const data = payload?.data || {};
  const candidates = [
    data.students,
    data.items,
    data.rows,
    data.list,
    payload?.students,
    payload?.items
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function extractStaffFromListPayload(payload) {
  const data = payload?.data || {};
  const candidates = [
    data.staff,
    data.items,
    data.rows,
    payload?.staff,
    payload?.items
  ];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
  }
  return [];
}

function normalizeTail8(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  return digits.length >= 8 ? digits.slice(-8) : '';
}

function staffLooksLikeQa(item = {}) {
  const hay = [item.staff_id, item.id, item.name, item.staff_name]
    .map(x => String(x || '').toLowerCase())
    .join(' ');
  return /qa|테스트/.test(hay);
}

async function ensureQaStaffPhoneForWrite() {
  if (!writeMode || !qaStaffTail8) return { ok: false, skipped: true, reason: 'not_write_mode_or_missing_tail' };

  const list = await apiRpc('admin.central.staff.list', { force: true });
  const staffItems = extractStaffFromListPayload(list);
  const candidate = staffItems.find(staffLooksLikeQa) || staffItems.find(item => normalizeTail8(item.staff_phone || item.phone || item.mobile) === qaStaffTail8);
  if (!candidate) {
    warn('QA staff phone setup skipped', 'QA 직원 후보를 찾지 못했습니다. 중앙DB 직원 관리에서 qa_staff/QA직원 행을 확인하세요.');
    return { ok: false, skipped: true, reason: 'qa_staff_not_found' };
  }

  const staffId = String(candidate.staff_id || candidate.id || '').trim();
  if (!staffId) {
    warn('QA staff phone setup skipped', 'QA 직원 후보에 staff_id가 없습니다.');
    return { ok: false, skipped: true, reason: 'missing_staff_id' };
  }

  const phone = '010' + qaStaffTail8;
  const upsert = await apiRpc('admin.central.staff.upsert', {
    staff: {
      staff_id: staffId,
      name: String(candidate.name || candidate.staff_name || staffId || 'QA직원').trim(),
      role: String(candidate.role || 'teacher').trim(),
      status: String(candidate.status || 'active').trim(),
      revoked: String(candidate.revoked || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
      staff_phone: phone,
      phone
    }
  });

  if (upsert?.ok) ok('QA staff phone ensured', `${staffId} -> 010****${qaStaffTail8.slice(-4)}`);
  else warn('QA staff phone ensure failed', upsert?.error?.message || 'admin.central.staff.upsert failed');
  return upsert;
}

async function shot(label, fullPage = true) {
  if (!page) return '';
  const file = `${String(screenshots.length + 1).padStart(2, '0')}_${pathSafe(label)}.png`;
  const full = join(runDir, file);
  try {
    await page.screenshot({ path: full, fullPage });
    screenshots.push({ label, file, path: full });
    return full;
  } catch (e) {
    warn('screenshot failed', `${label}: ${e?.message || e}`);
    return '';
  }
}

async function step(label, fn, options = {}) {
  try {
    await fn();
    if (options.screenshot !== false) await shot(label, options.fullPage !== false);
    ok(label);
  } catch (e) {
    await shot('FAILED_' + label, true);
    fail(label, e?.message || String(e));
  }
}

async function waitQuiet(ms = 400) {
  await page.waitForTimeout(ms);
}

async function clickIfExists(selector, label, timeout = 3500) {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    ok(label || `click ${selector}`);
    return true;
  } catch {
    warn(label || `click ${selector}`, `not visible: ${selector}`);
    return false;
  }
}

async function fillIfExists(selector, value, label, timeout = 3500) {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.fill(String(value || ''));
    ok(label || `fill ${selector}`);
    return true;
  } catch {
    warn(label || `fill ${selector}`, `not visible: ${selector}`);
    return false;
  }
}

async function clickNav(go) {
  const selector = `.navBtn[data-go="${go}"]`;
  if (await clickIfExists(selector, `nav ${go}`, 3000)) {
    await waitQuiet(700);
    await shot('nav_' + go, true);
  }
}

async function domAudit(label) {
  const audit = await page.evaluate(() => {
    const visible = el => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!s || s.display === 'none' || s.visibility === 'hidden' || r.width <= 0 || r.height <= 0) return false;
      if (Number(s.opacity || '1') === 0 || s.pointerEvents === 'none') return false;
      if (el.id === 'fullModal' && !el.classList.contains('show')) return false;
      if (el.id === 'workDrawer' && !el.classList.contains('on')) return false;
      if (el.closest && el.closest('#workDrawer:not(.on), #fullModal:not(.show)')) return false;
      return true;
    };
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id).filter(Boolean);
    const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].slice(0, 30);
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible).slice(0, 80).map(el => ({
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      id: el.id || '',
      disabled: !!el.disabled
    }));
    const inputs = [...document.querySelectorAll('input,select,textarea')].filter(visible).slice(0, 80).map(el => ({
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      valueLen: String(el.value || '').length,
      disabled: !!el.disabled
    }));
    const overflow = [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth + 24 || r.right > window.innerWidth + 24;
    }).slice(0, 20).map(el => ({
      tag: el.tagName,
      id: el.id || '',
      cls: String(el.className || '').slice(0, 80),
      right: Math.round(el.getBoundingClientRect().right),
      width: Math.round(el.getBoundingClientRect().width)
    }));
    return {
      title: document.title,
      url: location.href,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1000),
      buttons,
      inputs,
      dupIds,
      overflow,
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  });
  writeFileSync(join(runDir, `${pathSafe(label)}_dom.json`), JSON.stringify(audit, null, 2), 'utf8');
  if (audit.dupIds?.length) warn(`${label} duplicate ids`, audit.dupIds.join(', '));
  if (audit.overflow?.length) warn(`${label} horizontal overflow`, JSON.stringify(audit.overflow.slice(0, 5)));
  ok(`${label} DOM audit`, `${audit.buttons.length} buttons, ${audit.inputs.length} inputs`);
  return audit;
}

async function apiRpc(op, args = {}) {
  const started = Date.now();
  let body = null;
  let status = 0;
  try {
    const res = await fetch(urlOf('/api/rpc'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, args, sessionToken })
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text || '{}'); } catch { body = { ok: false, error: { code: 'BAD_JSON', message: text.slice(0, 800) } }; }
  } catch (e) {
    body = { ok: false, error: { code: 'FETCH_ERROR', message: e?.message || String(e) } };
  }
  const item = { op, httpStatus: status, ms: Date.now() - started, ok: !!body?.ok, error: body?.error || null };
  apiResults.push(item);
  if (item.ok) ok(`api ${op}`, `http=${status}, ${item.ms}ms`);
  else fail(`api ${op}`, `http=${status}, ${item.ms}ms, code=${body?.error?.code || ''}, msg=${body?.error?.message || ''}`);
  return body;
}

async function launchBrowser() {
  const launchOptionsBase = {
    headless,
    args: ['--disable-dev-shm-usage', '--no-first-run']
  };
  const attempts = [
    { channel: 'msedge', name: 'Microsoft Edge' },
    { channel: 'chrome', name: 'Google Chrome' },
    { name: 'bundled Chromium' }
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const opts = { ...launchOptionsBase };
      if (attempt.channel) opts.channel = attempt.channel;
      const b = await chromium.launch(opts);
      ok('browser launched', attempt.name + (headless ? ' headless' : ' headed'));
      return b;
    } catch (e) {
      lastError = e;
      warn('browser launch attempt failed', `${attempt.name}: ${e?.message || e}`);
    }
  }
  throw lastError || new Error('browser launch failed');
}

async function run() {
  browser = await launchBrowser();
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true
  });
  page = await context.newPage();

  page.on('console', msg => {
    const type = msg.type();
    const text = mask(msg.text());
    if (['error', 'warning'].includes(type)) consoleEvents.push({ type, text, url: page.url(), at: new Date().toISOString() });
  });
  page.on('pageerror', err => pageErrors.push({ message: mask(err?.message || String(err)), stack: mask(err?.stack || ''), url: page.url(), at: new Date().toISOString() }));
  page.on('requestfailed', req => failedRequests.push({ method: req.method(), url: mask(req.url()), failure: req.failure()?.errorText || '', at: new Date().toISOString() }));
  page.on('response', res => {
    const status = res.status();
    if (status >= 400) badResponses.push({ status, url: mask(res.url()), at: new Date().toISOString() });
  });

  await step('root page loads', async () => {
    const res = await page.goto(urlOf('/'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || !res.ok()) throw new Error(`GET / failed: ${res?.status()}`);
    await waitQuiet(800);
  });
  await domAudit('root');

  await step('kiosk phone input', async () => {
    await clickIfExists('#btnCHECK_IN', 'kiosk check-in button', 2000);
    const mid = page.locator('#kPhoneMid');
    const last = page.locator('#kPhoneLast');
    await mid.waitFor({ state: 'visible', timeout: 5000 });
    await mid.click();
    await page.keyboard.type(qaStudentTail8, { delay: 15 });
    await waitQuiet(250);
    const midVal = await mid.inputValue().catch(() => '');
    const lastVal = await last.inputValue().catch(() => '');
    const visibleDigits = (midVal + lastVal).replace(/\D/g, '');
    const rawDigits = await page.locator('#kInput').inputValue().catch(() => '');
    const submitting = await page.evaluate(() => !!window.__THEOREUM_KIOSK_SUBMITTING__ || !!document.querySelector('.modalSpinner, .spinner, [aria-busy="true"]')).catch(() => false);
    const modalText = await page.locator('#fullModal').innerText({ timeout: 800 }).catch(() => '');

    if (visibleDigits.length < 8 && normalizeTail8(rawDigits).length < 8 && !submitting && !/처리|완료|등록|찾지 못|문의|중복|입력/.test(modalText)) {
      throw new Error(`phone input lost digits: mid=${midVal}, last=${lastVal}, raw=${rawDigits}`);
    }
  });
  await domAudit('kiosk_after_phone');

  await step('kiosk staff hotword', async () => {
    await page.goto(urlOf('/'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitQuiet(700);
    await page.keyboard.type('staff');
    await waitQuiet(700);
    const visible = await page.locator('#kStaffQuick').evaluate(el => !el.hasAttribute('aria-hidden') || el.getAttribute('aria-hidden') === 'false').catch(() => false);
    const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    if (!visible && !/직원 출근|직원 모드/.test(body)) throw new Error('staff hotword did not open staff quick mode');
  });
  await domAudit('kiosk_staff_hotword');

  await apiRpc('auth.login', { staff_id: staffId, password });
  const loginBody = apiResults.at(-1)?.ok ? null : null;
  // Re-login via fetch to capture sessionToken without writing it to the report.
  const loginRes = await fetch(urlOf('/api/rpc'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'auth.login', args: { staff_id: staffId, password } })
  });
  const loginJson = await loginRes.json().catch(() => null);
  sessionToken = String(loginJson?.data?.sessionToken || loginJson?.data?.session_token || '').trim();
  if (!sessionToken) throw new Error('API login succeeded check did not produce sessionToken');

  await step('admin page login', async () => {
    const res = await page.goto(urlOf('/admin.html'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || !res.ok()) throw new Error(`GET /admin.html failed: ${res?.status()}`);
    await fillIfExists('#loginId', staffId, 'admin login id', 5000);
    await fillIfExists('#loginPw', password, 'admin login password', 5000);
    await clickIfExists('#btnLogin', 'admin login button', 5000);
    await page.waitForFunction(() => {
      const app = document.querySelector('#appView');
      const msg = document.querySelector('#loginMsg');
      const appVisible = app && !app.classList.contains('hidden');
      const msgText = msg ? String(msg.textContent || '').trim() : '';
      return appVisible || msgText.length > 0;
    }, { timeout: timeoutMs });
    const loginMsg = await page.locator('#loginMsg').innerText({ timeout: 1000 }).catch(() => '');
    if (/실패|오류|invalid|denied/i.test(loginMsg)) throw new Error('admin login message: ' + loginMsg);
    await waitQuiet(1200);
  });
  await domAudit('admin_after_login');

  await step('admin core api parity', async () => {
    await apiRpc('meta.supportedOps');
    await apiRpc('auth.me', {});
    await apiRpc('admin.finalReadiness');
    await apiRpc('admin.phoneIdentity.audit');
    await apiRpc('admin.central.staff.list', { force: true });
    const searchBody = await apiRpc('admin.master.searchStudents', { q: qaStudentId || qaStudentQuery, limit: 5 });
    const students = extractStudentsFromSearchPayload(searchBody);
    const resolvedId = qaStudentId || String(students[0]?.student_id || '').trim();
    if (resolvedId) await apiRpc('admin.lectureAssignment.list', { student_id: resolvedId, include_archived: true, limit: 5 });
    else warn('admin lecture assignment list skipped', 'QA student id was not resolved from admin.master.searchStudents');
  }, { screenshot: false });

  for (const go of ['dashboard', 'students', 'attendance', 'clinic', 'words', 'messages', 'classes', 'reports', 'staff', 'advanced']) {
    await step('admin nav ' + go, async () => {
      await clickNav(go);
    }, { screenshot: false });
  }

  await step('phone identity audit UI', async () => {
    await clickNav('advanced');
    await clickIfExists('#btnPhoneIdentityAudit', 'phone identity audit button', 5000);
    await waitQuiet(2500);
    const text = await page.locator('#phoneIdentitySummary, #phoneIdentityRows').evaluateAll(els => els.map(e => e.innerText).join('\n')).catch(() => '');
    if (/점검 전입니다/.test(text)) throw new Error('phone identity UI did not update');
  });
  await domAudit('advanced_phone_identity');

  await step('staff management UI', async () => {
    await clickNav('staff');
    await clickIfExists('#btnCentralLoadStaff', 'load central staff', 5000);
    await waitQuiet(1800);
    const phoneInputVisible = await page.locator('#centralStaffPhone').isVisible().catch(() => false);
    if (!phoneInputVisible) throw new Error('centralStaffPhone input is not visible');
  });
  await domAudit('staff_management');

  await step('student search and link area UI', async () => {
    await clickNav('students');
    await fillIfExists('#studentQuery', qaStudentQuery, 'student query', 5000);
    await clickIfExists('#btnMasterStudentSearch', 'student search button', 5000);
    await waitQuiet(2500);
    const body = await page.locator('body').innerText({ timeout: 3000 });
    if (!body.includes('학생 오늘 링크') || !body.includes('온라인강의 배정')) {
      throw new Error('student link or lecture area is not visible');
    }
  });
  await domAudit('students_search');

  let studentIdForWrite = qaStudentId;
  const searchJson = await fetch(urlOf('/api/rpc'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'admin.master.searchStudents', sessionToken, args: { q: qaStudentId || qaStudentQuery, limit: 5 } })
  }).then(r => r.json()).catch(() => null);
  const students = extractStudentsFromSearchPayload(searchJson);
  if (!studentIdForWrite && students[0]?.student_id) studentIdForWrite = String(students[0].student_id);

  if (studentIdForWrite) {
    await apiRpc('admin.lectureAssignment.list', { student_id: studentIdForWrite, include_archived: true, limit: 5 });
    if (writeMode) {
      const stamp = new Date().toISOString().slice(0, 10);
      await apiRpc('admin.lectureAssignment.save', {
        student_id: studentIdForWrite,
        title: 'QA Deep 온라인강의 숨김 테스트 ' + stamp,
        url: 'https://example.com/theoreum-deep-qa',
        status: 'ARCHIVED',
        visible_to_student: false,
        note: 'production deep click QA hidden test'
      });
      const linkJson = await apiRpc('admin.studentTodayLink.create', { student_id: studentIdForWrite, origin: baseUrl, expires_days: 1 });
      const publicUrl = String(linkJson?.data?.public_url || '');
      if (publicUrl) {
        await step('student today public link opens', async () => {
          const res = await page.goto(publicUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (!res || !res.ok()) throw new Error(`GET student today public link failed: ${res?.status()}`);
          await waitQuiet(1200);
          const body = await page.locator('body').innerText({ timeout: 5000 });
          if (!/온라인강의|오늘/.test(body)) throw new Error('student today page did not render expected text');
        });
        await domAudit('student_today_public');
      }
    } else {
      warn('write UI/API checks skipped', 'Run npm run prod:qa:deep:write for link creation and hidden lecture write test.');
    }
  } else {
    warn('QA student id not resolved', `query=${qaStudentQuery}`);
  }

  if (writeMode && qaStaffTail8) {
    await ensureQaStaffPhoneForWrite();
    await step('staff phone clock write test', async () => {
      const res = await fetch(urlOf('/api/staff-clock'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'IN', phone_tail8: qaStaffTail8, input_mode: 'WEB', note: 'production deep click QA' })
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`staff-clock http=${res.status}: ${body.slice(0, 500)}`);
    }, { screenshot: false });
  } else if (qaStaffTail8) {
    warn('staff clock write skipped', 'Run npm run prod:qa:deep:write to perform staff phone clock test.');
  }

  await step('student-today static page exists', async () => {
    const res = await page.goto(urlOf('/student-today.html'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || !res.ok()) throw new Error(`GET /student-today.html failed: ${res?.status()}`);
  });
  await domAudit('student_today_static');
}

function writeReports() {
  const bundleResult = createScreenshotBundle();
  if (!bundleResult.ok) {
    stepWarned += 1;
    results.push({ status: 'WARN', label: 'screenshot bundle failed', detail: mask(bundleResult.reason || 'unknown'), at: new Date().toISOString() });
  } else {
    results.push({ status: 'OK', label: 'screenshot bundle created', detail: mask(bundleResult.path || bundlePath), at: new Date().toISOString() });
  }

  const failedCount = stepFailed;
  const warnCount = stepWarned + consoleEvents.length + pageErrors.length + failedRequests.length + badResponses.length;
  const lines = [
    '# TheOreum Production Deep Click QA Report',
    '',
    `- Base URL: ${baseUrl}`,
    `- Mode: ${writeMode ? 'write-enabled deep QA' : 'read-only deep QA'}`,
    `- Browser: ${headless ? 'headless' : 'headed'}`,
    `- Generated at: ${new Date().toISOString()}`,
    `- Failed: ${failedCount}`,
    `- Warnings/Signals: ${warnCount}`,
    `- Screenshot dir: ${runDir}`,
    `- Screenshot bundle: ${bundlePath}`,
    '',
    '## What this checked',
    '- Real browser page load',
    '- Kiosk phone input and staff hotword',
    '- Admin login UI',
    '- Core menu navigation',
    '- Phone identity UI',
    '- Staff management phone field',
    '- Student search / student link / online lecture area',
    '- Student today static page',
    '- Console errors, page errors, failed requests, and HTTP 400/500 responses',
    '',
    '## Results',
    ...results.map(r => `- ${r.status} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`),
    '',
    '## Browser signals',
    `- Console warnings/errors: ${consoleEvents.length}`,
    `- Page errors: ${pageErrors.length}`,
    `- Failed requests: ${failedRequests.length}`,
    `- HTTP 400/500 responses: ${badResponses.length}`,
    '',
    '## Screenshots',
    ...screenshots.map(s => `- ${s.label}: ${s.path}`),
    '',
    '## Console events',
    ...(consoleEvents.length ? consoleEvents.slice(0, 80).map(e => `- ${e.type}: ${e.text}`) : ['- none']),
    '',
    '## Page errors',
    ...(pageErrors.length ? pageErrors.slice(0, 40).map(e => `- ${e.message}`) : ['- none']),
    '',
    '## Failed requests',
    ...(failedRequests.length ? failedRequests.slice(0, 80).map(e => `- ${e.method} ${e.url} — ${e.failure}`) : ['- none']),
    '',
    '## Bad HTTP responses',
    ...(badResponses.length ? badResponses.slice(0, 100).map(e => `- HTTP ${e.status} ${e.url}`) : ['- none']),
    '',
    '## API results',
    ...(apiResults.length ? apiResults.map(e => `- ${e.ok ? 'OK' : 'FAIL'} ${e.op} — http=${e.httpStatus}, ${e.ms}ms${e.error ? `, code=${e.error.code || ''}, msg=${mask(e.error.message || '')}` : ''}`) : ['- none'])
  ];
  const report = lines.join('\n');
  writeFileSync(reportPath, report, 'utf8');
  writeFileSync(copyPath, ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n'), 'utf8');
  writeFileSync(lastDirPath, runDir, 'utf8');
  writeFileSync(rawJsonPath, JSON.stringify({
    baseUrl,
    writeMode,
    headless,
    runDir,
    results,
    consoleEvents,
    pageErrors,
    failedRequests,
    badResponses,
    screenshots,
    screenshotBundle: bundleResult,
    apiResults
  }, null, 2), 'utf8');
  console.log('\nReport:', reportPath);
  console.log('Copy block:', copyPath);
  console.log('Screenshots:', runDir);
  console.log('Screenshot bundle:', bundlePath);
}

function finishAndExit(code) {
  try { writeReports(); } catch (e) { console.error('Could not write report:', e?.message || e); }
  process.exit(code);
}

try {
  await run();
} catch (e) {
  fail('deep QA runner fatal', e?.message || String(e));
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  writeReports();
}

if (stepFailed > 0) process.exit(1);
process.exit(0);
