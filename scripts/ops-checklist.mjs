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
function checkFile(path, label) {
  if (existsSync(path)) ok(label);
  else fail(label + ' 파일 누락: ' + path);
}
function checkText(path, snippet, label) {
  if (!existsSync(path)) { fail(label + ' 파일 누락: ' + path); return; }
  if (read(path).includes(snippet)) ok(label);
  else fail(label + ' 기준 미충족');
}

const requiredFiles = [
  'api/rpc.js',
  'lib/attendance-notify.js',
  'lib/attendance-notify-queue.js',
  'public/admin.html',
  'docs/API_OPERATIONS.md',
  'docs/DATA_DICTIONARY.md',
  'docs/TEST_PLAN.md',
  'scripts/smoke-test.mjs',
  'scripts/setup-smoke-env.ps1',
  'scripts/one-click-release.ps1',
  'scripts/copy-last-run-log.ps1',
  'scripts/apply-patch-files.ps1',
  'scripts/dev-doctor.ps1',
  'scripts/quick-local-check.ps1',
  'scripts/rollback-latest-backup.ps1',
  'scripts/db-migration-status.ps1',
  'docs/DB_MIGRATION_GATE_V1.md',
  'docs/DEV_CONVENIENCE_SUITE_V1.md',
  'docs/DEV_SPEED_STABILITY_V1.md',
  'scripts/final-readiness-check.mjs',
  'docs/FINAL_READINESS_CHECKLIST.md',
  'docs/MASTER_DATA_PORTAL.md',
  'docs/supabase-master-speed-v2.sql',
  'docs/WORD_GRID_SPEED_V1.md',
  'docs/STUDENT_WORD_RECORDS_V1.md',
  'docs/supabase-student-word-records-v1.sql',
  'docs/STUDENT_ID_ATTENDANCE_V1.md',
  'docs/TERMINAL_LOG_CAPTURE_V1.md',
  'docs/YEAR_ROUND_PRODUCT_STRATEGY_V1.md',
  'docs/PARENT_STUDENT_LINK_PORTAL_V1.md',
  'docs/ONLINE_LECTURE_LINKAGE_V1.md',
  'docs/PAYMENT_SCOPE_DECISION_V1.md',
  'docs/DIRECTOR_EXPLANATION_BRIEF_V1.md',
  'docs/PHONE_IDENTITY_QUALITY_V1.md',
  'docs/PRODUCTION_QA_PARITY_V1.md',
  'scripts/production-deep-click-qa.mjs',
  'scripts/run-production-deep-click-qa.ps1',
  'docs/PRODUCTION_DEEP_CLICK_QA_V1.md'
];
for (const file of requiredFiles) mustExist(file);

const pkg = JSON.parse(read('package.json'));
for (const scriptName of ['check', 'contract-check', 'ux-check', 'flow-sim', 'integrity-check', 'ops-checklist', 'final-readiness-check', 'smoke-test', 'setup-smoke-env', 'one-click-release', 'copy-last-log', 'dev:doctor', 'dev:quick-check', 'dev:apply-patch', 'dev:rollback-latest', 'dev:fast-check', 'dev:release', 'db:migration-status', 'verify:no-build', 'prod:qa:deep', 'prod:qa:deep:write', 'verify']) {
  if (!pkg.scripts?.[scriptName]) fail(`package.json scripts.${scriptName} 누락`);
  else ok(`npm run ${scriptName} 등록`);
}

const admin = read('public/admin.html');
const rpc = read('api/rpc.js');
const queue = read('lib/attendance-notify-queue.js');
const notify = read('lib/attendance-notify.js');
const kiosk = read('api/kiosk-mark.js');
const rootIndex = read('index.html');

