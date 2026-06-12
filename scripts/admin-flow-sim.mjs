import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
let failed = 0;
function ok(message) { console.log('OK', message); }
function fail(message) { failed += 1; console.error('FAIL', message); }
function hasId(id) { return html.includes(`id="${id}"`) || html.includes(`id='${id}'`); }
function hasFunction(name) { return html.includes(`function ${name}`) || html.includes(`async function ${name}`); }
function requireIds(label, ids) {
  const missing = ids.filter(id => !hasId(id));
  if (missing.length) fail(`${label} 필수 요소 누락: ${missing.join(', ')}`);
  else ok(`${label} 필수 요소가 모두 있습니다.`);
}
function requireFunction(label, name, snippets = []) {
  if (!hasFunction(name)) { fail(`${label} 함수 누락: ${name}`); return; }
  const start = html.indexOf(`function ${name}`) >= 0 ? html.indexOf(`function ${name}`) : html.indexOf(`async function ${name}`);
  const body = html.slice(start, start + 1800);
  const missing = snippets.filter(item => !body.includes(item));
  if (missing.length) fail(`${label} 함수 ${name}에 필요한 동작 누락: ${missing.join(', ')}`);
  else ok(`${label} 함수 ${name} 동작이 연결되어 있습니다.`);
}

requireIds('로그인', ['loginId', 'loginPw', 'btnLogin']);
requireIds('학생 검색', ['quickStudentQuery', 'btnQuickStudentSearch', 'studentQuery', 'studentResults']);
requireFunction('학생 검색', 'quickStudentSearch', ['jumpTo(\'students\')', 'searchStudentsNow']);

requireIds('선택 학생 출결 흐름', ['btnQuickStudentLogs', 'btnStudentLogsOneClick', 'logYmd', 'logSidFilter', 'btnLoadLogs']);
requireFunction('선택 학생 출결 흐름', 'quickStudentLogs', ['logSidFilter', 'jumpTo(\'attendance\')', 'loadLogs']);

requireIds('선택 학생 클리닉 흐름', ['btnQuickStudentClinic', 'btnStudentClinicOneClick', 'clinicStudentFilter', 'clinicTitle', 'clinicTaskType', 'btnCreateClinicTask']);
requireFunction('선택 학생 클리닉 흐름', 'quickStudentClinicView', ['clinicStudentFilter', 'jumpTo(\'clinic\')', 'loadClinicTasks']);
requireFunction('클리닉 생성', 'createClinicTask', ['clinic.createTask', 'loadClinicTasks']);

requireIds('선택 학생 단어 흐름', ['btnQuickWordInput', 'btnStudentWordOneClick', 'wordResultStudentId', 'wordResultSessionId', 'wordScore', 'btnEnterWordResult']);
requireFunction('선택 학생 단어 흐름', 'quickStudentWordInput', ['wordResultStudentId', 'jumpTo(\'words\')']);
requireFunction('단어 결과 저장', 'enterWordResult', ['wordTest.enterResult', 'loadClinicTasks']);

requireIds('오늘 점검 흐름', ['btnPulseCheck', 'btnCommandPulse', 'quickActionLog']);
requireFunction('오늘 점검 흐름', 'runTodayPulse', ['loadOverview', 'loadNotifyQueue', 'loadClinicTasks', 'listWordSessions']);

requireIds('단어시험 일괄 입력 흐름', ['wordBulkSessionId', 'wordBulkClassId', 'btnLoadWordBulk', 'btnSaveWordBulk', 'wordBulkRows']);
requireIds('단어시험 결과 검수 흐름', ['btnLoadWordResults', 'wordResultsRows', 'wordResultsSummary']);
requireFunction('단어시험 일괄 명단', 'loadWordBulkEntry', ['wordTest.bulkEntry', 'renderWordBulkRows']);
requireFunction('단어시험 일괄 저장', 'saveWordBulkResults', ['wordTest.bulkEnterResults', 'loadClinicTasks', 'loadWordResults']);
requireFunction('단어시험 결과 검수', 'loadWordResults', ['wordTest.listResults', 'renderWordResults']);

requireIds('리포트 생성 흐름', ['reportStudentLabel', 'reportStartYmd', 'reportEndYmd', 'btnPreviewReport', 'btnSaveReportSnapshot', 'reportPreviewBox']);
requireIds('리포트 스냅샷 조회 흐름', ['btnListReportSnapshots', 'reportSnapshotRows', 'reportSnapshotSummary']);
requireFunction('리포트 미리보기', 'previewReport', ['report.previewStudentReport', 'renderReportPreview']);
requireFunction('리포트 스냅샷 저장', 'saveReportSnapshot', ['report.createSnapshot', 'renderReportPreview', 'listReportSnapshots']);
requireFunction('리포트 스냅샷 조회', 'listReportSnapshots', ['report.listSnapshots', 'renderReportSnapshots']);

requireIds('감사 로그 흐름', ['auditOpFilter', 'auditTargetTypeFilter', 'auditActorFilter', 'btnLoadAuditLogs', 'auditLogRows']);
requireFunction('감사 로그 조회', 'loadAuditLogs', ['audit.searchLogs', 'auditLogRows']);

const forbiddenButtonTexts = ['100점 저장', '95점 저장', '80점 저장', '후보만', '대기만', '80점 저장'];
const visibleMarkup = html.split('<script>')[0];
const foundForbidden = forbiddenButtonTexts.filter(text => new RegExp(`<button[^>]*>[\s\S]*?${text}[\s\S]*?<\/button>`, 'i').test(visibleMarkup));
if (foundForbidden.length) fail(`시뮬레이션 기준 과다 버튼이 남아 있습니다: ${foundForbidden.join(', ')}`);
else ok('시뮬레이션 기준 과다 버튼이 화면에서 제거되었습니다.');

if (failed > 0) {
  console.error('');
  console.error(`Admin flow simulation failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('');
console.log('Admin flow simulation passed.');
