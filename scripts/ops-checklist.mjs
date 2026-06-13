#!/usr/bin/env node
// Static operational checklist automation for TheOreum portal.
// This script is safe to run in verify because it does not call external services.
import { existsSync, readFileSync } from 'node:fs';

let failed = 0;
const ok = msg => console.log('OK', msg);
const fail = msg => { failed += 1; console.error('FAIL', msg); };
const warn = msg => console.log('WARN', msg);

function mustExist(path) {
  if (!existsSync(path)) fail(`${path} 파일이 없습니다.`);
  else ok(`${path} 존재`);
}
function read(path) { return readFileSync(path, 'utf8'); }

const requiredFiles = [
  'api/rpc.js',
  'lib/attendance-notify.js',
  'lib/attendance-notify-queue.js',
  'public/admin.html',
  'docs/API_OPERATIONS.md',
  'docs/DATA_DICTIONARY.md',
  'docs/TEST_PLAN.md',
  'scripts/smoke-test.mjs'
];
for (const file of requiredFiles) mustExist(file);

const pkg = JSON.parse(read('package.json'));
for (const scriptName of ['check', 'contract-check', 'ux-check', 'flow-sim', 'integrity-check', 'ops-checklist', 'smoke-test', 'verify']) {
  if (!pkg.scripts?.[scriptName]) fail(`package.json scripts.${scriptName} 누락`);
  else ok(`npm run ${scriptName} 등록`);
}

const admin = read('public/admin.html');
const rpc = read('api/rpc.js');
const queue = read('lib/attendance-notify-queue.js');
const notify = read('lib/attendance-notify.js');

const checklist = [
  ['단어시험 기간 조회', admin.includes('wordStartYmd') && admin.includes('wordEndYmd') && rpc.includes('start_ymd')],
  ['단어시험 일괄 입력 실시간 요약', admin.includes('wordBulkLiveSummary') && admin.includes('updateWordBulkLiveSummary')],
  ['리포트 학부모용 문구', admin.includes('reportParentTextBox') && admin.includes('학부모 전달 문구')],
  ['QR Center 출결 화면 흡수', !admin.includes('id="qrCenter"') && admin.includes('QR 인식 문제 대응 순서')],
  ['감사 로그 문구 변환', admin.includes('auditOpLabel') && admin.includes('auditTargetLabel')],
  ['클리닉 알림톡 5종 queue', rpc.includes("op === 'clinic.queueNotice'") && queue.includes('CLINIC_') && notify.includes('clinicreservationforparents') && notify.includes('clinicreservationforstudents') && notify.includes('onlineclinicabsenceforparents') && notify.includes('onlineclinicabsenceforstudents') && notify.includes('offlineclinicabsence')],
  ['실제 API smoke-test 스크립트', existsSync('scripts/smoke-test.mjs')]
];
for (const [label, passed] of checklist) {
  if (passed) ok(label);
  else fail(label + ' 기준 미충족');
}

if (!/SMOKE_BASE_URL/.test(read('scripts/smoke-test.mjs'))) warn('smoke-test는 SMOKE_BASE_URL 지정 후 실행해야 합니다.');

if (failed) {
  console.error(`\nOperational checklist failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nOperational checklist passed.');