const checklist = [
  ['원클릭 릴리즈 로그 자동 저장', existsSync('scripts/one-click-release.ps1') && read('scripts/one-click-release.ps1').includes('Start-Transcript') && read('scripts/one-click-release.ps1').includes('LAST_FAILURE_TO_SEND.txt') && read('scripts/one-click-release.ps1').includes('LAST_RUN.log')],
  ['마지막 로그 복사용 스크립트', existsSync('scripts/copy-last-run-log.ps1') && read('scripts/copy-last-run-log.ps1').includes('Set-Clipboard') && read('scripts/copy-last-run-log.ps1').includes('LAST_FAILURE_TO_SEND.txt')],
  ['릴리즈 zip 로그 제외', existsSync('scripts/make-release-zip.ps1') && read('scripts/make-release-zip.ps1').includes('"_logs"')],
  ['터미널 로그 캡처 문서', existsSync('docs/TERMINAL_LOG_CAPTURE_V1.md') && read('docs/TERMINAL_LOG_CAPTURE_V1.md').includes('LAST_FAILURE_TO_SEND.txt')],
  ['단어시험 기간 조회', admin.includes('wordStartYmd') && admin.includes('wordEndYmd') && rpc.includes('start_ymd')],
  ['단어시험 일괄 입력 실시간 요약', admin.includes('wordBulkLiveSummary') && admin.includes('updateWordBulkLiveSummary')],
  ['리포트 학부모용 문구', admin.includes('reportParentTextBox') && admin.includes('학부모 전달 문구')],
  ['QR Center 출결 화면 흡수', !admin.includes('id="qrCenter"') && admin.includes('QR 인식 문제 대응 순서')],
  ['감사 로그 문구 변환', admin.includes('auditOpLabel') && admin.includes('auditTargetLabel')],
  ['클리닉 알림톡 5종 queue', rpc.includes("op === 'clinic.queueNotice'") && queue.includes('CLINIC_') && notify.includes('clinicreservationforparents') && notify.includes('clinicreservationforstudents') && notify.includes('onlineclinicabsenceforparents') && notify.includes('onlineclinicabsenceforstudents') && notify.includes('offlineclinicabsence')],
  ['실제 API smoke-test 스크립트', existsSync('scripts/smoke-test.mjs')],
  ['학생별 단어 누적 기록 API', rpc.includes("op === 'wordRecord.list'") && rpc.includes('wordRecordListDirect')],
  ['단어 결과 저장 시 word_records mirror', rpc.includes('upsertWordRecordMirrorsIfAvailable') && rpc.includes('word_record_mirror')],
  ['학생별 단어 누적 기록 SQL', existsSync('docs/supabase-student-word-records-v1.sql') && read('docs/supabase-student-word-records-v1.sql').includes('create table if not exists public.word_records')],
  ['학생 휴대폰 번호 출결 서버 정책', kiosk.includes("inputMode = sidFromIdInput ? 'STUDENT_ID_LEGACY' : 'PHONE_LAST8'") && kiosk.includes('findStudentByPhoneTail8')],
  ['학생 휴대폰 번호 010- 분할 입력 UI', rootIndex.includes('kPhoneMid') && rootIndex.includes('kPhoneLast') && rootIndex.includes('phoneSegmentRow')],
  ['물리 키보드 번호 입력 하드닝', rootIndex.includes('routePhysicalKeyToPhoneSegments') && rootIndex.includes('routePhysicalKeyToRawScanner') && rootIndex.includes('handlePhoneSegmentBackspace')],
  ['휴대폰 번호 분할 입력 문서', existsSync('docs/PHONE_SEGMENT_INPUT_V1.md')],
  ['개발 표면 확인 루틴 문서', existsSync('docs/DEVELOPER_SURFACE_ROUTINE_V1.md')],
  ['화면 숫자 키패드 제거', !rootIndex.includes('id="studentKeypad"') && !rootIndex.includes('data-keypad-digit') && !rootIndex.includes('appendStudentDigit')],
  ['직원 staff 진입어 휴대폰 출퇴근 UI', rootIndex.includes('isStaffCommandPrefix') && rootIndex.includes('staffQuickStep') && rootIndex.includes('kPhoneMid') && rootIndex.includes('kPhoneLast') && rootIndex.includes('phone_tail8')],
  ['직원 휴대폰 번호 출퇴근 서버', read('api/staff-clock.js').includes('readStaffForPhoneClock') && read('api/staff-clock.js').includes("input_mode: 'PHONE_LAST8'")],
  ['직원 수기 근태 API', read('api/rpc.js').includes("op === 'admin.staffClock.saveManual'") && read('lib/staff-clock-admin.js').includes('adminSaveStaffClockManualDirect')],
  ['직원 수기 근태 UI', read('public/admin.html').includes('staffManualStaffId') && read('public/admin.html').includes('btnStaffManualSave')],
  ['Vercel Node 24 engine', read('package.json').includes('"node": "24.x"')]
];
for (const [label, passed] of checklist) {
  if (passed) ok(label);
  else fail(label + ' 기준 미충족');
}

