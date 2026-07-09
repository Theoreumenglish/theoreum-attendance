#!/usr/bin/env node
// TheOreum production deep click QA runner.
// Runs on the user's PC, opens the real site with Playwright, logs in, clicks core screens,
// captures screenshots, console/page/network errors, and creates a copy-ready report.
// Secrets are read from env/.env.qa.local but are never written to reports.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
const slowApiMs = Number(process.env.QA_SLOW_API_MS || 5000) || 5000;
const verySlowApiMs = Number(process.env.QA_VERY_SLOW_API_MS || 10000) || 10000;
const runId = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const logDir = resolve(process.cwd(), '_logs');
const deepRoot = resolve(logDir, 'deep-qa');
const runDir = resolve(deepRoot, runId);
const reportPath = resolve(logDir, 'PRODUCTION_DEEP_QA_REPORT.md');
const copyPath = resolve(logDir, 'PRODUCTION_DEEP_QA_TO_SEND.txt');
const lastDirPath = resolve(logDir, 'PRODUCTION_DEEP_QA_LAST_DIR.txt');
const rawJsonPath = resolve(logDir, 'PRODUCTION_DEEP_QA_RAW.json');
const latestBundlePath = resolve(logDir, 'PRODUCTION_DEEP_QA_BUNDLE.zip');
const runBundlePath = resolve(logDir, `PRODUCTION_DEEP_QA_BUNDLE_${runId}.zip`);
const latestSourcePath = resolve(logDir, 'PRODUCTION_DEEP_QA_SOURCE.zip');
const runSourcePath = resolve(logDir, `PRODUCTION_DEEP_QA_SOURCE_${runId}.zip`);
const latestPackagePath = resolve(logDir, 'PRODUCTION_DEEP_QA_PACKAGE.zip');
const runPackagePath = resolve(logDir, `PRODUCTION_DEEP_QA_PACKAGE_${runId}.zip`);
const bundlePath = runBundlePath;

mkdirSync(runDir, { recursive: true });

const results = [];
const consoleEvents = [];
const pageErrors = [];
const failedRequests = [];
const ignoredRequests = [];
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

function pngDimensions(filePath) {
  try {
    const buf = readFileSync(filePath);
    if (!buf || buf.length < 24) return null;
    const isPng =
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a;
    if (!isPng) return null;
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

const visualHeightLimits = new Map([
  ['nav_classes', 3000],
  ['phone identity audit UI', 2400],
  ['staff management UI', 2800],
  ['student search and link area UI', 1600],
  ['student today public link opens', 1600]
]);


function createScreenshotBundle() {
  try {
    if (!existsSync(runDir)) return { ok: false, reason: 'run_dir_missing' };
    if (process.platform === 'win32') {
      const ps = [
        '$ErrorActionPreference = "Stop"',
        `$src = ${JSON.stringify(join(runDir, '*'))}`,
        `$dest = ${JSON.stringify(runBundlePath)}`,
        `$latest = ${JSON.stringify(latestBundlePath)}`,
        'if (Test-Path $dest) { Remove-Item $dest -Force }',
        'if (Test-Path $latest) { Remove-Item $latest -Force }',
        'Compress-Archive -Path $src -DestinationPath $dest -Force',
        'Copy-Item -Path $dest -Destination $latest -Force'
      ].join('; ');
      const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
      if (out.status === 0 && existsSync(runBundlePath)) return { ok: true, path: runBundlePath, latestPath: latestBundlePath, method: 'powershell_Compress-Archive' };
      return { ok: false, reason: (out.stderr || out.stdout || 'Compress-Archive failed').slice(0, 500) };
    }

    try { if (existsSync(runBundlePath)) spawnSync('rm', ['-f', runBundlePath]); } catch {}
    try { if (existsSync(latestBundlePath)) spawnSync('rm', ['-f', latestBundlePath]); } catch {}
    const out = spawnSync('zip', ['-qr', runBundlePath, '.'], { cwd: runDir, encoding: 'utf8' });
    if (out.status === 0 && existsSync(runBundlePath)) {
      spawnSync('cp', ['-f', runBundlePath, latestBundlePath]);
      return { ok: true, path: runBundlePath, latestPath: latestBundlePath, method: 'zip' };
    }
    return { ok: false, reason: (out.stderr || out.stdout || 'zip command failed').slice(0, 500) };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}



function isExcludedSourcePath(relPath, fileName = '') {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = rel.split('/').filter(Boolean);
  const excludedDirs = new Set([
    'node_modules',
    'dist',
    '_logs',
    '.git',
    '.vercel',
    '_backups',
    '_patch_tmp',
    '_release',
    '_releases',
    'patch-files',
    'patch_tmp',
    'patch_v9',
    'patch_v10',
    'patch_v11',
    'patch_v11_fixed'
  ]);
  if (parts.some((part) => excludedDirs.has(part))) return 'excluded_dir';
  if (parts.some((part) => /^_patch_backup/i.test(part))) return 'patch_backup';
  if (parts.some((part) => /^_(?:backups?|patch_tmp|patches?|releases?)$/i.test(part))) return 'generated_work_dir';
  if (parts.some((part) => /^(?:patch_files|patch_tmp)$/i.test(part))) return 'generated_work_dir';
  if (parts.some((part) => /^(?:release|releases)$/i.test(part))) return 'release_dir';
  if (/^\.env/i.test(fileName || basename(rel))) return 'env_file';
  if (/\.(zip|7z|rar|log|tmp|bak)$/i.test(fileName || rel)) return 'generated_or_archive';
  if (/PRODUCTION_DEEP_QA_/i.test(rel)) return 'qa_generated';
  return '';
}

function copySourceTreeForQa(projectRoot, stage) {
  const manifest = {
    root: projectRoot,
    runId,
    generatedAt: new Date().toISOString(),
    includedFiles: 0,
    includedBytes: 0,
    skippedFiles: 0,
    skippedDirs: 0,
    skippedLargeFiles: 0,
    skippedSamples: [],
    maxFileBytes: Number(process.env.QA_SOURCE_MAX_FILE_BYTES || 5 * 1024 * 1024)
  };

  function rememberSkip(rel, reason) {
    manifest.skippedFiles += 1;
    if (manifest.skippedSamples.length < 80) manifest.skippedSamples.push({ path: rel, reason });
  }

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(projectRoot, full).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) continue;

      const excluded = isExcludedSourcePath(rel, entry.name);
      if (entry.isDirectory()) {
        if (excluded) {
          manifest.skippedDirs += 1;
          if (manifest.skippedSamples.length < 80) manifest.skippedSamples.push({ path: rel + '/', reason: excluded });
          continue;
        }
        walk(full);
        continue;
      }

      if (!entry.isFile()) {
        rememberSkip(rel, 'not_regular_file');
        continue;
      }

      if (excluded) {
        rememberSkip(rel, excluded);
        continue;
      }

      const st = statSync(full);
      if (st.size > manifest.maxFileBytes) {
        manifest.skippedLargeFiles += 1;
        rememberSkip(rel, `larger_than_${manifest.maxFileBytes}`);
        continue;
      }

      const target = join(stage, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(full, target);
      manifest.includedFiles += 1;
      manifest.includedBytes += st.size;
    }
  }

  walk(projectRoot);

  const readme = [
    'TheOreum Deep QA source snapshot',
    `Run ID: ${runId}`,
    `Generated: ${manifest.generatedAt}`,
    '',
    'This snapshot is intentionally sanitized.',
    'Excluded by design: .env*, node_modules, dist, _logs, .git, .vercel, patch backups, release folders, zip/log/tmp/bak files, and large generated files.',
    '',
    `Included files: ${manifest.includedFiles}`,
    `Included bytes: ${manifest.includedBytes}`,
    `Skipped files: ${manifest.skippedFiles}`,
    `Skipped directories: ${manifest.skippedDirs}`,
    '',
    'Purpose: let ChatGPT review the exact local code shape that produced this QA result without exposing local secrets or bulky generated folders.'
  ].join('\n');

  writeFileSync(join(stage, 'SOURCE_SNAPSHOT_README.txt'), readme, 'utf8');
  writeFileSync(join(stage, 'SOURCE_SNAPSHOT_MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return manifest;
}

function compressStagedDirectory(stage, dest, latest) {
  if (process.platform === 'win32') {
    const ps = [
      '$ErrorActionPreference = "Stop"',
      `$stage = ${JSON.stringify(stage)}`,
      `$dest = ${JSON.stringify(dest)}`,
      `$latest = ${JSON.stringify(latest)}`,
      'if (Test-Path $dest) { Remove-Item $dest -Force }',
      'if (Test-Path $latest) { Remove-Item $latest -Force }',
      'Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $dest -Force',
      'Copy-Item -Path $dest -Destination $latest -Force'
    ].join('; ');
    const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
    if (out.status === 0 && existsSync(dest)) return { ok: true, method: 'powershell_Compress-Archive' };
    return { ok: false, reason: (out.stderr || out.stdout || 'Compress-Archive failed').slice(0, 800) };
  }

  try { if (existsSync(dest)) rmSync(dest, { force: true }); } catch {}
  try { if (existsSync(latest)) rmSync(latest, { force: true }); } catch {}
  const out = spawnSync('zip', ['-qr', dest, '.'], { cwd: stage, encoding: 'utf8' });
  if (out.status === 0 && existsSync(dest)) {
    spawnSync('cp', ['-f', dest, latest]);
    return { ok: true, method: 'zip' };
  }
  return { ok: false, reason: (out.stderr || out.stdout || 'zip command failed').slice(0, 800) };
}

function createSourceSnapshot() {
  const stage = resolve(logDir, `deep-qa-source-${runId}`);
  try {
    const projectRoot = process.cwd();
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });

    const manifest = copySourceTreeForQa(projectRoot, stage);
    if (manifest.includedFiles <= 0) {
      return { ok: false, reason: 'source snapshot included zero files after exclusions' };
    }

    const compressed = compressStagedDirectory(stage, runSourcePath, latestSourcePath);
    if (!compressed.ok) return compressed;

    return {
      ok: true,
      path: runSourcePath,
      latestPath: latestSourcePath,
      method: `sanitized_${compressed.method}`,
      includedFiles: manifest.includedFiles,
      includedBytes: manifest.includedBytes,
      skippedFiles: manifest.skippedFiles,
      skippedDirs: manifest.skippedDirs
    };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    try { if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); } catch {}
  }
}

