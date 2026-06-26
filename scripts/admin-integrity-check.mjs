import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
const rpc = readFileSync('api/rpc.js', 'utf8');
const notify = readFileSync('lib/attendance-notify.js', 'utf8');
const queue = readFileSync('lib/attendance-notify-queue.js', 'utf8');
const kiosk = readFileSync('api/kiosk-mark.js', 'utf8');
const indexHtml = readFileSync('index.html', 'utf8');
const admin = html;
function assertIncludes(text, snippet, message) {
  if (!String(text || '').includes(snippet)) fail(message + ' 기준 미충족');
  else ok(message);
}
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


if (!words.includes('wordBookSelect') || !words.includes('wordRangeSelect') || !rpc.includes('wordCatalog.list')) {
  fail('단어책/범위 catalog 선택 흐름이 없습니다.');
} else ok('단어책/범위 catalog 선택 흐름이 있습니다.');

if (!rpc.includes('wordRecord.list') || !rpc.includes('word_records') || !rpc.includes('word_record_mirror')) {
  fail('학생별 단어 누적 기록 mirror/API 흐름이 없습니다.');
} else ok('학생별 단어 누적 기록 mirror/API 흐름이 있습니다.');

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


if (!kiosk.includes("inputMode = sidFromIdInput ? 'STUDENT_ID'") || kiosk.includes("'NOT_EXCEPTION'")) {
  fail('등원/하원 학번 기본 출결 정책이 서버에 반영되지 않았습니다.');
} else ok('등원/하원 학번 기본 출결 정책이 서버에 반영되었습니다.');

if (!indexHtml.includes('학번 4자리 입력 / QR 스캔도 가능')) {
  fail('키오스크 입력 안내가 학번 중심으로 변경되지 않았습니다.');
} else ok('키오스크 입력 안내가 학번 중심으로 변경되었습니다.');

if (!html.includes('auditOpLabel') || !html.includes('auditTargetLabel')) {
  fail('감사 로그 화면 문구 변환 함수가 없습니다.');
} else ok('감사 로그 화면 문구 변환이 있습니다.');

if (!rpc.includes("clinic.queueNotice") || !html.includes('queueClinicNotice')) {
  fail('클리닉 알림 예약 흐름이 없습니다.');
} else ok('클리닉 알림 예약 흐름이 있습니다.');
const clinicNoticeActions = ['CLINIC_RESERVATION_PARENT','CLINIC_RESERVATION_STUDENT','CLINIC_MISSING_PARENT','CLINIC_MISSING_STUDENT','CLINIC_ABSENCE_PARENT'];
const missingClinicNoticeActions = clinicNoticeActions.filter(v => !rpc.includes(v) || !html.includes(v));
if (missingClinicNoticeActions.length) fail('클리닉 알림톡 5종 action 누락: ' + missingClinicNoticeActions.join(', '));
else ok('클리닉 알림톡 5종 action이 모두 반영됐습니다.');
const clinicTemplateCodes = ['clinicreservationforparents','clinicreservationforstudents','onlineclinicabsenceforparents','onlineclinicabsenceforstudents','offlineclinicabsence'];
const missingClinicTemplateCodes = clinicTemplateCodes.filter(v => !notify.includes(v));
if (missingClinicTemplateCodes.length) fail('클리닉 알림톡 템플릿 코드 누락: ' + missingClinicTemplateCodes.join(', '));
else ok('클리닉 알림톡 템플릿 5개 코드가 모두 반영됐습니다.');

const staleUiHooks = ['data-word-score-save', 'data-word-status-save', 'data-quick-clinic', 'data-clinic-filter', 'data-notify-filter']
  .filter(hook => visible.includes(hook));
if (staleUiHooks.length) fail(`화면에 제거된 원클릭/필터 hook이 남아 있습니다: ${staleUiHooks.join(', ')}`);
else ok('화면에 제거된 원클릭/필터 hook이 남아 있지 않습니다.');


assertIncludes(admin, 'clinicDueTime', '오프라인 클리닉 예정시간 입력이 있습니다.');
assertIncludes(admin, 'clinicAutoNotice', '오프라인 클리닉 자동 알림 선택이 있습니다.');
assertIncludes(rpc, 'student_phone', '학생용 클리닉 알림이 중앙DB 학생전화 컬럼을 사용합니다.');
assertIncludes(rpc, 'enqueueOfflineClinicAutoNoticesDirect', '오프라인 클리닉 생성 시 자동 알림 예약 함수가 있습니다.');
assertIncludes(rpc, 'CLINIC_REMINDER_PARENT', '오전 8시 학부모 리마인드 action이 있습니다.');
assertIncludes(rpc, 'CLINIC_REMINDER_STUDENT', '오전 8시 학생 리마인드 action이 있습니다.');
assertIncludes(queue, "lte('occurred_at'", '문자 worker가 예약 시각이 된 queue만 처리합니다.');
assertIncludes(queue, 'clinicSkipReason', '클리닉 완료/진행 상태에서는 미등원 알림을 건너뜁니다.');



assertIncludes(admin, 'clinicClassId', '수업 클리닉 반 ID 입력이 있습니다.');
assertIncludes(admin, 'clinicLocalStudentQuery', '클리닉 메뉴 내부 학생 검색이 있습니다.');
assertIncludes(admin, 'btnLoadTodayClinicTasks', '조교용 오늘 클리닉 할 일 조회가 있습니다.');
assertIncludes(rpc, 'readClassStudentIdsForClinic', '수업 클리닉 반 전체 생성 명단 조회 함수가 있습니다.');
assertIncludes(rpc, 'bulk_created', '수업 클리닉 반 전체 생성 응답이 있습니다.');
assertIncludes(rpc, 'CLASS_CLINIC_NO_AUTO_NOTICE', '수업 클리닉 자동 문자 제외 기준이 있습니다.');
assertIncludes(rpc, 'open_only', '오늘 할 일 open_only 조회 필터가 있습니다.');



assertIncludes(admin, 'clinicBoardRows', '조교/선생님용 오늘 클리닉 업무판이 있습니다.');
assertIncludes(admin, 'bulkUpdateClinicGroup', '클리닉 그룹 일괄 완료 함수가 있습니다.');
assertIncludes(rpc, 'clinicTodayBoardDirect', '클리닉 오늘 업무판 서버 조회가 있습니다.');
assertIncludes(rpc, 'clinicBulkUpdateStatusDirect', '클리닉 일괄 상태 변경 서버 함수가 있습니다.');
assertIncludes(rpc, 'clinic.createClassTasks', '수업 클리닉 반 전체 생성 감사 로그가 있습니다.');
assertIncludes(rpc, 'clinic.bulkUpdateStatus', '클리닉 일괄 변경 감사 로그가 있습니다.');

if (failed) {
  console.error(`\nAdmin integrity check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nAdmin integrity check passed.');