if (!/SMOKE_BASE_URL/.test(read('scripts/smoke-test.mjs'))) warn('smoke-test는 SMOKE_BASE_URL 지정 후 실행해야 합니다.');

checkText('scripts/smoke-test.mjs', 'loadLocalSmokeEnv', 'smoke-test 로컬 env 자동 로딩');
checkText('scripts/setup-smoke-env.ps1', '.env.smoke.local', 'smoke-test 로컬 계정 저장 스크립트');
const oneClickScript = read('scripts/one-click-release.ps1');
if (oneClickScript.includes('Done: verify, commit, push, zip, deploy, smoke-test.') || oneClickScript.includes('Done: check, verify, build, commit, push, zip, deploy, smoke-test.') || oneClickScript.includes('검사 → 검증 → 빌드 → 커밋 → 푸쉬')) ok('원클릭 release/deploy 스크립트');
else fail('원클릭 release/deploy 스크립트 기준 미충족');


checkFile('docs/supabase-clinic-auto-notify-v1.sql', '클리닉 자동 알림 SQL');
checkText('api/rpc.js', 'enqueueOfflineClinicAutoNoticesDirect', '오프라인 클리닉 자동 알림 예약');
checkText('api/rpc.js', 'student_phone', '학생 전화번호 자동 사용');
checkText('lib/attendance-notify-queue.js', "lte('occurred_at'", '예약 시각 기반 queue 처리');
checkText('public/admin.html', 'clinicDueTime', '클리닉 예정시간 UI');
checkText('public/admin.html', 'clinicClassId', '수업 클리닉 반 전체 생성 UI');
checkText('public/admin.html', 'clinicLocalStudentQuery', '클리닉 메뉴 내부 학생 선택 UI');
checkText('public/admin.html', 'btnLoadTodayClinicTasks', '오늘 클리닉 할 일 UI');
checkText('api/rpc.js', 'readClassStudentIdsForClinic', '반 명단 기반 수업 클리닉 생성');
checkText('api/rpc.js', 'open_only', '열린 오늘 클리닉 조회 필터');


checkText('public/admin.html', 'clinicBoardRows', '오늘 클리닉 업무판 UI');
checkText('public/admin.html', 'bulkUpdateClinicGroup', '클리닉 그룹 일괄 처리 UI');
checkText('api/rpc.js', 'clinicTodayBoardDirect', '오늘 클리닉 업무판 API');
checkText('api/rpc.js', 'clinicBulkUpdateStatusDirect', '클리닉 일괄 상태 변경 API');
checkText('api/rpc.js', 'BULK_STATUS_CHANGE', '클리닉 일괄 처리 로그');
checkText('api/rpc.js', 'adminFinalReadinessDirect', '최종 운영 체크 API');
checkText('public/admin.html', 'btnFinalReadiness', '최종 운영 체크 UI');
checkText('scripts/smoke-test.mjs', 'admin.finalReadiness', '실제 API smoke-test 최종 체크 포함');
checkText('scripts/smoke-test.mjs', 'assistant.listClassOptions', '실제 API smoke-test 클래스 조회 포함');
checkText('public/admin.html', '비우면 전체', '클래스 날짜 기본값 전체 조회 안내');
checkText('api/rpc.js', 'classes_fallback', '클래스 일정 없음 fallback 조회');
checkText('api/rpc.js', 'fastCacheSet(cacheKey', '클래스 조회 캐시');
checkText('lib/staff-auth.js', 'AUTH_SESSION_CACHE', '세션 인증 캐시');