function createFullQaPackage() {
  try {
    const stage = resolve(logDir, `deep-qa-package-${runId}`);
    if (process.platform === 'win32') {
      const ps = [
        '$ErrorActionPreference = "Stop"',
        `$stage = ${JSON.stringify(stage)}`,
        `$dest = ${JSON.stringify(runPackagePath)}`,
        `$latest = ${JSON.stringify(latestPackagePath)}`,
        `$screenshot = ${JSON.stringify(runBundlePath)}`,
        `$source = ${JSON.stringify(runSourcePath)}`,
        `$report = ${JSON.stringify(reportPath)}`,
        `$copy = ${JSON.stringify(copyPath)}`,
        `$raw = ${JSON.stringify(rawJsonPath)}`,
        'if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }',
        'New-Item -ItemType Directory -Path $stage -Force | Out-Null',
        'if (Test-Path $screenshot) { Copy-Item $screenshot (Join-Path $stage (Split-Path $screenshot -Leaf)) -Force }',
        'if (Test-Path $source) { Copy-Item $source (Join-Path $stage (Split-Path $source -Leaf)) -Force }',
        'if (Test-Path $report) { Copy-Item $report (Join-Path $stage "PRODUCTION_DEEP_QA_REPORT.md") -Force }',
        'if (Test-Path $copy) { Copy-Item $copy (Join-Path $stage "PRODUCTION_DEEP_QA_TO_SEND.txt") -Force }',
        'if (Test-Path $raw) { Copy-Item $raw (Join-Path $stage "PRODUCTION_DEEP_QA_RAW.json") -Force }',
        '$readme = @()',
        '$readme += "TheOreum Deep QA Full Package"',
        '$readme += "Run ID: ' + runId + '"',
        '$readme += ""',
        '$readme += "Contains screenshot bundle, source snapshot, and QA reports."',
        '$readme += "Send this package to ChatGPT when you want code + screenshots reviewed together."',
        'Set-Content -Path (Join-Path $stage "README_FULL_QA_PACKAGE.txt") -Value ($readme -join "`r`n") -Encoding UTF8',
        'if (Test-Path $dest) { Remove-Item $dest -Force }',
        'if (Test-Path $latest) { Remove-Item $latest -Force }',
        'Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $dest -Force',
        'Copy-Item -Path $dest -Destination $latest -Force'
      ].join('; ');
      const out = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
      if (out.status === 0 && existsSync(runPackagePath)) return { ok: true, path: runPackagePath, latestPath: latestPackagePath, method: 'powershell_full_package' };
      return { ok: false, reason: (out.stderr || out.stdout || 'full package failed').slice(0, 800) };
    }

    spawnSync('rm', ['-rf', stage]);
    mkdirSync(stage, { recursive: true });
    const copies = [
      [runBundlePath, basename(runBundlePath)],
      [runSourcePath, basename(runSourcePath)],
      [reportPath, 'PRODUCTION_DEEP_QA_REPORT.md'],
      [copyPath, 'PRODUCTION_DEEP_QA_TO_SEND.txt'],
      [rawJsonPath, 'PRODUCTION_DEEP_QA_RAW.json']
    ];
    for (const [src, name] of copies) {
      if (existsSync(src)) spawnSync('cp', ['-f', src, join(stage, name)]);
    }
    writeFileSync(join(stage, 'README_FULL_QA_PACKAGE.txt'), [
      'TheOreum Deep QA Full Package',
      `Run ID: ${runId}`,
      '',
      'Contains screenshot bundle, source snapshot, and QA reports.',
      'Send this package to ChatGPT when you want code + screenshots reviewed together.'
    ].join('\n'), 'utf8');
    const out = spawnSync('zip', ['-qr', runPackagePath, '.'], { cwd: stage, encoding: 'utf8' });
    if (out.status === 0 && existsSync(runPackagePath)) {
      spawnSync('cp', ['-f', runPackagePath, latestPackagePath]);
      return { ok: true, path: runPackagePath, latestPath: latestPackagePath, method: 'zip_full_package' };
    }
    return { ok: false, reason: (out.stderr || out.stdout || 'zip full package failed').slice(0, 800) };
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

function isBenignAbortedRequest(req) {
  const failure = req?.failure?.()?.errorText || '';
  const url = String(req?.url?.() || '');
  if (!/ERR_ABORTED/i.test(failure)) return false;
  // Navigation can abort an in-flight RPC when the QA runner moves to the next screen.
  // Treat it as a signal only when it is not a Vercel/browser navigation abort.
  if (/\/api\/rpc(?:\?|$)/.test(url)) return true;
  if (/favicon\.ico(?:\?|$)/i.test(url)) return true;
  return false;
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
  const upsert = await apiRpc('admin.central.staff.phoneOnly', {
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
  else warn('QA staff phone ensure failed', upsert?.error?.message || 'admin.central.staff.phoneOnly failed');
  return upsert;
}

async function shot(label, fullPage = true) {
  if (!page) return '';
  const safeLabel = pathSafe(label);
  const file = `${String(screenshots.length + 1).padStart(2, '0')}_${safeLabel}.png`;
  const full = join(runDir, file);
  try {
    await page.screenshot({ path: full, fullPage });
    const dim = pngDimensions(full);
    screenshots.push({ label, file, path: full, width: dim?.width || 0, height: dim?.height || 0 });
    const limit = visualHeightLimits.get(label) || visualHeightLimits.get(safeLabel);
    if (limit && dim && dim.height > limit) {
      fail('visual height ' + label, `${dim.height}px > ${limit}px; screen is too tall for operator/QA review`);
    } else if (limit && dim) {
      ok('visual height ' + label, `${dim.height}px <= ${limit}px`);
    }
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

async function bringIntoView(locator) {
  try {
    if (await locator.count()) {
      await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.waitForTimeout(120);
    }
  } catch {}
}

async function clickIfExists(selector, label, timeout = 3500) {
  const loc = page.locator(selector).first();
  try {
    await bringIntoView(loc);
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
    ok(label || `click ${selector}`);
    return true;
  } catch {
    try {
      const clicked = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return true;
      }, selector);
      if (clicked) {
        ok(label || `click ${selector}`, 'clicked after scroll');
        return true;
      }
    } catch {}
    warn(label || `click ${selector}`, `not visible: ${selector}`);
    return false;
  }
}

async function fillIfExists(selector, value, label, timeout = 3500) {
  const loc = page.locator(selector).first();
  try {
    await bringIntoView(loc);
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
    if (go === 'dashboard') {
      const todayGuard = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 20 && box.height > 20;
        };
        const board = document.querySelector('[data-today-priority-board]');
        const list = document.querySelector('#todayMissionList');
        const absenceRowsEl = document.querySelector('#todayAbsenceRows');
        const rows = absenceRowsEl ? Array.from(absenceRowsEl.querySelectorAll('tr[data-absence-late]')) : [];
        const calm = document.querySelector('.calmOpsShell');
        const dashboard = document.querySelector('#dashboard');
        const visibleText = document.body?.innerText || '';
        return {
          board: !!board,
          boardVisible: isVisible(board),
          dashboardVisible: isVisible(dashboard),
          calmVisible: isVisible(calm),
          v19: !!document.querySelector('[data-today-staff-todo-v19="true"]'),
          v20: !!document.querySelector('[data-today-clean-v20="true"]'),
          v21: !!document.querySelector('[data-today-labels-v21="true"]'),
          v22: !!document.querySelector('[data-today-clean-v22="true"]'),
          v23: !!document.querySelector('[data-today-clean-v23="true"]'),
          v35: !!document.querySelector('[data-today-task-state-v35="true"]'),
          workerSummary: !!document.querySelector('[data-today-worker-summary="true"]'),
          absenceGuideVisible: !!document.querySelector('[data-today-absence-guide="true"]') && isVisible(document.querySelector('[data-today-absence-guide="true"]')),
          compactTaskCopyVisible: /다음 행동:|처리 기준|숫자가 뜬 항목부터|조교·강사가 오늘 놓치면/.test(visibleText),
          missions: list ? list.querySelectorAll('[data-today-action]').length : 0,
          missionMeta: list ? list.querySelectorAll('.todayMissionMeta').length : 0,
          missionNext: list ? list.querySelectorAll('.todayMissionNext').length : 0,
          absenceRows: absenceRowsEl ? absenceRowsEl.querySelectorAll('tr').length : 0,
          actionableRows: rows.length,
          headline: document.querySelector('#todayUrgentHeadline')?.innerText || '',
          quickExcuseButtons: document.querySelectorAll('#todayAbsenceRows [data-abs-quick-excuse-class]').length,
          directInputButtons: document.querySelectorAll('#todayAbsenceRows [data-abs-excuse-class]').length,
          manualInputButtons: document.querySelectorAll('#todayAbsenceRows [data-abs-manual-student]').length,
          autoRefreshVisible: !!document.querySelector('#btnTodayAbsenceAuto') && isVisible(document.querySelector('#btnTodayAbsenceAuto')),
          studentTaskCardVisible: !!document.querySelector('[data-daily-task="student"]') && isVisible(document.querySelector('[data-daily-task="student"]')),
          wordTaskCardVisible: !!document.querySelector('[data-daily-task="word"]') && isVisible(document.querySelector('[data-daily-task="word"]')),
          polishedDateControls: !!document.querySelector('.todayDateTools .todayDateInput') && !!document.querySelector('.todayDateTools .todayRefreshAction'),
          studentPhoneCopyButtons: document.querySelectorAll('[data-abs-copy-student]').length,
          parentPhoneCopyButtons: document.querySelectorAll('[data-abs-copy-parent]').length,
          legacyCopyButtons: document.querySelectorAll('[data-abs-copy]').length,
          actionText: absenceRowsEl ? Array.from(absenceRowsEl.querySelectorAll('.absenceQuickActions')).slice(0, 3).map(el => el.innerText || '').join(' ') : '',
          excusedLabelVisible: /\b예외\b/.test(document.querySelector('.liveAbsenceStats')?.innerText || ''),
          clinicButtons: document.querySelectorAll('[data-abs-clinic]').length,
          taskStateStrips: document.querySelectorAll('#todayAbsenceRows [data-today-task-state-v35="true"]').length,
          taskStateCompactMenus: document.querySelectorAll('#todayAbsenceRows [data-today-task-state-v36="compact-menu"]').length,
          taskStateMenuSummaries: document.querySelectorAll('#todayAbsenceRows .todayTaskStateMenu > summary').length,
          visibleStateButtons: Array.from(document.querySelectorAll('#todayAbsenceRows [data-abs-task-state]')).filter(isVisible).length,
          taskStateButtons: document.querySelectorAll('#todayAbsenceRows [data-abs-task-state]').length,
          taskStateBadges: document.querySelectorAll('#todayAbsenceRows .todayTaskStateBadge').length,
          workflowV37: !!document.querySelector('[data-today-workflow-v37="true"]'),
          workflowFiltersV37: document.querySelectorAll('[data-today-filter-v37="true"] [data-today-filter]').length,
          workflowLanesV37: document.querySelectorAll('[data-today-unified-lanes-v37="true"] [data-today-lane]').length,
          workflowCompletionV37: !!document.querySelector('[data-today-completion-v37="true"] #todayCompletionRate'),
          workflowV38: !!document.querySelector('[data-today-workflow-v38="true"]'),
          workflowFilterSelectV38: !!document.querySelector('[data-today-filter-select-v38="true"]'),
          workflowLaneCardsV38: document.querySelectorAll('[data-today-unified-lanes-v38="true"] [data-today-lane-card-v38]').length,
          workflowRowsV37: document.querySelectorAll('#todayAbsenceRows [data-today-filter-row-v37="true"]').length,
          studentTabButtons: document.querySelectorAll('[data-abs-student]').length,
          bannedIntroVisible: /학생 이름을 먼저 찾고|처음 쓰는 직원도|자동화 설명/.test(visibleText),
          topLate: rows.slice(0, 8).map(row => Number(row.getAttribute('data-absence-late') || 0))
        };
      }).catch(() => ({ board: false, boardVisible: false, dashboardVisible: false, calmVisible: true, missions: 0, absenceRows: 0, actionableRows: 0, quickExcuseButtons: 0, directInputButtons: 0, topLate: [], headline: '' }));
      if (!todayGuard.board) fail('today priority board', 'missing [data-today-priority-board]');
      else if (!todayGuard.dashboardVisible || !todayGuard.boardVisible) fail('today priority board', 'auto-generated today board exists but is not visible to staff');
      else if (todayGuard.calmVisible) fail('today priority board', 'static calm intro shell is still visible instead of the real work board');
      else if (!todayGuard.v19 || !todayGuard.v20 || !todayGuard.v21 || !todayGuard.v22 || !todayGuard.v23) fail('today clean task board', 'missing v23 clean task board marker');
      else if (!todayGuard.v35) fail('today task state v35', 'missing today task state v35 marker');
      else if (!todayGuard.workerSummary) fail('today clean task board', 'missing compact status counters');
      else if (todayGuard.bannedIntroVisible || todayGuard.compactTaskCopyVisible) fail('today clean task board', 'explanation copy is still visible on today tab');
      else if (todayGuard.missions < 1) fail('today priority board', 'no actionable mission items');
      else if (todayGuard.missionMeta > 0 || todayGuard.missionNext > 0) fail('today clean task board', 'mission rows still include explanation/meta lines');
      else if (todayGuard.autoRefreshVisible) fail('today clean task board', 'unclear 자동 ON/auto refresh toggle is visible');
      else if (todayGuard.studentTaskCardVisible) fail('today clean task board', 'student selected/search card is still visible on today task board');
      else if (todayGuard.wordTaskCardVisible) fail('today clean task board', 'vague class-level word task card is still visible on today board');
      else if (!todayGuard.polishedDateControls) fail('today clean task board', 'polished date/update controls are missing');
      else if (todayGuard.excusedLabelVisible) fail('today clean task board', 'old 예외 label is visible on phone-attendance today board');
      else ok('today priority board', `${todayGuard.missions} compact mission items · ${todayGuard.headline || 'headline ready'}`);
      if (todayGuard.absenceRows < 1) fail('today absence board rows', 'missing #todayAbsenceRows content');
      else if (todayGuard.actionableRows > 0) {
        const sorted = todayGuard.topLate.every((value, idx, arr) => idx === 0 || value <= arr[idx - 1]);
        if (!sorted) fail('today absence board rows', `not sorted by late minutes desc: ${todayGuard.topLate.join(',')}`);
        else if (todayGuard.absenceGuideVisible) fail('today clean task board', 'absence processing guide is still visible');
        else if (todayGuard.studentPhoneCopyButtons < todayGuard.actionableRows) fail('today absence phone copy actions', `${todayGuard.studentPhoneCopyButtons}/${todayGuard.actionableRows} student phone copy buttons rendered`);
        else if (todayGuard.parentPhoneCopyButtons < todayGuard.actionableRows) fail('today absence parent copy actions', `${todayGuard.parentPhoneCopyButtons}/${todayGuard.actionableRows} parent phone copy buttons rendered`);
        else if (todayGuard.legacyCopyButtons > 0) fail('today absence phone copy actions', 'legacy unclear 번호 button remains');
        else if (!/학생 번호 복사|학부모 번호 복사|학생 정보|클리닉 추가|출결 처리/.test(todayGuard.actionText || '')) fail('today absence action labels', 'clear v22 labels are missing');
        else if (/지각 연락|출결 입력/.test(todayGuard.actionText || '')) fail('today absence action labels', 'old unclear v21 labels remain');
        else if (todayGuard.quickExcuseButtons > 0) fail('today absence quick actions', 'old 지각 연락/quick excuse action remains on today board');
        else if (todayGuard.directInputButtons > 0) fail('today absence direct input actions', 'old exception input action remains on today board');
        else if (todayGuard.manualInputButtons < todayGuard.actionableRows) fail('today absence direct input actions', `${todayGuard.manualInputButtons}/${todayGuard.actionableRows} 출결 처리 buttons rendered`);
        else if (todayGuard.studentTabButtons < todayGuard.actionableRows) fail('today absence student tab actions', `${todayGuard.studentTabButtons}/${todayGuard.actionableRows} student tab buttons rendered`);
        else if (todayGuard.clinicButtons < todayGuard.actionableRows) fail('today absence clinic actions', `${todayGuard.clinicButtons}/${todayGuard.actionableRows} clinic buttons rendered`);
        else if (todayGuard.taskStateStrips < todayGuard.actionableRows || todayGuard.taskStateButtons < todayGuard.actionableRows * 4 || todayGuard.taskStateBadges < todayGuard.actionableRows) fail('today task state v35', `state controls missing strips=${todayGuard.taskStateStrips} buttons=${todayGuard.taskStateButtons} badges=${todayGuard.taskStateBadges} rows=${todayGuard.actionableRows}`);
        else if (todayGuard.taskStateCompactMenus < todayGuard.actionableRows || todayGuard.taskStateMenuSummaries < todayGuard.actionableRows) fail('today task state compact v36', `compact menu missing menus=${todayGuard.taskStateCompactMenus} summaries=${todayGuard.taskStateMenuSummaries} rows=${todayGuard.actionableRows}`);
        else if (todayGuard.visibleStateButtons > 0) fail('today task state compact v36', `state buttons should be hidden inside compact menu, visible=${todayGuard.visibleStateButtons}`);
        else if (!todayGuard.workflowV37 || !todayGuard.workflowCompletionV37) fail('today workflow v37', `missing progress UI completion=${todayGuard.workflowCompletionV37}`);
        else if (!todayGuard.workflowV38 || !todayGuard.workflowFilterSelectV38 || todayGuard.workflowLaneCardsV38 < 3) fail('today dashboard cleanup v38', `missing compact select/lane cards select=${todayGuard.workflowFilterSelectV38} laneCards=${todayGuard.workflowLaneCardsV38}`);
        else ok('today absence board rows', `${todayGuard.actionableRows} actionable rows · compact menu + v38 select filters ready`);
      } else ok('today absence board rows', `${todayGuard.absenceRows} row groups rendered`);
    }
    if (go === 'classes') {
      const scrollGuard = await page.evaluate(() => {
        const wrap = document.querySelector('#classes .opsClassListScroll');
        if (!wrap) return { exists: false };
        return {
          exists: true,
          clientHeight: Math.round(wrap.clientHeight || 0),
          scrollHeight: Math.round(wrap.scrollHeight || 0)
        };
      }).catch(() => ({ exists: false }));
      if (!scrollGuard.exists) {
        fail('classes list scroll guard', 'missing #classes .opsClassListScroll');
      } else {
        ok('classes list scroll guard', `${scrollGuard.clientHeight}px viewport / ${scrollGuard.scrollHeight}px content`);
      }
    }
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
      if (el.closest && el.closest('#workDrawer:not(.on), #fullModal:not(.show), [hidden], .hidden')) return false;
      if (el.closest && el.closest('details:not([open])') && !el.closest('summary')) return false;
      return true;
    };
    const overflowRelevant = el => {
      if (!visible(el)) return false;
      if (el.closest && el.closest('.tableWrap')) return false;
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' && r.left >= window.innerWidth) return false;
      return r.width > window.innerWidth + 24 || r.right > window.innerWidth + 24;
    };
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id).filter(Boolean);
    const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].slice(0, 30);
    const sectionId = el => el.closest?.('section.portalView')?.id || '';
    const allVisibleButtons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
    const allVisibleInputs = [...document.querySelectorAll('input,select,textarea')].filter(visible);
    const isDataRowButton = el => !!(el.closest && (el.closest('.opsDataTable') || el.classList.contains('opsKebabBtn') || el.hasAttribute('data-ops-menu-toggle') || el.hasAttribute('data-qa-passive') || el.closest('[data-qa-passive]')));
    const isDataRowInput = el => !!(el.closest && (el.closest('.opsDataTable') || el.classList.contains('opsCheck') || el.hasAttribute('data-ops-select') || el.hasAttribute('data-ops-select-all')));
    const buttons = allVisibleButtons.slice(0, 120).map(el => ({
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      id: el.id || '',
      sectionId: sectionId(el),
      disabled: !!el.disabled,
      qaIgnored: isDataRowButton(el)
    }));
    const inputs = allVisibleInputs.slice(0, 120).map(el => ({
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      sectionId: sectionId(el),
      valueLen: String(el.value || '').length,
      disabled: !!el.disabled,
      qaIgnored: isDataRowInput(el)
    }));
    const countedButtons = buttons.filter(x => !x.qaIgnored);
    const countedInputs = inputs.filter(x => !x.qaIgnored);
    const scopedCards = [...document.querySelectorAll('[data-section-scope]')].filter(visible).slice(0, 30).map(el => ({
      scope: el.getAttribute('data-section-scope') || '',
      sectionId: sectionId(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
    }));
    const overflow = [...document.querySelectorAll('body *')].filter(overflowRelevant).slice(0, 20).map(el => ({
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
      countedButtonCount: countedButtons.length,
      countedInputCount: countedInputs.length,
      ignoredDataRowButtonCount: buttons.length - countedButtons.length,
      ignoredDataRowInputCount: inputs.length - countedInputs.length,
      scopedCards,
      dupIds,
      overflow,
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  });
  writeFileSync(join(runDir, `${pathSafe(label)}_dom.json`), JSON.stringify(audit, null, 2), 'utf8');
  if (audit.dupIds?.length) warn(`${label} duplicate ids`, audit.dupIds.join(', '));
  if (audit.overflow?.length) warn(`${label} horizontal overflow`, JSON.stringify(audit.overflow.slice(0, 5)));
  ok(`${label} DOM audit`, `${audit.buttons.length} buttons (${audit.countedButtonCount ?? audit.buttons.length} counted), ${audit.inputs.length} inputs (${audit.countedInputCount ?? audit.inputs.length} counted)`);

  const visibleInputIds = new Set((audit.inputs || []).map(x => x.id).filter(Boolean));
  const staffOnlyInputs = ['staffManualStaffId', 'staffManualYmd', 'staffManualTime', 'staffManualNote', 'centralStaffId', 'centralStaffPhone'];
  if (!/^staff_management$/.test(label)) {
    const leaked = staffOnlyInputs.filter(id => visibleInputIds.has(id));
    if (leaked.length) throw new Error(`${label} staff-only inputs leaked outside staff view: ${leaked.join(', ')}`);
  }
  if (label === 'staff_management') {
    const required = ['staffManualStaffId', 'centralStaffId', 'centralStaffPhone'];
    const missing = required.filter(id => !visibleInputIds.has(id));
    if (missing.length) throw new Error(`staff view missing required staff inputs: ${missing.join(', ')}`);
    const wrongSection = (audit.inputs || []).filter(x => required.includes(x.id) && x.sectionId !== 'staff');
    if (wrongSection.length) throw new Error(`staff inputs are not inside #staff: ${wrongSection.map(x => `${x.id}:${x.sectionId || 'none'}`).join(', ')}`);
  }
  const inputLimits = {
    admin_after_login: 20,
    advanced_phone_identity: 18,
    students_search: 18,
    staff_management: 30
  };
  const buttonLimits = {
    admin_after_login: 24,
    advanced_phone_identity: 30,
    students_search: 28,
    staff_management: 34
  };
  const countedInputCount = audit.countedInputCount ?? audit.inputs.length;
  const countedButtonCount = audit.countedButtonCount ?? audit.buttons.length;
  if (Object.prototype.hasOwnProperty.call(inputLimits, label) && countedInputCount > inputLimits[label]) {
    throw new Error(`${label} visible input count too high: ${countedInputCount} > ${inputLimits[label]} (ignored data-row inputs: ${audit.ignoredDataRowInputCount || 0})`);
  }
  if (Object.prototype.hasOwnProperty.call(buttonLimits, label) && countedButtonCount > buttonLimits[label]) {
    throw new Error(`${label} visible button count too high: ${countedButtonCount} > ${buttonLimits[label]} (ignored data-row buttons: ${audit.ignoredDataRowButtonCount || 0})`);
  }
  return audit;
}


async function checkedDomAudit(label) {
  try {
    return await domAudit(label);
  } catch (e) {
    fail('DOM audit ' + label, e?.message || String(e));
    await shot('FAILED_DOM_' + label, true);
    return null;
  }
}

async function verifyKioskAdminSurfaceSplit(surface) {
  const result = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0 && r.width > 0 && r.height > 0;
    };
    const visibleText = String(document.body.innerText || '').replace(/\s+/g, ' ');
    const visibleIds = ['kPhoneMid', 'kPhoneLast', 'btnCHECK_IN', 'btnCHECK_OUT', 'btnKioskSettings', 'loginId', 'loginPw', 'btnLogin']
      .filter(id => isVisible(document.getElementById(id)));
    return {
      surface: document.body.dataset.surface || '',
      title: document.title || '',
      visibleText,
      visibleIds,
      kioskLockVisible: isVisible(document.querySelector('[data-kiosk-surface-lock]'))
    };
  });

  if (surface === 'kiosk') {
    if (result.surface !== 'kiosk') throw new Error(`root surface marker is not kiosk: ${result.surface}`);
    if (!result.kioskLockVisible) throw new Error('kiosk surface lock badge is not visible');
    if (/관리자 콘솔|직원 로그인|중앙DB|설정\/점검|학생 관리/.test(result.visibleText)) {
      throw new Error('admin/staff console wording is visible on kiosk root');
    }
    const required = ['kPhoneMid', 'kPhoneLast', 'btnCHECK_IN', 'btnCHECK_OUT', 'btnKioskSettings'];
    const missing = required.filter(id => !result.visibleIds.includes(id));
    if (missing.length) throw new Error('kiosk controls missing after surface split: ' + missing.join(', '));
  }

  if (surface === 'admin') {
    if (result.surface !== 'admin-console') throw new Error(`admin surface marker is not admin-console: ${result.surface}`);
    const leaked = result.visibleIds.filter(id => ['kPhoneMid', 'kPhoneLast', 'btnCHECK_IN', 'btnCHECK_OUT'].includes(id));
    if (leaked.length) throw new Error('kiosk input controls leaked into admin console: ' + leaked.join(', '));
    if (!/오늘의 업무/.test(result.visibleText)) throw new Error('admin console did not land on today work dashboard');
  }
}



