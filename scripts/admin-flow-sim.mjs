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
  const body = html.slice(start, start + 3200);
  const missing = snippets.filter(item => !body.includes(item));
  if (missing.length) fail(`${label} 함수 ${name}에 필요한 동작 누락: ${missing.join(', ')}`);
  else ok(`${label} 함수 ${name} 동작이 연결되어 있습니다.`);
}

requireIds('로그인', ['loginId', 'loginPw', 'btnLogin']);
requireIds('학생 검색', ['quickStudentQuery', 'btnQuickStudentSearch', 'studentQuery', 'btnStudentSearchNow', 'studentResults']);
requireFunction('학생 검색', 'quickStudentSearch', ['jumpTo(\'students\')', 'searchStudentsNow']);

requireIds('선택 학생 출결 흐름', ['btnQuickStudentLogs', 'btnStudentLogsOneClick', 'logYmd', 'logSidFilter', 'btnLoadLogs']);
requireFunction('선택 학생 출결 흐름', 'quickStudentLogs', ['logSidFilter', 'jumpTo(\'attendance\')', 'loadLogs']);

requireIds('선택 학생 클리닉 흐름', ['btnQuickStudentClinic', 'btnStudentClinicOneClick', 'clinicStudentFilter', 'clinicTitle', 'clinicTaskType', 'btnCreateClinicTask', 'clinicStudentId', 'clinicLocalStudentQuery']);
requireFunction('선택 학생 클리닉 흐름', 'quickStudentClinicView', ['clinicStudentFilter', 'jumpTo(\'clinic\')', 'loadClinicTasks']);
requireFunction('클리닉 생성', 'createClinicTask', ['clinic.createTask', 'loadClinicTasks']);
requireIds('수업 클리닉 반 전체 생성 흐름', ['clinicClassId', 'btnClinicClassRosterPreview', 'clinicClassRosterSummary', 'btnLoadTodayClinicTasks', 'clinicDueDateFilter', 'clinicTypeFilter']);
requireFunction('수업 클리닉 반 명단 확인', 'previewClinicClassRoster', ['assistant.listClassRoster', 'clinicClassRosterSummary']);
requireFunction('오늘 클리닉 할 일', 'loadTodayClinicTasks', ['open_only', 'due_ymd', 'loadClinicTasks']);
requireFunction('클리닉 화면 내부 학생 검색', 'searchClinicLocalStudents', ['assistant.searchStudents', 'clinicStudentId', 'clinicStudentLabel']);


requireIds('선택 학생 단어 흐름', ['btnQuickWordInput', 'btnStudentWordOneClick', 'wordResultStudentId', 'wordResultSessionId', 'wordScore', 'btnEnterWordResult']);
requireFunction('선택 학생 단어 흐름', 'quickStudentWordInput', ['wordResultStudentId', 'jumpTo(\'words\')']);
requireFunction('단어 결과 저장', 'enterWordResult', ['wordTest.enterResult', 'loadClinicTasks']);

requireIds('오늘 점검 흐름', ['btnPulseCheck', 'btnCommandPulse', 'quickActionLog']);
requireFunction('오늘 점검 흐름', 'runTodayPulse', ['loadOverview', 'loadNotifyQueue', 'loadClinicTasks', 'listWordSessions']);

requireIds('단어시험 기간/일괄 입력 흐름', ['wordStartYmd', 'wordEndYmd', 'wordBulkSessionId', 'wordBulkClassId', 'btnLoadWordBulk', 'btnSaveWordBulk', 'wordBulkRows', 'wordBulkLiveSummary']);
requireIds('단어시험 결과 검수 흐름', ['btnLoadWordResults', 'wordResultsRows', 'wordResultsSummary']);
requireFunction('단어시험 일괄 명단', 'loadWordBulkEntry', ['wordTest.bulkEntry', 'renderWordBulkRows']);
requireFunction('단어시험 일괄 실시간 요약', 'updateWordBulkLiveSummary', ['wordBulkLiveSummary']);
requireFunction('단어시험 일괄 저장', 'saveWordBulkResults', ['wordTest.bulkEnterResults', 'loadClinicTasks', 'loadWordResults']);
requireFunction('단어책 catalog 조회', 'loadWordCatalog', ['wordCatalog.list', 'renderWordCatalog']);
requireFunction('단어시험 결과 검수', 'loadWordResults', ['wordTest.listResults', 'renderWordResults']);

requireIds('리포트 생성 흐름', ['reportStudentLabel', 'reportStartYmd', 'reportEndYmd', 'btnPreviewReport', 'btnSaveReportSnapshot', 'reportPreviewBox', 'reportParentTextBox']);
requireIds('리포트 스냅샷 조회 흐름', ['btnListReportSnapshots', 'reportSnapshotRows', 'reportSnapshotSummary']);
requireFunction('리포트 미리보기', 'previewReport', ['report.previewStudentReport', 'renderReportPreview']);
requireFunction('리포트 스냅샷 저장', 'saveReportSnapshot', ['report.createSnapshot', 'renderReportPreview', 'listReportSnapshots']);
requireFunction('리포트 스냅샷 조회', 'listReportSnapshots', ['report.listSnapshots', 'renderReportSnapshots']);

requireIds('학생 오늘 링크 흐름', ['btnStudentTodayLinkOneClick', 'studentTodayLinkBox']);
requireFunction('학생 오늘 링크 생성', 'createStudentTodayLink', ['admin.studentTodayLink.create', 'studentTodayLinkBox']);
requireIds('온라인강의 배정 흐름', ['studentLectureBox', 'lectureTitle', 'lectureUrl', 'btnSaveLectureAssignment', 'lectureAssignmentRows']);
requireFunction('온라인강의 배정 저장', 'saveLectureAssignment', ['admin.lectureAssignment.save', 'listLectureAssignments']);
requireFunction('온라인강의 배정 조회', 'listLectureAssignments', ['admin.lectureAssignment.list', 'renderLectureAssignmentRows']);


requireIds('감사 로그 흐름', ['auditOpFilter', 'auditTargetTypeFilter', 'auditActorFilter', 'btnLoadAuditLogs', 'auditLogRows']);
requireFunction('감사 로그 조회', 'loadAuditLogs', ['audit.searchLogs', 'auditLogRows', 'auditOpLabel', 'auditTargetLabel']);

requireIds('클리닉 문자 예약 흐름', ['notifyQueueAction', 'notifyQueueRows']);
requireFunction('클리닉 알림 5종 예약', 'queueClinicNotice', ['clinic.queueNotice', 'loadNotifyQueue', 'CLINIC_RESERVATION_PARENT', 'CLINIC_RESERVATION_STUDENT', 'CLINIC_MISSING_PARENT', 'CLINIC_MISSING_STUDENT', 'CLINIC_ABSENCE_PARENT']);
requireFunction('오프라인 클리닉 자동 알림 생성', 'createClinicTask', ['clinicDueTime', 'clinicAutoNotice', 'auto_notice_enabled', 'clinic_mode']);

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