checkText('public/admin.html', 'masterClassId', '클래스 생성/수정 UI');
checkText('public/admin.html', 'masterStudentId', '학생DB 추가/수정 UI');
checkText('public/admin.html', 'rosterAddStudentIds', '반 수강생 배정 UI');
checkText('api/rpc.js', "admin.master.upsertClass", '포털 클래스 저장 API');
checkText('api/rpc.js', "admin.master.upsertStudent", '포털 학생 저장 API');
checkText('api/rpc.js', "bridge.class.upsert", '중앙DB bridge 클래스 저장 호출');
checkText('api/rpc.js', "bridge.student.upsert", '중앙DB bridge 학생 저장 호출');
checkText('public/admin.html', 'rpcInflight', '클라이언트 중복 요청 병합');
checkText('public/admin.html', 'rpcCache', '클라이언트 짧은 조회 캐시');
checkText('docs/MASTER_DATA_PORTAL.md', '중앙DB 마스터데이터 포털 이관', '마스터데이터 이관 문서');

checkText('public/admin.html', 'centralClassHolidayYmd', '반별 휴강 포털 이관 UI');
checkText('public/admin.html', 'centralScheduleRows', '실제 일정 수동 편집 UI');
checkText('public/admin.html', 'centralGlobalHolidayRows', '학원 전체 휴무 UI');
checkText('public/admin.html', 'centralStaffRows', '직원 계정 관리 UI');
checkText('public/admin.html', 'centralOpsBox', '중앙DB 설정/Self Check UI');
checkText('api/rpc.js', "admin.central.classHolidays.add", '반별 휴강 bridge API');
checkText('api/rpc.js', "admin.central.schedule.update", '일정 수동 편집 bridge API');
checkText('api/rpc.js', "admin.central.globalHolidays.add", '전체 휴무 bridge API');
checkText('api/rpc.js', "admin.central.staff.upsert", '직원 계정 bridge API');
checkText('api/rpc.js', "admin.central.props.set", '중앙DB 설정 bridge API');
checkText('scripts/smoke-test.mjs', 'admin.central.props.get', 'smoke-test 중앙DB 설정 bridge 포함');
checkText('docs/MASTER_DATA_PORTAL.md', 'CentralDB 웹앱 잔여 기능 이관 v3', '마스터데이터 잔여 기능 이관 문서');
checkText('public/admin.html', 'absenceExcuseRows', '미등원 예외 관리 UI');
checkText('public/admin.html', 'btnBulkAddAbsenceExcuses', '미등원 예외 일괄 추가 UI');
checkText('api/rpc.js', 'fastCacheGetStale', '서버 stale cache fallback');
checkText('api/rpc.js', 'readCentralStaffListReplicaDirect', '직원 목록 replica fast path');
checkText('api/rpc.js', 'central_props_snapshot', '중앙DB 설정 snapshot fast path');
checkText('scripts/smoke-test.mjs', 'assistant.listAbsenceExcuses', 'smoke-test 미등원 예외 조회 포함');
checkText('public/admin.html', 'opsClassSelect', '상단 클래스 딸깍 선택 바');
checkText('public/admin.html', 'clinicClassSelect', '클리닉 클래스 목록 선택 UI');
checkText('public/admin.html', 'wordClassSelect', '단어시험 클래스 목록 선택 UI');
checkText('public/admin.html', 'masterClassTeacherSelect', '담당 직원 목록 선택 UI');
checkText('public/admin.html', 'loadClassCatalog', '클래스 선택 목록 자동 로딩');
checkText('public/admin.html', 'smartBoard', '딸깍 업무 보드 UI');
checkText('public/admin.html', 'workDrawer', '우측 상세 작업 패널 UI');
checkText('public/admin.html', 'safeOptimisticStart', 'safe optimistic 저장 상태 UI');
checkText('public/admin.html', 'setUiMode', '현장/태블릿 모드 토글');
checkText('public/admin.html', 'reportLetter', '리포트 카드형 미리보기');
checkText('api/rpc.js', 'assistantTodayAbsenceBoardDirect', '실시간 미등원 보드 API');
checkText('public/admin.html', 'todayAbsenceRows', '실시간 미등원 보드 UI');
checkText('public/admin.html', 'startTodayAbsenceAuto', '실시간 미등원 자동 갱신');
checkText('scripts/smoke-test.mjs', 'assistant.todayAbsenceBoard', 'smoke-test 실시간 미등원 보드 포함');