async function verifyKioskSettingsTabV26() {
  try {
    await clickIfExists('#btnKioskSettings', 'kiosk settings button', 5000);
    await page.waitForFunction(() => {
      const panel = document.querySelector('#kioskSettingsPanel');
      if (!panel) return false;
      const s = getComputedStyle(panel);
      const r = panel.getBoundingClientRect();
      return panel.classList.contains('show') && s.display !== 'none' && r.width > 0 && r.height > 0;
    }, { timeout: 5000 });

    const result = await page.evaluate(() => {
      const panel = document.querySelector('#kioskSettingsPanel');
      const text = String(panel?.innerText || '').replace(/\s+/g, ' ');
      const has5 = !!document.querySelector('#btnKioskSetFloor5');
      const has7 = !!document.querySelector('#btnKioskSetFloor7');
      const hasPin = !!document.querySelector('#kioskSettingsPin');
      const hasReload = !!document.querySelector('#btnKioskSettingsReload');
      const pinAutofill = !!document.querySelector('#kioskSettingsPin[data-kiosk-pin-autofill="true"]');
      return { text, has5, has7, hasPin, hasReload, pinAutofill };
    });

    if (!result.has5 || !result.has7 || !result.hasPin) {
      throw new Error('kiosk settings missing floor/PIN controls');
    }
    if (!result.pinAutofill) {
      throw new Error('kiosk settings PIN autofill marker missing');
    }
    if (/관리자 콘솔|중앙DB|학생 관리|직원 관리|고급 관리자|실패 알림|미등원 즉시|캐시 비우기|알림톡 payload/.test(result.text)) {
      throw new Error('kiosk settings panel contains admin/runtime-heavy tools: ' + result.text.slice(0, 300));
    }
    if (!/키오스크 설정/.test(result.text) || !/5F로 설정/.test(result.text) || !/7F로 설정/.test(result.text)) {
      throw new Error('kiosk settings panel labels are not clear enough: ' + result.text.slice(0, 300));
    }

    await page.locator('#kPhoneMid').fill('').catch(() => {});
    await page.locator('#kPhoneLast').fill('').catch(() => {});
    const pin = page.locator('#kioskSettingsPin');
    await pin.click({ timeout: 3000 });
    await pin.fill('');
    await page.keyboard.type('1234', { delay: 20 });
    await waitQuiet(300);
    const pinRouting = await page.evaluate(() => {
      const pin = document.querySelector('#kioskSettingsPin');
      const mid = document.querySelector('#kPhoneMid');
      const last = document.querySelector('#kPhoneLast');
      return {
        activeId: document.activeElement && document.activeElement.id,
        pinValue: String(pin && pin.value || ''),
        midValue: String(mid && mid.value || ''),
        lastValue: String(last && last.value || ''),
        marker: document.body.classList.contains('kioskSettingsPinFocusV29')
      };
    });
    if (!pinRouting.marker) {
      throw new Error('kiosk settings PIN focus fix marker missing');
    }
    if (pinRouting.activeId !== 'kioskSettingsPin') {
      throw new Error('kiosk settings PIN lost focus to kiosk input: active=' + pinRouting.activeId);
    }
    if (pinRouting.pinValue !== '1234') {
      throw new Error('kiosk settings PIN typing did not stay in PIN field: pin=' + pinRouting.pinValue);
    }
    if ((pinRouting.midValue + pinRouting.lastValue).replace(/\D/g, '')) {
      throw new Error('kiosk settings PIN digits leaked into phone input: mid=' + pinRouting.midValue + ', last=' + pinRouting.lastValue);
    }
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('#btnKioskSettingsClose').click({ timeout: 1000 }).catch(() => {});
    await page.evaluate(() => {
      const panel = document.querySelector('#kioskSettingsPanel');
      if (panel) {
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden', 'true');
      }
    }).catch(() => {});
    await waitQuiet(250);
  }
}

