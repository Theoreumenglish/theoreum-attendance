import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
const rpc = readFileSync('api/rpc.js', 'utf8');
const visible = html.split('<script>')[0];
let failed = 0;
const ok = msg => console.log('OK', msg);
const fail = msg => { failed += 1; console.error('FAIL', msg); };

function sectionById(id) {
  const re = new RegExp(`<section\\b(?=[^>]*\\bid=["']${id}["'])[\\s\\S]*?(?=<section\\b|<script>|</main>)`, 'i');
  const m = html.match(re);
  return m ? m[0] : '';
}

const words = sectionById('words');
const clinic = sectionById('clinic');

if (!words.includes('통과개수 / 전체개수') || !words.includes('맞은 개수')) {
  fail('단어시험은 맞은개수/전체개수 형태로 보여야 합니다.');
} else ok('단어시험 화면이 맞은개수/전체개수 기준입니다.');

if (/점수 입력|100점 저장|95점 저장|90점 저장|80점 저장/.test(words)) {
  fail('단어시험 화면에 점수 중심 문구나 프리셋 버튼이 남아 있습니다.');
} else ok('단어시험 화면에서 점수 중심/프리셋 흐름을 제거했습니다.');

const requiredClinicLabels = ['수업 클리닉', '추가 클리닉', '개별 클리닉'];
const missingClinicLabels = requiredClinicLabels.filter(label => !clinic.includes(label));
if (missingClinicLabels.length) fail(`클리닉 3종 라벨 누락: ${missingClinicLabels.join(', ')}`);
else ok('클리닉 화면은 수업/추가/개별 3종을 표시합니다.');

const legacyClinicValues = ['GENERAL','WORD','GRAMMAR','READING','WRITING','ATTENDANCE','HOMEWORK','MAKEUP']
  .filter(v => new RegExp(`<option\\b[^>]*value=["']${v}["']`, 'i').test(clinic));
if (legacyClinicValues.length) fail(`클리닉 화면에 구형 유형 option이 남아 있습니다: ${legacyClinicValues.join(', ')}`);
else ok('클리닉 화면에서 구형 유형 option을 제거했습니다.');

const requiredRpcSnippets = [
  'normalizeWordCount',
  'correct_count',
  'total_count',
  'pass_count',
  "task_type: 'EXTRA_CLINIC'",
  "CLASS_CLINIC",
  "EXTRA_CLINIC",
  "INDIVIDUAL_CLINIC"
];
const missingRpc = requiredRpcSnippets.filter(s => !rpc.includes(s));
if (missingRpc.length) fail(`서버 무결성 기준 누락: ${missingRpc.join(', ')}`);
else ok('서버가 맞은개수/전체개수와 클리닉 3종 기준을 포함합니다.');

if (/점수 \$\{|점수 \${|기준점수/.test(rpc)) {
  fail('서버 메시지에 점수 중심 문구가 남아 있습니다.');
} else ok('서버 메시지는 맞은 개수 중심입니다.');


if (!words.includes('wordStartYmd') || !words.includes('wordEndYmd')) {
  fail('단어시험 회차 조회 기간 필터가 없습니다.');
} else ok('단어시험 회차 조회 기간 필터가 있습니다.');

if (!words.includes('wordBulkLiveSummary') || !html.includes('updateWordBulkLiveSummary')) {
  fail('단어시험 일괄 입력 실시간 요약이 없습니다.');
} else ok('단어시험 일괄 입력 실시간 요약이 있습니다.');

if (!html.includes('reportParentTextBox') || !html.includes('학부모 전달 문구')) {
  fail('리포트 학부모 전달 문구 영역이 없습니다.');
} else ok('리포트 학부모 전달 문구 영역이 있습니다.');

if (html.includes('id="qrCenter"')) {
  fail('QR Center 별도 화면이 아직 남아 있습니다.');
} else ok('QR Center 별도 화면을 정리했습니다.');

if (!html.includes('auditOpLabel') || !html.includes('auditTargetLabel')) {
  fail('감사 로그 화면 문구 변환 함수가 없습니다.');
} else ok('감사 로그 화면 문구 변환이 있습니다.');

if (!rpc.includes("clinic.queueParentNotice") || !html.includes('queueClinicNotice')) {
  fail('클리닉 문자 예약 흐름이 없습니다.');
} else ok('클리닉 문자 예약 흐름이 있습니다.');

const staleUiHooks = ['data-word-score-save', 'data-word-status-save', 'data-quick-clinic', 'data-clinic-filter', 'data-notify-filter']
  .filter(hook => visible.includes(hook));
if (staleUiHooks.length) fail(`화면에 제거된 원클릭/필터 hook이 남아 있습니다: ${staleUiHooks.join(', ')}`);
else ok('화면에 제거된 원클릭/필터 hook이 남아 있지 않습니다.');

if (failed) {
  console.error(`\nAdmin integrity check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nAdmin integrity check passed.');