checkText('public/admin.html', 'wordSpeedTools', '단어시험 엑셀형 일괄 입력 도구');
checkText('public/admin.html', 'applyWordBulkPaste', '단어시험 붙여넣기 분배');
checkText('public/admin.html', 'collectWordBulkResultsForSave', '단어시험 저장 전 오류 검증');
checkText('public/admin.html', 'btnWordBulkFillAbsent', '단어시험 빈칸 미응시 처리');
checkText('public/admin.html', 'btnWordBulkCopyFail', '단어시험 불통과 목록 복사');
checkText('docs/WORD_GRID_SPEED_V1.md', 'word-grid-speed-v1', '단어시험 grid speed 문서');

checkFile('docs/UI_UX_REFRESH_V2.md', 'UI/UX refresh v2 문서');


checkText('scripts/apply-patch-files.ps1', 'patch-files', '개발 편의 patch-files 직접 적용 helper');
checkText('scripts/apply-patch-files.ps1', 'LAST_PATCH_APPLY.txt', '패치 적용 요약 로그 생성');
checkText('scripts/dev-doctor.ps1', 'DEV_DOCTOR_TO_SEND.txt', '개발 상태 공유용 dev doctor');
checkText('scripts/quick-local-check.ps1', 'LAST_QUICK_CHECK_TO_SEND.txt', '빠른 로컬 검증 실패 요약');
checkText('scripts/rollback-latest-backup.ps1', '_patch_backup_', '최근 패치 백업 rollback helper');
checkText('docs/DEV_CONVENIENCE_SUITE_V1.md', 'dev:apply-patch', '개발 편의 suite 문서');
checkText('docs/DEV_SPEED_STABILITY_V1.md', '중복 검증 제거', '개발 속도 안정화 문서');

checkText('scripts/apply-patch-files.ps1', 'PENDING_SQL_MIGRATIONS.txt', 'SQL 필요 패치 release gate marker');
checkText('scripts/apply-patch-files.ps1', 'LAST_SQL_TO_APPLY.txt', 'SQL 필요 패치 복사용 SQL bundle');
checkText('scripts/one-click-release.ps1', 'Check-SqlMigrationGate', '원클릭 release SQL gate');
checkText('scripts/one-click-release.ps1', '-SqlApplied', 'SQL 적용 확인 옵션');
checkText('scripts/smoke-test.mjs', 'LAST_SMOKE_TO_SEND.txt', 'smoke-test 실패 상세 로그');
checkText('scripts/smoke-test.mjs', 'migrationHintFor', 'smoke-test Supabase migration hint');
checkText('scripts/copy-last-run-log.ps1', 'LAST_SQL_TO_APPLY.txt', 'SQL 복사 우선순위');
checkText('docs/DB_MIGRATION_GATE_V1.md', 'DB Migration Gate v1', 'DB migration gate 문서');