async function verifyKioskRuntimeSplitV25() {
  const calls = await page.evaluate(() => Array.isArray(window.__THEOREUM_RPC_CALLS__) ? window.__THEOREUM_RPC_CALLS__.slice() : []);
  const markers = await page.evaluate(() => window.__THEOREUM_KIOSK_RUNTIME_SPLIT_V25__ || null).catch(() => null);
  const speedV31 = await page.evaluate(() => window.__THEOREUM_KIOSK_SPEED_V31__ || null).catch(() => null);
  const speedV32 = await page.evaluate(() => window.__THEOREUM_KIOSK_SPEED_V32__ || null).catch(() => null);
  const unifiedV33 = await page.evaluate(() => window.__THEOREUM_UNIFIED_KIOSK_V33__ || null).catch(() => null);
  const unifiedCalls = calls.filter(x => String(x?.op || '') === 'kiosk.unified');
  const legacyKioskCalls = calls.filter(x => String(x?.op || '') === 'kiosk.mark');

  if (
    !markers ||
    markers.kioskUnified !== '/api/kiosk-unified' ||
    markers.kioskSettings !== '/api/kiosk-settings' ||
    markers.kioskMark !== '/api/kiosk-mark' ||
    markers.adminRpc !== '/api/rpc'
  ) {
    throw new Error('kiosk runtime split marker is missing or invalid');
  }
  if (!speedV31 || Number(speedV31.autoSubmitDelayMs || 0) > 20 || speedV31.serverHotPath !== 'indexed-phone-lookup-plus-insert-dedupe') {
    throw new Error('kiosk speed v31 marker is missing or invalid: ' + JSON.stringify(speedV31));
  }
  if (
    !speedV32 ||
    Number(speedV32.autoSubmitDelayMs || 0) > 20 ||
    speedV32.serverHotPath !== 'student-exact-lookup-plus-parallel-state-notify' ||
    speedV32.staffPhoneHotPath !== 'staff-phone-exact-index-first'
  ) {
    throw new Error('kiosk/staff hot path v32 marker is missing or invalid: ' + JSON.stringify(speedV32));
  }
  if (
    !unifiedV33 ||
    unifiedV33.mode !== 'student-staff-one-phone-input' ||
    unifiedV33.endpoint !== '/api/kiosk-unified' ||
    unifiedV33.floorSettingsEndpoint !== '/api/kiosk-settings' ||
    unifiedV33.staffVisibleSeparateLane !== false
  ) {
    throw new Error('unified kiosk v33 marker is missing or invalid: ' + JSON.stringify(unifiedV33));
  }
  if (!unifiedCalls.length) {
    throw new Error('kiosk.unified call was not captured during kiosk QA');
  }
  const bad = unifiedCalls.filter(x => String(x?.endpoint || '') !== '/api/kiosk-unified');
  if (bad.length) {
    throw new Error('kiosk.unified still used the wrong endpoint: ' + JSON.stringify(bad.slice(0, 3)));
  }
  const legacyBad = legacyKioskCalls.filter(x => String(x?.endpoint || '') === '/api/rpc');
  if (legacyBad.length) {
    throw new Error('legacy kiosk.mark used admin RPC endpoint: ' + JSON.stringify(legacyBad.slice(0, 3)));
  }
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
  const speedNote = item.ok && item.ms >= verySlowApiMs
    ? `, SLOW_CRITICAL>${verySlowApiMs}ms`
    : (item.ok && item.ms >= slowApiMs ? `, slow>${slowApiMs}ms` : '');
  if (item.ok) ok(`api ${op}`, `http=${status}, ${item.ms}ms${speedNote}`);
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
  page.on('requestfailed', req => {
    const item = { method: req.method(), url: mask(req.url()), failure: req.failure()?.errorText || '', at: new Date().toISOString() };
    if (isBenignAbortedRequest(req)) ignoredRequests.push(item);
    else failedRequests.push(item);
  });
  page.on('response', res => {
    const status = res.status();
    if (status >= 400) badResponses.push({ status, url: mask(res.url()), at: new Date().toISOString() });
  });

  await step('root page loads', async () => {
    const res = await page.goto(urlOf('/'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || !res.ok()) throw new Error(`GET / failed: ${res?.status()}`);
    await waitQuiet(800);
  });
  await checkedDomAudit('root');
  await step('kiosk/admin surface split: kiosk root', async () => {
    await verifyKioskAdminSurfaceSplit('kiosk');
  }, { screenshot: false });

  await step('kiosk settings minimal tab', async () => {
    await verifyKioskSettingsTabV26();
  }, { screenshot: false });

  await step('kiosk phone input', async () => {
    await clickIfExists('#btnCHECK_IN', 'kiosk check-in button', 2000);
    const mid = page.locator('#kPhoneMid');
    const last = page.locator('#kPhoneLast');
    await mid.waitFor({ state: 'visible', timeout: 5000 });
    await mid.click();

    const focusProbe = qaStudentTail8.slice(0, 7).padEnd(7, '1');
    await page.keyboard.type(focusProbe, { delay: 15 });
    await waitQuiet(250);
    const probeMid = await mid.inputValue().catch(() => '');
    const probeLast = await last.inputValue().catch(() => '');
    const probeActive = await page.evaluate(() => document.activeElement && document.activeElement.id).catch(() => '');
    if ((probeMid + probeLast).replace(/\D/g, '') !== focusProbe) {
      throw new Error(`phone segment typing lost digits before submit: mid=${probeMid}, last=${probeLast}`);
    }
    if (probeActive !== 'kPhoneLast') {
      throw new Error(`phone segment focus did not move to last box: active=${probeActive}`);
    }

    await mid.fill('');
    await last.fill('');
    await mid.click();
    await page.keyboard.type(qaStudentTail8, { delay: 15 });
    await waitQuiet(900);

    await page.waitForFunction(() => {
      const visible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return !!s && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0 && r.width > 0 && r.height > 0;
      };
      const busy = !!window.__THEOREUM_KIOSK_SUBMITTING__ || !!document.querySelector('.actBtn.loading,[aria-busy="true"]') || [...document.querySelectorAll('.modalSpinner, .spinner')].some(visible);
      if (busy) return false;
      const modal = document.querySelector('#fullModal');
      const modalShown = modal && modal.classList.contains('show');
      const modalText = modalShown ? String(modal.innerText || '') : '';
      const msgText = String(document.querySelector('#kMsg')?.innerText || '');
      const dbgText = String(document.querySelector('#kDbg')?.innerText || '');
      return /완료|처리|등록|찾지|문의|중복|입력|실패|오류|이미|새로고침/.test([modalText, msgText, dbgText].join(' '));
    }, { timeout: 12000 }).catch(() => {
      throw new Error('kiosk phone submission did not reach a visible result state within 12s');
    });

    const midVal = await mid.inputValue().catch(() => '');
    const lastVal = await last.inputValue().catch(() => '');
    const visibleDigits = (midVal + lastVal).replace(/\D/g, '');
    const rawDigits = await page.locator('#kInput').inputValue().catch(() => '');
    const submitting = await page.evaluate(() => {
      const visible = el => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return !!s && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0 && r.width > 0 && r.height > 0;
      };
      const visibleSpinner = [...document.querySelectorAll('.modalSpinner, .spinner')].some(visible);
      return !!window.__THEOREUM_KIOSK_SUBMITTING__ || !!document.querySelector('.actBtn.loading,[aria-busy="true"]') || visibleSpinner;
    }).catch(() => false);
    const modalText = await page.locator('#fullModal').innerText({ timeout: 800 }).catch(() => '');

    if (visibleDigits.length < 8 && normalizeTail8(rawDigits).length < 8 && !submitting && !/처리|완료|등록|찾지 못|문의|중복|입력/.test(modalText)) {
      throw new Error(`phone input lost digits: mid=${midVal}, last=${lastVal}, raw=${rawDigits}`);
    }
  });
  await step('kiosk runtime/API split: unified direct endpoint', async () => {
    await verifyKioskRuntimeSplitV25();
  }, { screenshot: false });
  await checkedDomAudit('kiosk_after_phone');

  await step('kiosk unified student/staff phone surface', async () => {
    await page.goto(urlOf('/'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitQuiet(700);
    const info = await page.evaluate(() => {
      const visible = el => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || '1') !== 0 && r.width > 0 && r.height > 0;
      };
      return {
        bodyText: document.body.innerText || '',
        marker: window.__THEOREUM_UNIFIED_KIOSK_V33__ || null,
        laneVisible: visible(document.querySelector('.staffClockLane')),
        hintVisible: visible(document.querySelector('[data-unified-kiosk-v33="true"]')),
        fitMarker: window.__THEOREUM_KIOSK_FIT_V34__ || null,
        fitScale: document.documentElement.getAttribute('data-kiosk-fit-v34') || '',
        cardRect: (() => { const el = document.querySelector('.heroCard'); const r = el ? el.getBoundingClientRect() : null; return r ? { width: r.width, height: r.height } : null; })(),
        inText: document.querySelector('#btnCHECK_IN span')?.textContent || '',
        outText: document.querySelector('#btnCHECK_OUT span')?.textContent || '',
        activeId: document.activeElement?.id || ''
      };
    });

    if (!info.marker || info.marker.mode !== 'student-staff-one-phone-input') {
      throw new Error('unified kiosk marker missing: ' + JSON.stringify(info.marker));
    }
    if (info.laneVisible) throw new Error('separate staff lane is still visible on unified kiosk');
    if (info.hintVisible) throw new Error('bottom unified kiosk helper text is still visible');
    if (!info.fitMarker || info.fitMarker.mode !== 'viewport-fit-no-helper-text') {
      throw new Error('kiosk fit v34 marker missing: ' + JSON.stringify(info.fitMarker));
    }
    const scale = Number(info.fitScale || 0);
    if (!Number.isFinite(scale) || scale < 0.7 || scale > 1.25) {
      throw new Error('kiosk fit v34 scale invalid: ' + JSON.stringify(info));
    }
    if (!info.cardRect || info.cardRect.width < 520 || info.cardRect.height < 360) {
      throw new Error('kiosk fit v34 card size too small: ' + JSON.stringify(info.cardRect));
    }
    if (!/등원\/출근/.test(info.inText) || !/하원\/퇴근/.test(info.outText)) {
      throw new Error('unified action labels are missing: ' + JSON.stringify({ inText: info.inText, outText: info.outText }));
    }
    if (!['kPhoneMid', 'kPhoneLast'].includes(info.activeId)) {
      throw new Error(`unified kiosk did not focus phone segments: active=${info.activeId}`);
    }
  });
  await checkedDomAudit('kiosk_unified_surface');

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
  await checkedDomAudit('admin_after_login');
  await step('kiosk/admin surface split: admin console', async () => {
    await verifyKioskAdminSurfaceSplit('admin');
  }, { screenshot: false });

  await step('admin boot lazy readiness', async () => {
    const boot = await page.evaluate(() => ({
      marker: window.__THEOREUM_ADMIN_BOOT_LAZY_READINESS_V30__ || null,
      calls: Array.isArray(window.__THEOREUM_ADMIN_RPC_CALLS__) ? window.__THEOREUM_ADMIN_RPC_CALLS__.slice() : []
    }));
    if (!boot.marker || boot.marker.finalReadinessAuto !== false || boot.marker.staffCatalogBootLazy !== true) {
      throw new Error('admin boot lazy marker missing or invalid: ' + JSON.stringify(boot.marker));
    }
    const ops = boot.calls.map(x => String(x?.op || ''));
    const heavy = ops.filter(op => op === 'admin.finalReadiness' || op === 'admin.central.staff.list');
    if (heavy.length) {
      throw new Error('admin boot called heavy API before user action: ' + heavy.join(', '));
    }
  }, { screenshot: false });

  await step('admin boot api parity', async () => {
    await apiRpc('meta.supportedOps');
    await apiRpc('auth.me', {});
    const searchBody = await apiRpc('admin.master.searchStudents', { q: qaStudentId || qaStudentQuery, limit: 5 });
    const students = extractStudentsFromSearchPayload(searchBody);
    const resolvedId = qaStudentId || String(students[0]?.student_id || '').trim();
    if (resolvedId) await apiRpc('admin.lectureAssignment.list', { student_id: resolvedId, include_archived: true, limit: 5 });
    else warn('admin lecture assignment list skipped', 'QA student id was not resolved from admin.master.searchStudents');
  }, { screenshot: false });

  if (String(process.env.QA_HEAVY_ADMIN_CHECKS || '').toUpperCase() === '1') {
    await step('admin heavy readiness on demand', async () => {
      await clickNav('advanced');
      const clicked = await clickIfExists('#btnFinalReadiness', 'final readiness button', 5000);
      if (!clicked) throw new Error('final readiness button not visible');
      await page.waitForFunction(() => {
        const text = [document.querySelector('#finalReadinessSummary')?.innerText || '', document.querySelector('#finalReadinessRows')?.innerText || ''].join('\n');
        return /최종 운영 체크|정상|확인 필요|조치 필요/.test(text) && !/자동 실행하지 않습니다|최종 체크를 실행하세요/.test(text);
      }, null, { timeout: 45000 });
    }, { screenshot: false });
  } else {
    ok('admin heavy readiness skipped', 'set QA_HEAVY_ADMIN_CHECKS=1 to run admin.finalReadiness on demand');
  }

  for (const go of ['dashboard', 'students', 'attendance', 'clinic', 'words', 'messages', 'classes', 'reports', 'staff', 'advanced']) {
    await step('admin nav ' + go, async () => {
      await clickNav(go);
    }, { screenshot: false });
  }

  await step('phone identity audit UI', async () => {
    await clickNav('advanced');
    const clicked = await clickIfExists('#btnPhoneIdentityAudit', 'phone identity audit button', 5000);
    if (!clicked) throw new Error('phone identity audit button not visible');
    await page.waitForFunction(() => {
      const summary = document.querySelector('#phoneIdentitySummary');
      const rows = document.querySelector('#phoneIdentityRows');
      const text = [summary?.innerText || '', rows?.innerText || ''].join('\n');
      const state = summary?.dataset?.qaState || '';
      if (state === 'loaded') return true;
      if (/휴대폰 출결 준비도/.test(text) && !/점검 전입니다|점검 중입니다/.test(text)) return true;
      if (/수정 필요한 휴대폰 출결 문제가 없습니다|수정 필요|확인 권장/.test(text) && !/점검 중입니다/.test(text)) return true;
      return false;
    }, null, { timeout: 40000 }).catch(async () => {
      const text = await page.locator('#phoneIdentitySummary, #phoneIdentityRows').evaluateAll(els => els.map(e => e.innerText).join('\n')).catch(() => '');
      throw new Error('phone identity UI did not update: ' + text.replace(/\s+/g, ' ').slice(0, 300));
    });
  });
  await step('phone identity issue table stays scrollable', async () => {
    const info = await page.evaluate(() => {
      const wrap = document.querySelector('.phoneIdentityTableWrap');
      if (!wrap) return { ok: false, reason: 'phoneIdentityTableWrap missing' };
      const style = getComputedStyle(wrap);
      const rect = wrap.getBoundingClientRect();
      const rows = document.querySelectorAll('#phoneIdentityRows tr').length;
      const maxHeight = style.maxHeight || '';
      return {
        ok: /px/.test(maxHeight) && rect.height <= 620,
        rectHeight: Math.round(rect.height),
        maxHeight,
        rows
      };
    });
    if (!info.ok) throw new Error(`phone identity issue table is not scroll-contained: ${JSON.stringify(info)}`);
  }, { screenshot: false });
  await checkedDomAudit('advanced_phone_identity');

  await step('staff management UI', async () => {
    await clickNav('staff');
    await clickIfExists('#btnCentralLoadStaff', 'load central staff', 5000);
    await waitQuiet(1800);
    const phoneInputVisible = await page.locator('#centralStaffPhone').isVisible().catch(() => false);
    if (!phoneInputVisible) throw new Error('centralStaffPhone input is not visible');
  });
  await step('staff phone continuous typing', async () => {
    const phone = page.locator('#centralStaffPhone');
    await phone.click({ clickCount: 3 });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await phone.type('01055556666', { delay: 25 });
    const value = await phone.inputValue();
    const activeId = await page.evaluate(() => document.activeElement?.id || '');
    if (value !== '01055556666') throw new Error(`centralStaffPhone lost digits while typing: ${value}`);
    if (activeId !== 'centralStaffPhone') throw new Error(`centralStaffPhone lost focus while typing: active=${activeId}`);
  });
  await checkedDomAudit('staff_management');

  await step('student search and link area UI', async () => {
    await clickNav('students');
    await fillIfExists('#studentQuery', qaStudentQuery, 'student query', 5000);
    const clickedTopSearch = await clickIfExists('#btnStudentSearchNow', 'student search button', 5000);
    if (!clickedTopSearch) await page.keyboard.press('Enter').catch(() => {});
    await waitQuiet(2500);
    const body = await page.locator('body').innerText({ timeout: 3000 });
    if (!body.includes('학생 오늘 링크') || !body.includes('온라인강의 배정')) {
      throw new Error('student link or lecture area is not visible');
    }
  });
  if (writeMode) {
    await step('student link admin copy controls', async () => {
      await page.evaluate(() => {
        document.querySelector('#drawerOverlay')?.classList.remove('on');
        document.querySelector('#workDrawer')?.classList.remove('on');
      }).catch(() => {});
      const firstStudent = page.locator('#studentResults [data-student-open]').first();
      if (await firstStudent.count() === 0) throw new Error('student search returned no clickable student rows');
      await firstStudent.click({ timeout: 8000 });
      await waitQuiet(1200);

      await page.evaluate(async () => {
        if (typeof window.createStudentTodayLink === 'function') {
          await window.createStudentTodayLink();
        } else {
          const btn = document.querySelector('#btnStudentTodayLinkOneClick');
          if (!btn) throw new Error('student today link button not found');
          btn.click();
        }
      }).catch(async () => {
        const btn = page.locator('#btnStudentTodayLinkOneClick');
        await btn.click({ timeout: 5000 });
      });

      await page.locator('#btnCopyStudentTodayLink').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#btnCopyStudentTodayMessage').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#btnOpenStudentTodayLink').waitFor({ state: 'visible', timeout: 15000 });

      const boxText = await page.locator('#studentTodayLinkBox').innerText({ timeout: 5000 });
      if (!/https?:\/\//.test(boxText)) throw new Error('student today link URL was not rendered in admin copy box');
      if (!/학부모|오늘 학습 확인 링크/.test(boxText)) throw new Error('parent share message was not rendered');
    });
  }

  await page.evaluate(() => {
    document.querySelector('#drawerOverlay')?.classList.remove('on');
    document.querySelector('#workDrawer')?.classList.remove('on');
  }).catch(() => {});
  await waitQuiet(250);
  await checkedDomAudit('students_search');

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
          await page.waitForFunction(() => {
            const state = document.body?.dataset?.qaState || '';
            const rootState = document.querySelector('#studentTodayRoot')?.dataset?.qaState || '';
            return ['loaded', 'error'].includes(state) || ['loaded', 'error'].includes(rootState);
          }, null, { timeout: 18000 }).catch(() => {
            throw new Error('student today public link stayed in loading state for more than 18s');
          });
          const state = await page.evaluate(() => document.body?.dataset?.qaState || document.querySelector('#studentTodayRoot')?.dataset?.qaState || '');
          const body = await page.locator('body').innerText({ timeout: 5000 });
          if (state !== 'loaded') throw new Error(`student today page finished with state=${state}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
          if (/불러오는 중입니다|잠시만 기다려 주세요/.test(body)) throw new Error('student today page still shows loading copy after loaded state');
          if (!/온라인강의|오늘/.test(body)) throw new Error('student today page did not render expected text');
        });
        await checkedDomAudit('student_today_public');
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
      let json = null;
      try { json = JSON.parse(body || '{}'); } catch (_) {}
      const perf = json?.data?.perf || {};
      if (perf.path !== 'staff_phone_exact_index_v32') {
        throw new Error('staff.clock did not use v32 exact-index phone path: ' + JSON.stringify(perf));
      }
    }, { screenshot: false });
  } else if (qaStaffTail8) {
    warn('staff clock write skipped', 'Run npm run prod:qa:deep:write to perform staff phone clock test.');
  }

  await step('student-today static page exists', async () => {
    const res = await page.goto(urlOf('/student-today.html'), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!res || !res.ok()) throw new Error(`GET /student-today.html failed: ${res?.status()}`);
  });
  await checkedDomAudit('student_today_static');
}

function buildReportLines(bundleResult = null, sourceResult = null, packageResult = null) {
  const failedCount = stepFailed;
  const warnCount = stepWarned + consoleEvents.length + pageErrors.length + failedRequests.length + badResponses.length;
  return [
    '# TheOreum Production Deep Click QA Report',
    '',
    `- Base URL: ${baseUrl}`,
    `- Mode: ${writeMode ? 'write-enabled deep QA' : 'read-only deep QA'}`,
    `- Browser: ${headless ? 'headless' : 'headed'}`,
    `- Generated at: ${new Date().toISOString()}`,
    `- Failed: ${failedCount}`,
    `- Warnings/Signals: ${warnCount}`,
    `- Screenshot dir: ${runDir}`,
    `- Screenshot bundle: ${runBundlePath}`,
    `- Latest screenshot bundle alias: ${latestBundlePath}`,
    '',
    '## What this checked',
    '- Real browser page load',
    '- Kiosk phone input',
    '- Unified student/staff kiosk phone surface',
    '- Kiosk/admin surface split guard',
    '- Kiosk runtime/API split guard',
    '- Kiosk/staff hot path v32 guard',
    '- Unified student/staff kiosk v33 guard',
    '- Kiosk viewport fit/no-bottom-helper v34 guard',
    '- Today task processing state v35 guard',
    '- Today task compact state menu v36 guard',
    '- Today workflow filter/completion v37 guard',
    '- Today dashboard cleanup/staff-list fast v38 guard',
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
    `- Ignored benign aborted requests: ${ignoredRequests.length}`,
    `- HTTP 400/500 responses: ${badResponses.length}`,
    '',
    '## Screenshots',
    ...screenshots.map(s => `- ${s.label}: ${s.path}`),
    '',
    '## Screenshot bundle',
    `- Timestamped zip: ${runBundlePath}`,
    `- Latest alias: ${latestBundlePath}`,
    bundleResult ? `- Bundle status: ${bundleResult.ok ? 'OK' : 'WARN'}${bundleResult.reason ? ` — ${bundleResult.reason}` : ''}` : '- Bundle status: pending',
    '',
    '## Source/code snapshot',
    `- Timestamped source zip: ${runSourcePath}`,
    `- Latest source alias: ${latestSourcePath}`,
    sourceResult ? `- Source snapshot status: ${sourceResult.ok ? 'OK' : 'WARN'}${sourceResult.reason ? ` — ${sourceResult.reason}` : ''}` : '- Source snapshot status: pending',
    sourceResult?.ok && Number.isFinite(sourceResult.includedFiles) ? `- Source included files: ${sourceResult.includedFiles}` : '',
    sourceResult?.ok && Number.isFinite(sourceResult.includedBytes) ? `- Source included bytes: ${sourceResult.includedBytes}` : '',
    sourceResult?.ok && Number.isFinite(sourceResult.skippedDirs) ? `- Source skipped directories: ${sourceResult.skippedDirs}` : '',
    '',
    '## Full QA package',
    `- Timestamped package zip: ${runPackagePath}`,
    `- Latest package alias: ${latestPackagePath}`,
    packageResult ? `- Package status: ${packageResult.ok ? 'OK' : 'WARN'}${packageResult.reason ? ` — ${packageResult.reason}` : ''}` : '- Package status: pending',
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
    '## Ignored benign aborted requests',
    ...(ignoredRequests.length ? ignoredRequests.slice(0, 80).map(e => `- ${e.method} ${e.url} — ${e.failure}`) : ['- none']),
    '',
    '## Bad HTTP responses',
    ...(badResponses.length ? badResponses.slice(0, 100).map(e => `- HTTP ${e.status} ${e.url}`) : ['- none']),
    '',
    '## API results',
    ...(apiResults.length ? apiResults.map(e => `- ${e.ok ? 'OK' : 'FAIL'} ${e.op} — http=${e.httpStatus}, ${e.ms}ms${e.error ? `, code=${e.error.code || ''}, msg=${mask(e.error.message || '')}` : ''}`) : ['- none']),
    '',
    '## Practical performance notes',
    ...(apiResults.filter(e => e.ok && e.ms >= slowApiMs).length
      ? apiResults
          .filter(e => e.ok && e.ms >= slowApiMs)
          .sort((a, b) => b.ms - a.ms)
          .map(e => `- ${e.ms >= verySlowApiMs ? 'CRITICAL ' : ''}${e.op}: ${e.ms}ms`)
      : ['- none'])
  ];
}

function writeRunDirCompanionFiles(bundleResult = null, sourceResult = null, packageResult = null) {
  const readme = [
    'TheOreum Production Deep QA screenshot bundle',
    `Generated: ${new Date().toISOString()}`,
    `Run ID: ${runId}`,
    `Base URL: ${baseUrl}`,
    '',
    'Open PRODUCTION_DEEP_QA_TO_SEND.txt first.',
    'PNG files are captured Playwright page screenshots.',
    '*_dom.json files are DOM audits for debugging.',
    '',
    'Screenshot capture note:',
    '- QA uses Playwright page.screenshot, so it captures the browser page DOM, not your entire Windows desktop.',
    '- Other apps/windows on your monitor are not captured in these PNG files.',
    '- Do not touch the QA browser while the runner is typing/clicking, because keyboard/mouse focus can affect the test flow.'
  ].join('\r\n');
  writeFileSync(join(runDir, 'README_SCREENSHOTS.txt'), readme, 'utf8');

  const raw = JSON.stringify({
    baseUrl,
    writeMode,
    headless,
    runId,
    runDir,
    runBundlePath,
    latestBundlePath,
    runSourcePath,
    latestSourcePath,
    runPackagePath,
    latestPackagePath,
    results,
    consoleEvents,
    pageErrors,
    failedRequests,
    ignoredRequests,
    badResponses,
    screenshots,
    screenshotBundle: bundleResult,
    sourceSnapshot: sourceResult,
    fullQaPackage: packageResult,
    apiResults
  }, null, 2);
  writeFileSync(rawJsonPath, raw, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_RAW.json'), raw, 'utf8');
}

function writeReports() {
  // First pass: write complete report/copy/raw into both _logs and the run folder.
  // Then create timestamped screenshot/source/package zips. Then write the final report again
  // so the report itself includes exact zip paths.
  writeRunDirCompanionFiles(null, null, null);
  let report = buildReportLines(null, null, null).join('\n');
  writeFileSync(reportPath, report, 'utf8');
  writeFileSync(copyPath, ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n'), 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_REPORT.md'), report, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_TO_SEND.txt'), ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n'), 'utf8');
  writeFileSync(lastDirPath, runDir, 'utf8');

  const bundleResult = createScreenshotBundle();
  if (!bundleResult.ok) {
    stepWarned += 1;
    results.push({ status: 'WARN', label: 'screenshot bundle failed', detail: mask(bundleResult.reason || 'unknown'), at: new Date().toISOString() });
  } else {
    results.push({ status: 'OK', label: 'screenshot bundle created', detail: mask(bundleResult.path || runBundlePath), at: new Date().toISOString() });
  }

  const sourceResult = createSourceSnapshot();
  if (!sourceResult.ok) {
    stepWarned += 1;
    results.push({ status: 'WARN', label: 'source snapshot failed', detail: mask(sourceResult.reason || 'unknown'), at: new Date().toISOString() });
  } else {
    results.push({ status: 'OK', label: 'source snapshot created', detail: mask(sourceResult.path || runSourcePath), at: new Date().toISOString() });
  }

  writeRunDirCompanionFiles(bundleResult, sourceResult, null);
  report = buildReportLines(bundleResult, sourceResult, null).join('\n');
  let copyBlock = ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  writeFileSync(copyPath, copyBlock, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_REPORT.md'), report, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_TO_SEND.txt'), copyBlock, 'utf8');

  // Recreate screenshot bundle so it contains the final report/copy block.
  const finalBundleResult = createScreenshotBundle();
  const effectiveBundleResult = finalBundleResult.ok ? finalBundleResult : bundleResult;

  const packageResult = createFullQaPackage();
  if (!packageResult.ok) {
    stepWarned += 1;
    results.push({ status: 'WARN', label: 'full QA package failed', detail: mask(packageResult.reason || 'unknown'), at: new Date().toISOString() });
  } else {
    results.push({ status: 'OK', label: 'full QA package created', detail: mask(packageResult.path || runPackagePath), at: new Date().toISOString() });
  }

  writeRunDirCompanionFiles(effectiveBundleResult, sourceResult, packageResult);
  report = buildReportLines(effectiveBundleResult, sourceResult, packageResult).join('\n');
  copyBlock = ['=== COPY FROM HERE ===', report, '=== COPY TO HERE ==='].join('\n');
  writeFileSync(reportPath, report, 'utf8');
  writeFileSync(copyPath, copyBlock, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_REPORT.md'), report, 'utf8');
  writeFileSync(join(runDir, 'PRODUCTION_DEEP_QA_TO_SEND.txt'), copyBlock, 'utf8');

  // Recreate full package one more time so it contains the final copy block.
  createFullQaPackage();

  console.log('\nReport:', reportPath);
  console.log('Copy block:', copyPath);
  console.log('Screenshots:', runDir);
  console.log('Timestamped screenshot bundle:', runBundlePath);
  console.log('Latest screenshot bundle alias:', latestBundlePath);
  console.log('Timestamped source snapshot:', runSourcePath);
  console.log('Timestamped full QA package:', runPackagePath);
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
