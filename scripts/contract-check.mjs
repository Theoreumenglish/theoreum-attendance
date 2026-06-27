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
  clinicWordSchema: 'docs/supabase-clinic-word-report-schema-v1.sql',
  clinicAutoNotifySchema: 'docs/supabase-clinic-auto-notify-v1.sql',
  wordCatalogSchema: 'docs/supabase-word-catalog-v1.sql',
  studentWordRecordsSchema: 'docs/supabase-student-word-records-v1.sql'
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
const notifyText = read('lib/attendance-notify.js');
const adminText = read(files.admin);
const indexText = read(files.index);
const absentCronText = read(files.absentCron);
const notifyWorkerText = read(files.notifyWorker);
const vercelText = read(files.vercel);
const smokeText = read('scripts/smoke-test.mjs');
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
const attendanceHeader = adminText.match(/<section\b(?=[^>]*\bid=["']attendance["'])(?=[^>]*\bclass=["'][^"']*portalView)[\s\S]*?<thead>([\s\S]*?)<\/thead>/);
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
  'btnStaffManualSave',
  'btnStaffManualLoadLogs',
  'btnStaffManualClear',
  'staffManualStaffId',
  'staffManualYmd',
  'staffManualTime',
  'staffManualAction',
  'staffManualTraceId',
  'staffManualLogRows',
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
  'wordResultBox',
  'wordBulkSessionId',
  'wordBulkClassId',
  'btnLoadWordBulk',
  'btnSaveWordBulk',
  'wordBulkRows',
  'wordBulkSummary',
  'btnLoadWordResults',
  'wordResultsRows',
  'wordResultsSummary',
  'reportStudentLabel',
  'reportStartYmd',
  'reportEndYmd',
  'btnPreviewReport',
  'btnSaveReportSnapshot',
  'reportMetricAttendance',
  'reportMetricWordAvg',
  'reportMetricClinic',
  'reportWordRows',
  'reportClinicRows',
  'reportPreviewBox',
  'btnListReportSnapshots',
  'reportSnapshotRows',
  'reportSnapshotSummary',
  'auditOpFilter',
  'auditTargetTypeFilter',
  'auditActorFilter',
  'btnLoadAuditLogs',
  'auditLogRows',
  'wordStartYmd',
  'wordEndYmd',
  'wordBulkLiveSummary',
  'reportParentTextBox'
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
  'quickStudentClinicView',
  'quickStudentWordInput'
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
  'wordCatalog.list',
  'wordTest.listSessions',
  'wordTest.createSession',
  'wordTest.enterResult',
  'wordTest.bulkEntry',
  'wordTest.bulkEnterResults',
  'wordTest.listResults',
  'report.previewStudentReport',
  'report.createSnapshot',
  'report.listSnapshots',
  'audit.searchLogs',
  'clinic.queueNotice'
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

if (!rpcText.includes("op === 'wordCatalog.list'") || !rpcText.includes('wordCatalogListDirect')) {
  fail('wordCatalog.list op 또는 wordCatalogListDirect 함수가 누락되었습니다.');
} else {
  ok('wordCatalog.list 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'wordRecord.list'") || !rpcText.includes('wordRecordListDirect')) {
  fail('wordRecord.list op 또는 wordRecordListDirect 함수가 누락되었습니다.');
} else {
  ok('wordRecord.list 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'wordTest.enterResult'") || !rpcText.includes('wordTestEnterResultDirect')) {
  fail('wordTest.enterResult op 또는 wordTestEnterResultDirect 함수가 누락되었습니다.');
} else {
  ok('wordTest.enterResult 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'clinic.queueNotice'") || !rpcText.includes('clinicQueueNoticeDirect')) {
  fail('clinic.queueNotice op 또는 clinicQueueNoticeDirect 함수가 누락되었습니다.');
} else {
  ok('clinic.queueNotice 서버 op가 존재합니다.');
}
if (!rpcText.includes("op === 'clinic.queueParentNotice'") || !rpcText.includes('clinicQueueParentNoticeDirect')) {
  fail('clinic.queueParentNotice 호환 op 또는 clinicQueueParentNoticeDirect 함수가 누락되었습니다.');
} else {
  ok('clinic.queueParentNotice 호환 서버 op가 존재합니다.');
}


if (!rpcText.includes("op === 'wordTest.bulkEntry'") || !rpcText.includes('wordTestBulkEntryDirect')) {
  fail('wordTest.bulkEntry op 또는 wordTestBulkEntryDirect 함수가 누락되었습니다.');
} else {
  ok('wordTest.bulkEntry 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'wordTest.bulkEnterResults'") || !rpcText.includes('wordTestBulkEnterResultsDirect')) {
  fail('wordTest.bulkEnterResults op 또는 wordTestBulkEnterResultsDirect 함수가 누락되었습니다.');
} else {
  ok('wordTest.bulkEnterResults 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'wordTest.listResults'") || !rpcText.includes('wordTestListResultsDirect')) {
  fail('wordTest.listResults op 또는 wordTestListResultsDirect 함수가 누락되었습니다.');
} else {
  ok('wordTest.listResults 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'report.previewStudentReport'") || !rpcText.includes('reportPreviewStudentReportDirect')) {
  fail('report.previewStudentReport op 또는 reportPreviewStudentReportDirect 함수가 누락되었습니다.');
} else {
  ok('report.previewStudentReport 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'report.createSnapshot'") || !rpcText.includes('reportCreateSnapshotDirect')) {
  fail('report.createSnapshot op 또는 reportCreateSnapshotDirect 함수가 누락되었습니다.');
} else {
  ok('report.createSnapshot 서버 op가 존재합니다.');
}

if (!rpcText.includes("op === 'report.listSnapshots'") || !rpcText.includes('reportListSnapshotsDirect')) {
  fail('report.listSnapshots op 또는 reportListSnapshotsDirect 함수가 누락되었습니다.');
} else {
  ok('report.listSnapshots 서버 op가 존재합니다.');
}

const wordCatalogSchemaText = read(files.wordCatalogSchema);
const requiredWordCatalogTables = ['word_books', 'word_book_ranges'];
const missingWordCatalogTables = requiredWordCatalogTables.filter(name => !wordCatalogSchemaText.includes(`create table if not exists public.${name}`));
if (missingWordCatalogTables.length) {
  fail(`word catalog schema 테이블 누락: ${missingWordCatalogTables.join(', ')}`);
} else {
  ok(`word catalog schema 필수 테이블 ${requiredWordCatalogTables.length}개가 모두 있습니다.`);
}

const studentWordRecordsSchemaText = read(files.studentWordRecordsSchema);
const requiredStudentWordRecordTables = ['word_records'];
const missingStudentWordRecordTables = requiredStudentWordRecordTables.filter(name => !studentWordRecordsSchemaText.includes(`create table if not exists public.${name}`));
if (missingStudentWordRecordTables.length) {
  fail(`student word records schema 테이블 누락: ${missingStudentWordRecordTables.join(', ')}`);
} else {
  ok(`student word records schema 필수 테이블 ${requiredStudentWordRecordTables.length}개가 모두 있습니다.`);
}

if (!studentWordRecordsSchemaText.includes('word_needs_retest') || !studentWordRecordsSchemaText.includes('word_needs_clinic')) {
  fail('student word records schema에 재시험/클리닉 후보 컬럼이 없습니다.');
} else {
  ok('student word records schema에 재시험/클리닉 후보 컬럼이 있습니다.');
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


const canonicalClinicOptions = ['CLASS_CLINIC', 'EXTRA_CLINIC', 'INDIVIDUAL_CLINIC'];
const visibleAdmin = adminText.split('<script>')[0];
const clinicSection = (adminText.match(/<section\b(?=[^>]*\bid=["']clinic["'])[\s\S]*?(?=<section\b|<script>|<\/main>)/i) || [''])[0];
const missingClinicOptions = canonicalClinicOptions.filter(v => !visibleAdmin.includes(`value="${v}"`) && !visibleAdmin.includes(`value='${v}'`));
if (missingClinicOptions.length) {
  fail(`클리닉 3종 선택지가 누락되었습니다: ${missingClinicOptions.join(', ')}`);
} else {
  ok('클리닉 유형은 수업/추가/개별 3종으로 노출됩니다.');
}
const legacyClinicOptions = ['GENERAL', 'WORD', 'GRAMMAR', 'READING', 'WRITING', 'ATTENDANCE', 'HOMEWORK', 'MAKEUP']
  .filter(v => clinicSection.includes(`value="${v}"`) || clinicSection.includes(`value='${v}'`));
if (legacyClinicOptions.length) {
  fail(`화면에 구형 클리닉 유형 값이 남아 있습니다: ${legacyClinicOptions.join(', ')}`);
} else {
  ok('화면에서 구형 클리닉 유형 선택지를 제거했습니다.');
}
if (!visibleAdmin.includes('통과개수 / 전체개수') || !visibleAdmin.includes('맞은 개수')) {
  fail('단어시험 UI가 맞은개수/전체개수 기준으로 보이지 않습니다.');
} else {
  ok('단어시험 UI가 맞은개수/전체개수 기준으로 정리되었습니다.');
}
if (!rpcText.includes('normalizeWordCount') || !rpcText.includes('correct_count') || !rpcText.includes("task_type: 'EXTRA_CLINIC'")) {
  fail('서버가 맞은개수 또는 추가 클리닉 자동 생성 기준을 충분히 반영하지 못했습니다.');
} else {
  ok('서버가 맞은개수/전체개수와 WORD_FAIL 추가 클리닉 기준을 반영합니다.');
}



const clinicNoticeActions = [
  'CLINIC_RESERVATION_PARENT',
  'CLINIC_RESERVATION_STUDENT',
  'CLINIC_MISSING_PARENT',
  'CLINIC_MISSING_STUDENT',
  'CLINIC_ABSENCE_PARENT'
];
const missingClinicNoticeActions = clinicNoticeActions.filter(v => !rpcText.includes(v) || !adminText.includes(v));
if (missingClinicNoticeActions.length) {
  fail(`클리닉 알림톡 5종 action 라우팅 누락: ${missingClinicNoticeActions.join(', ')}`);
} else {
  ok('클리닉 알림톡 5종 action 라우팅이 서버와 화면에 모두 있습니다.');
}
const clinicTemplateCodes = [
  'clinicreservationforparents',
  'clinicreservationforstudents',
  'onlineclinicabsenceforparents',
  'onlineclinicabsenceforstudents',
  'offlineclinicabsence'
];
const missingClinicTemplateCodes = clinicTemplateCodes.filter(v => !notifyText.includes(v));
if (missingClinicTemplateCodes.length) {
  fail(`클리닉 알림톡 템플릿 코드 누락: ${missingClinicTemplateCodes.join(', ')}`);
} else {
  ok('클리닉 알림톡 5개 템플릿 코드가 발송 라우터에 반영되었습니다.');
}

if (!existsSync(join(root, 'scripts/smoke-test.mjs'))) {
  fail('실제 API smoke-test 스크립트가 없습니다.');
} else {
  ok('실제 API smoke-test 스크립트가 존재합니다.');
}


if (!rpcText.includes("op === 'admin.phoneIdentity.audit'")) {
  fail('admin.phoneIdentity.audit 서버 op가 없습니다.');
} else {
  ok('admin.phoneIdentity.audit 서버 op가 존재합니다.');
}
if (!adminText.includes('btnPhoneIdentityAudit') || !adminText.includes('phoneIdentityRows')) {
  fail('휴대폰 출결 준비도 관리자 UI가 없습니다.');
} else {
  ok('휴대폰 출결 준비도 관리자 UI가 있습니다.');
}
if (!smokeText.includes('admin.phoneIdentity.audit')) {
  fail('live smoke-test에 admin.phoneIdentity.audit가 없습니다.');
} else {
  ok('live smoke-test에 휴대폰 출결 준비도 점검이 포함됩니다.');
}

if (!existsSync(join(root, 'scripts/ops-checklist.mjs'))) {
  fail('운영 테스트 체크리스트 자동화 스크립트가 없습니다.');
} else {
  ok('운영 테스트 체크리스트 자동화 스크립트가 존재합니다.');
}

if (!adminText.includes('QR 인식 문제 대응 순서') || adminText.includes('id="qrCenter"')) {
  fail('QR Center가 출결 화면으로 정리되지 않았습니다.');
} else {
  ok('QR Center가 출결 화면 안으로 정리되었습니다.');
}


const clinicAutoNotifyRequiredIds = ['clinicDueTime', 'clinicMode', 'clinicAutoNotice'];
const missingClinicAutoNotifyIds = clinicAutoNotifyRequiredIds.filter(id => !adminIds.includes(id));
if (missingClinicAutoNotifyIds.length) {
  fail(`오프라인 클리닉 자동 알림 UI id 누락: ${missingClinicAutoNotifyIds.join(', ')}`);
} else {
  ok('오프라인 클리닉 자동 알림 UI가 있습니다.');
}

const clinicAutoActions = ['CLINIC_REMINDER_PARENT', 'CLINIC_REMINDER_STUDENT', 'CLINIC_ABSENCE_PARENT'];
const missingClinicAutoActions = clinicAutoActions.filter(action => !rpcText.includes(action) || !notifyText.includes(action));
if (missingClinicAutoActions.length) {
  fail(`클리닉 자동 알림 action 라우팅 누락: ${missingClinicAutoActions.join(', ')}`);
} else {
  ok('클리닉 즉시/오전8시/미등원 자동 알림 action 라우팅이 있습니다.');
}

const autoSchemaPath = join(root, 'docs/supabase-clinic-auto-notify-v1.sql');
if (!existsSync(autoSchemaPath)) {
  fail('docs/supabase-clinic-auto-notify-v1.sql 파일이 없습니다.');
} else {
  const autoSchemaText = readFileSync(autoSchemaPath, 'utf8');
  const autoSchemaTokens = ['student_phone', 'due_time', 'due_at', 'clinic_mode', 'auto_notice_enabled', 'attendance_notify_queue_status_occurred_idx'];
  const missingAutoSchemaTokens = autoSchemaTokens.filter(token => !autoSchemaText.includes(token));
  if (missingAutoSchemaTokens.length) {
    fail(`클리닉 자동 알림 SQL 필수 항목 누락: ${missingAutoSchemaTokens.join(', ')}`);
  } else {
    ok('클리닉 자동 알림 SQL이 학생전화/예정시간/스케줄 queue를 보강합니다.');
  }
}

if (failed > 0) {
  console.error('');
  console.error(`Contract check failed: ${failed} issue(s)`);
  process.exit(1);
}

console.log('');
console.log('Contract check passed.');