if (oneClickScript.includes('Full verify (includes syntax check and build)') && !oneClickScript.includes('Invoke-NativeStep "Syntax check"') && !oneClickScript.includes('Invoke-NativeStep "Build"')) ok('원클릭 릴리즈 중복 check/build 제거');
else fail('원클릭 릴리즈 중복 check/build 제거 기준 미충족');
checkText('docs/DEVELOPER_SURFACE_ROUTINE_V1.md', 'Vercel', '개발 표면 Vercel 확인 문서');
checkText('docs/DEVELOPER_SURFACE_ROUTINE_V1.md', 'Supabase', '개발 표면 Supabase 확인 문서');
checkText('docs/DEVELOPER_SURFACE_ROUTINE_V1.md', 'GitHub', '개발 표면 GitHub 확인 문서');
checkText('docs/DEVELOPER_SURFACE_ROUTINE_V1.md', 'OpenAI Platform', '개발 표면 OpenAI 확인 문서');
checkText('docs/DEVELOPER_SURFACE_ROUTINE_V1.md', 'Google Drive', '개발 표면 Google Drive 확인 문서');



checkText('docs/YEAR_ROUND_PRODUCT_STRATEGY_V1.md', '상시 학원 운영 누락 방지 OS', '상시 운영 OS 제품 전략');
checkText('docs/PARENT_STUDENT_LINK_PORTAL_V1.md', '모바일 웹 링크 포털', '학생/학부모 링크 포털 전략');
checkText('docs/ONLINE_LECTURE_LINKAGE_V1.md', '온라인강의 링크/과제/시청 관리 기반', '온라인강의 연결 전략');
checkText('docs/PAYMENT_SCOPE_DECISION_V1.md', '더클래스', '더클래스 결제 역할 분리');
checkText('docs/DIRECTOR_EXPLANATION_BRIEF_V1.md', '더오름 내부 운영을 안정화하는', '원장님 설명 브리프');
checkText('docs/PROJECT_HANDOVER.md', 'year-round-product-strategy-v1', '프로젝트 인수인계 상시 운영 전략 반영');
checkText('docs/OPERATIONS_PORTAL_V1.md', 'parent-student portal direction', '운영 포털 학생/학부모 포털 방향 반영');

checkText('docs/STUDENT_TODAY_LINK_V1.md', 'student-today-link-v1', '학생 오늘 링크 문서');
checkText('docs/supabase-student-today-link-v1.sql', 'student_today_links', '학생 오늘 링크 SQL');
checkText('api/rpc.js', "op === 'admin.studentTodayLink.create'", '학생 오늘 링크 생성 API 라우팅');
checkText('api/rpc.js', "op === 'studentToday.publicGet'", '학생 오늘 링크 공개 조회 API 라우팅');
checkText('public/admin.html', 'btnStudentTodayLinkOneClick', '학생 오늘 링크 관리자 버튼');
checkText('public/student-today.html', 'studentToday.publicGet', '학생 오늘 링크 공개 페이지');
checkText('docs/PHONE_IDENTITY_QUALITY_V1.md', 'admin.phoneIdentity.audit', '휴대폰 출결 준비도 문서');
checkText('api/rpc.js', "op === 'admin.phoneIdentity.audit'", '휴대폰 출결 준비도 API 라우팅');
checkText('public/admin.html', 'btnPhoneIdentityAudit', '휴대폰 출결 준비도 UI 버튼');
checkText('scripts/smoke-test.mjs', 'admin.phoneIdentity.audit', '휴대폰 출결 준비도 smoke-test');
checkText('docs/ONLINE_LECTURE_ASSIGNMENT_V1.md', 'online-lecture-assignment-v1', '온라인강의 배정 문서');
checkText('docs/supabase-online-lecture-assignment-v1.sql', 'student_lecture_assignments', '온라인강의 배정 SQL');
checkText('api/rpc.js', "op === 'admin.lectureAssignment.save'", '온라인강의 배정 저장 API 라우팅');
checkText('api/rpc.js', "op === 'admin.lectureAssignment.list'", '온라인강의 배정 조회 API 라우팅');
checkText('public/admin.html', 'btnSaveLectureAssignment', '온라인강의 배정 관리자 UI');
checkText('public/student-today.html', 'lectureBox', '학생 링크 온라인강의 표시 영역');
checkText('scripts/smoke-test.mjs', 'admin.lectureAssignment.list', '온라인강의 배정 smoke-test');


