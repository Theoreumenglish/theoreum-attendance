import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = file => readFileSync(join(root, file), 'utf8');
const files = {
  rpc: 'api/rpc.js',
  admin: 'public/admin.html',
  index: 'index.html',
  absentCron: 'api/absent-run-cron.js',
  notifyWorker: 'api/attendance-notify-worker.js',
  vercel: 'vercel.json',
  clinicWordSchema: 'docs/supabase-clinic-word-report-schema-v1.sql'
};

let failed = 0;
function ok(message) {
  console.log('OK', message);
}
function fail(message) {
  failed += 1;
  console.error('FAIL', message);
}
function uniq(values) {
  return Array.from(new Set(values)).sort();
}
function collect(re, text, group = 1) {
  const out = [];
  for (const match of text.matchAll(re)) out.push(match[group]);
  return out;
}

for (const file of Object.values(files)) {
  if (!existsSync(join(root, file))) {
    fail(`${file} 파일이 없습니다.`);
  }
}

const rpcText = read(files.rpc);
const adminText = read(files.admin);
const indexText = read(files.index);
const absentCronText = read(files.absentCron);
const notifyWorkerText = read(files.notifyWorker);
const vercelText = read(files.vercel);
const uiText = `${adminText}\n${indexText}`;

const handledOps = uniq(collect(/\bop\s*={2,3}\s*['"]([^'"]+)['"]/g, rpcText));
const uiOps = uniq([
  ...collect(/\b(?:App\.)?rpc\s*\(\s*['"]([^'"]+)['"]/g, uiText),
  ...collect(/\bop\s*:\s*['"]([^'"]+)['"]/g, uiText)
]);

const missingOps = uiOps.filter(op => !handledOps.includes(op));
if (missingOps.length) {
  fail(`UI 호출 op가 api/rpc.js에서 처리되지 않습니다: ${missingOps.join(', ')}`);
} else {
  ok(`UI 호출 op ${uiOps.length}개가 api/rpc.js에 모두 존재합니다.`);
}

const importedNames = new Set();
for (const match of rpcText.matchAll(/import\s+\{([\s\S]*?)\}\s+from\s+['"][^'"]+['"]/g)) {
  for (const part of match[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/).pop().trim();
    if (name) importedNames.add(name);
  }
}
for (const match of rpcText.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g)) {
  importedNames.add(match[1]);
}

const localNames = new Set([
  ...collect(/\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g, rpcText),
  ...collect(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g, rpcText),
  ...collect(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, rpcText)
]);