checkText('docs/STAFF_PHONE_MANAGEMENT_V1.md', 'staff-phone-management-v1', '직원 휴대폰 관리 문서');
checkText('docs/supabase-staff-phone-v1.sql', 'staff_phone', '직원 휴대폰 Supabase SQL');
checkText('docs/supabase-staff-phone-v1.sql', 'staff_phone_directory', '직원 휴대폰 directory SQL');
checkText('public/admin.html', 'centralStaffPhone', '중앙DB 직원 휴대폰 입력 UI');
checkText('api/rpc.js', 'patchCentralStaffPhoneMirror', '직원 휴대폰 mirror 반영 서버 함수');
checkText('api/rpc.js', 'upsertStaffPhoneDirectory', '중앙DB 직원 휴대폰 directory upsert');
checkText('scripts/production-qa-runner.mjs', 'TheOreum production QA runner', 'production QA runner');
checkText('docs/PRODUCTION_QA_RUNNER_V1.md', 'production-qa-runner-v1', 'production QA runner 문서');

checkText('docs/KIOSK_VISUAL_QA_V1.md', 'kiosk-visual-qa-v1', '키오스크 시각/입력 QA 문서');
checkText('index.html', 'handlePhoneSegmentKeydown(e, part)', '키오스크 물리 키보드 분할 입력 핸들러');
checkText('scripts/kiosk-input-flow-check.mjs', 'Kiosk input flow static check passed', '키오스크 입력 flow 정적 검사');


checkText('api/rpc.js', 'QA_FEATURE_MATRIX', 'production QA feature matrix');
checkText('api/rpc.js', "op === 'meta.supportedOps'", 'deployment supported ops API');
checkText('scripts/production-qa-runner.mjs', 'deployment parity required ops', 'production QA deployment parity check');
checkText('scripts/production-qa-runner.mjs', 'staleDeploymentHint', 'production QA stale preview hint');
checkText('scripts/smoke-test.mjs', 'page /student-today.html', 'smoke-test student-today static page check');
checkText('scripts/smoke-test.mjs', 'meta.supportedOps', 'smoke-test supported ops check');
checkText('vite.config.js', 'studentToday', 'Vite student-today build input');
checkText('student-today.html', 'studentToday.publicGet', 'root student-today static page');
checkText('docs/PRODUCTION_QA_PARITY_V1.md', 'production-qa-parity-megapatch-v1', 'production QA parity 문서');

checkText('scripts/production-deep-click-qa.mjs', 'TheOreum Production Deep Click QA Report', 'production deep click QA report');
checkText('scripts/production-deep-click-qa.mjs', 'kiosk staff hotword', 'production deep click QA kiosk staff hotword');
checkText('scripts/production-deep-click-qa.mjs', 'phone identity audit UI', 'production deep click QA phone identity UI');
checkText('scripts/production-deep-click-qa.mjs', 'PRODUCTION_DEEP_QA_BUNDLE.zip', 'production deep click QA screenshot bundle');
checkText('scripts/run-production-deep-click-qa.ps1', 'npm install --no-save playwright@1', 'production deep click QA auto Playwright install');
checkText('scripts/copy-last-run-log.ps1', 'PRODUCTION_DEEP_QA_TO_SEND.txt', 'copy-last-log deep QA priority');
checkText('docs/PRODUCTION_DEEP_CLICK_QA_V1.md', 'production-deep-click-qa-v1', 'production deep click QA 문서');
checkText('docs/PHONE_ATTENDANCE_STABILIZATION_V1.md', 'phone-attendance-stabilization-v1', '전화번호 출석화 안정화 문서');

checkText('public/admin.html', 'btnStudentSearchNow', '학생 검색 상단 명시 버튼');
checkText('scripts/production-deep-click-qa.mjs', '#btnStudentSearchNow', 'deep QA 학생 검색 상단 버튼 사용');
checkText('scripts/run-production-deep-click-qa.ps1', 'README_SCREENSHOTS.txt', 'deep QA 스크린샷 번들 안내 파일');
checkText('scripts/copy-last-run-log.ps1', 'PRODUCTION_DEEP_QA_BUNDLE.zip', 'copy-last-log deep QA bundle 경로 안내');
checkText('docs/DEEP_QA_BUNDLE_AND_STUDENT_SEARCH_V1.md', 'deep-qa-bundle-and-student-search-v1', 'deep QA bundle/student search 문서');
checkText('docs/PHONE_ATTENDANCE_FINAL_LOCK_V1.md', 'phone-attendance-final-lock-v1', '전화번호 출석화 최종 잠금 문서');
checkText('docs/supabase-staff-phone-v1.sql', 'enable row level security', '직원 휴대폰 directory RLS 활성화 SQL');
checkText('public/admin.html', 'data-qa-state="idle"', '휴대폰 출결 준비도 QA 상태 속성');
checkText('public/admin.html', "dataset.qaState = 'loaded'", '휴대폰 출결 준비도 UI 로드 완료 상태');
checkText('scripts/production-deep-click-qa.mjs', 'Ignored benign aborted requests', 'deep QA benign abort 분리 보고');
checkText('scripts/production-deep-click-qa.mjs', "state === 'loaded'", 'deep QA phone identity UI loaded state 대기');
checkFile('public/favicon.ico', 'favicon 404 방지 파일');



checkText('scripts/production-deep-click-qa.mjs', 'PRODUCTION_DEEP_QA_BUNDLE_${runId}.zip', 'deep QA timestamped screenshot bundle 생성');
checkText('scripts/production-deep-click-qa.mjs', 'Latest screenshot bundle alias', 'deep QA latest bundle alias 보고서 표기');
checkText('scripts/run-production-deep-click-qa.ps1', 'PRODUCTION_DEEP_QA_BUNDLE_" + $RunId + ".zip', 'PowerShell deep QA timestamped bundle 생성');
checkText('scripts/copy-last-run-log.ps1', 'PRODUCTION_DEEP_QA_BUNDLE_*.zip', 'copy-last-log timestamped deep QA bundle 안내');
checkText('docs/PRODUCTION_DEEP_CLICK_QA_V1.md', 'Timestamped screenshot bundles', 'deep QA timestamped bundle 문서');
checkText('scripts/production-deep-click-qa.mjs', 'PRODUCTION_DEEP_QA_SOURCE_${runId}.zip', 'deep QA timestamped source snapshot 생성');
checkText('scripts/production-deep-click-qa.mjs', 'PRODUCTION_DEEP_QA_PACKAGE_${runId}.zip', 'deep QA full package 생성');
checkText('scripts/production-deep-click-qa.mjs', 'Excluded by design: .env*', 'deep QA source snapshot secret exclusion');
checkText('scripts/copy-last-run-log.ps1', 'PRODUCTION_DEEP_QA_PACKAGE_*.zip', 'copy-last-log deep QA full package 안내');
checkText('docs/DEEP_QA_FULL_PACKAGE_V1.md', 'deep-qa-full-package-v1', 'deep QA full package 문서');


if (failed) {
  console.error(`\nOperational checklist failed: ${failed} issue(s)`);
  process.exit(1);
}


console.log('\nOperational checklist passed.');