const directCalls = uniq(collect(/\bawait\s+([A-Za-z_$][\w$]*Direct)\s*\(/g, rpcText));
const missingDirects = directCalls.filter(name => !localNames.has(name) && !importedNames.has(name));
if (missingDirects.length) {
  fail(`Direct 호출 함수 정의/import 누락: ${missingDirects.join(', ')}`);
} else {
  ok(`Direct 호출 함수 ${directCalls.length}개가 모두 정의 또는 import되어 있습니다.`);
}

const viewIds = new Set();
for (const match of adminText.matchAll(/<section\b[^>]*>/g)) {
  const tag = match[0];
  if (!/\bclass=["'][^"']*portalView/.test(tag)) continue;
  const idMatch = tag.match(/\bid=["']([^"']+)["']/);
  if (idMatch) viewIds.add(idMatch[1]);
}
const navTargets = uniq(collect(/\bdata-go(?:-link)?=["']([^"']+)["']/g, adminText));
const missingTargets = navTargets.filter(id => !viewIds.has(id));
if (missingTargets.length) {
  fail(`admin.html data-go 대상 section 누락: ${missingTargets.join(', ')}`);
} else {
  ok(`admin.html data-go 대상 ${navTargets.length}개가 모두 section으로 존재합니다.`);
}

const adminIds = collect(/\bid=["']([^"']+)["']/g, adminText);
const duplicateAdminIds = uniq(adminIds.filter((id, idx) => adminIds.indexOf(id) !== idx));
if (duplicateAdminIds.length) {
  fail(`admin.html 중복 id가 있습니다: ${duplicateAdminIds.join(', ')}`);
} else {
  ok(`admin.html id ${adminIds.length}개가 중복 없이 구성되어 있습니다.`);
}

const attendanceTable = adminText.match(/<tbody\s+id=["']attendanceLogRows["'][\s\S]*?<\/tbody>/);
const attendanceHeader = adminText.match(/<section\s+class=["']portalView["']\s+id=["']attendance["'][\s\S]*?<thead>([\s\S]*?)<\/thead>/);
if (!attendanceHeader) {
  fail('출결 로그 테이블 thead를 찾지 못했습니다.');
} else {
  const headerCount = collect(/<th\b/g, attendanceHeader[1], 0).length;
  if (headerCount !== 8) {
    fail(`출결 로그 테이블 헤더는 8칸이어야 합니다. 현재 ${headerCount}칸입니다.`);
  } else {
    ok('출결 로그 테이블 헤더가 8칸입니다.');
  }
}
if (!attendanceTable) {
  fail('attendanceLogRows tbody를 찾지 못했습니다.');
} else if (!/colspan=["']8["']/.test(attendanceTable[0])) {
  fail('attendanceLogRows 초기 빈 행 colspan이 8이 아닙니다.');
} else {
  ok('attendanceLogRows 초기 빈 행 colspan이 8입니다.');
}


const requiredAdminIds = [
  'statAbsenceCron',
  'statWorkerCron',
  'btnAbsenceRuns',
  'btnWorkerRuns',
  'btnLoadClasses',
  'classRows',
  'classRosterRows',
  'studentProfileLogRows',
  'studentProfileClassRows',
  'studentProfileExcuseRows',
  'notifyQueueRows',
  'btnLoadNotifyQueue',
  'btnRetryNotifyQueue',
  'staffMonthlyRows',
  'staffDailyRows',
  'btnLoadStaffMonthly',
  'studentProfileClinicRows',
  'studentProfileWordRows',
  'clinicStudentLabel',
  'clinicTitle',
  'clinicTaskRows',
  'btnCreateClinicTask',
  'btnLoadClinicTasks',
  'wordSessionTitle',
  'wordSessionRows',
  'wordResultSessionId',
  'wordResultStudentId',
  'btnCreateWordSession',
  'btnListWordSessions',
  'btnEnterWordResult',
  'wordResultBox'
];
const missingAdminIds = requiredAdminIds.filter(id => !adminText.includes(`id="${id}"`) && !adminText.includes(`id='${id}'`));
if (missingAdminIds.length) {
  fail(`admin.html 운영 관측성/클래스 필수 id 누락: ${missingAdminIds.join(', ')}`);
} else {
  ok(`admin.html 운영 관측성/클래스 필수 id ${requiredAdminIds.length}개가 모두 존재합니다.`);
}

const requiredOneClickIds = [
  'quickDock',
  'quickSelectedStudentText',
  'quickStudentQuery',
  'btnQuickStudentSearch',
  'btnPulseCheck',
  'btnCommandPulse',
  'btnCommandAbsent',
  'btnCommandClinic',
  'btnCommandWord',
  'quickActionLog',
  'studentOneClickBar',
  'btnStudentLogsOneClick',
  'btnStudentClinicOneClick',
  'btnStudentWordOneClick'
];
const missingOneClickIds = requiredOneClickIds.filter(id => !adminText.includes(`id="${id}"`) && !adminText.includes(`id='${id}'`));
if (missingOneClickIds.length) {
  fail(`admin.html 원클릭 업무 UI id 누락: ${missingOneClickIds.join(', ')}`);
} else {
  ok(`admin.html 원클릭 업무 UI id ${requiredOneClickIds.length}개가 모두 존재합니다.`);
}

const requiredOneClickFunctions = [
  'runTodayPulse',
  'quickStudentSearch',
  'quickStudentLogs',
  'createQuickClinicTask',
  'quickSaveWordScore',
  'applyNotifyFilter',
  'applyClinicFilter'
];
const missingOneClickFunctions = requiredOneClickFunctions.filter(name => !adminText.includes(`function ${name}`) && !adminText.includes(`async function ${name}`));
if (missingOneClickFunctions.length) {
  fail(`admin.html 원클릭 업무 함수 누락: ${missingOneClickFunctions.join(', ')}`);
} else {
  ok(`admin.html 원클릭 업무 함수 ${requiredOneClickFunctions.length}개가 모두 존재합니다.`);
}

const requiredAdminOps = [
  'admin.listAbsenceRuns',
  'admin.listNotifyWorkerRuns',
  'assistant.listClassOptions',
  'assistant.listClassRoster',
  'assistant.getStudentProfile',
  'admin.getStaffMonthlySummary',
  'admin.getStaffDailyDetail',
  'admin.listNotifyQueue',
  'admin.retryNotifyQueue',
  'clinic.listTasks',
  'clinic.createTask',
  'clinic.updateTaskStatus',
  'wordTest.listSessions',
  'wordTest.createSession',
  'wordTest.enterResult'
];
const missingAdminOps = requiredAdminOps.filter(op => !uiOps.includes(op));
if (missingAdminOps.length) {
  fail(`admin.html 운영 관측성/클래스 필수 RPC 호출 누락: ${missingAdminOps.join(', ')}`);
} else {
  ok(`admin.html 운영 관측성/클래스 필수 RPC ${requiredAdminOps.length}개가 모두 호출됩니다.`);
}


if (!rpcText.includes("op === 'assistant.getStudentProfile'") || !rpcText.includes('assistantGetStudentProfileDirect')) {
  fail('assistant.getStudentProfile op 또는 assistantGetStudentProfileDirect 함수가 누락되었습니다.');
} else {
  ok('assistant.getStudentProfile 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'clinic.listTasks'") || !rpcText.includes('clinicListTasksDirect')) {
  fail('clinic.listTasks op 또는 clinicListTasksDirect 함수가 누락되었습니다.');
} else {
  ok('clinic.listTasks 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'wordTest.enterResult'") || !rpcText.includes('wordTestEnterResultDirect')) {
  fail('wordTest.enterResult op 또는 wordTestEnterResultDirect 함수가 누락되었습니다.');
} else {
  ok('wordTest.enterResult 서버 op가 존재합니다.');
}

const schemaText = read(files.clinicWordSchema);
const requiredSchemaTables = [
  'clinic_tasks',
  'clinic_logs',
  'word_test_sessions',
  'word_test_results',
  'portal_audit_logs',
  'report_snapshots',
  'report_links'
];
const missingSchemaTables = requiredSchemaTables.filter(name => !schemaText.includes(`create table if not exists public.${name}`));
if (missingSchemaTables.length) {
  fail(`clinic-word-report schema 테이블 누락: ${missingSchemaTables.join(', ')}`);
} else {
  ok(`clinic-word-report schema 필수 테이블 ${requiredSchemaTables.length}개가 모두 있습니다.`);
}

if (absentCronText.includes('attendance-notify-queue.js') || absentCronText.includes('runAttendanceNotifyWorker')) {
  fail('absent-run-cron은 미등원 감지만 수행해야 합니다. 알림 worker 호출/import가 포함되어 있습니다.');
} else {
  ok('absent-run-cron이 detection-only로 분리되어 있습니다.');
}

if (!notifyWorkerText.includes('runAttendanceNotifyWorker')) {
  fail('attendance-notify-worker가 runAttendanceNotifyWorker를 호출하지 않습니다.');
} else {
  ok('attendance-notify-worker가 queue 발송 전용 worker를 호출합니다.');
}

try {
  const vercel = JSON.parse(vercelText);
  const cronPaths = new Set((vercel.crons || []).map(item => item.path));
  const requiredCronPaths = ['/api/absent-run-cron', '/api/attendance-notify-worker'];
  const missingCronPaths = requiredCronPaths.filter(item => !cronPaths.has(item));
  if (missingCronPaths.length) {
    fail('vercel.json cron path 누락: ' + missingCronPaths.join(', '));
  } else {
    ok('vercel.json에 detection cron과 worker cron이 모두 있습니다.');
  }
} catch (e) {
  fail('vercel.json 파싱 실패: ' + (e?.message || e));
}

if (failed > 0) {
  console.error('');
  console.error(`Contract check failed: ${failed} issue(s)`);
  process.exit(1);
}

console.log('');
console.log('Contract check passed.');
