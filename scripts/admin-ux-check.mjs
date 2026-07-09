import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
const apiRpc = readFileSync('api/rpc.js', 'utf8');
const kioskApi = readFileSync('api/kiosk-mark.js', 'utf8');
const kioskUnifiedApi = readFileSync('api/kiosk-unified.js', 'utf8');
const kioskSettingsApi = readFileSync('api/kiosk-settings.js', 'utf8');
const staffClockApi = readFileSync('api/staff-clock.js', 'utf8');
const markupHtml = html.replace(/<!--[\s\S]*?-->/g, '').split('<script>')[0];
let failed = 0;
function ok(message) { console.log('OK', message); }
function fail(message) { failed += 1; console.error('FAIL', message); }
function count(re, text = html) { return Array.from(text.matchAll(re)).length; }
function sectionById(id) {
  const re = new RegExp(`<section\\b(?=[^>]*\\bid=["']${id}["'])[\\s\\S]*?(?=<section\\b|<script>|</main>)`, 'i');
  const m = html.match(re);
  return m ? m[0] : '';
}
function divById(id) {
  const re = new RegExp(`<div\\b(?=[^>]*\\bid=["']${id}["'])[\\s\\S]*?(?=<div\\b[^>]*\\bid=["'][^"']+["']|<section\\b|<script>|</body>)`, 'i');
  const m = html.match(re);
  return m ? m[0] : '';
}
function stripDetails(text) { return text.replace(/<details\b[\s\S]*?<\/details>/gi, ''); }
function buttonTextPresent(text, label) {
  const compact = text.replace(/\s+/g, ' ');
  return compact.includes(`>${label}<`) || compact.includes(`> ${label} <`);
}

const login = divById('loginView');
if (!login) fail('loginView 영역을 찾지 못했습니다.');
else {
  const loginButtons = count(/<button\b/g, login);
  const loginInputs = count(/<input\b/g, login);
  if (loginButtons !== 1) fail(`로그인 화면 버튼은 1개여야 합니다. 현재 ${loginButtons}개입니다.`);
  else ok('로그인 화면 버튼이 1개입니다.');
  if (loginInputs !== 2) fail(`로그인 입력칸은 직원 ID/비밀번호 2개여야 합니다. 현재 ${loginInputs}개입니다.`);
  else ok('로그인 입력칸이 2개입니다.');
  const requiredCopy = ['직원 로그인', '직원 ID', '비밀번호'];
  const missingCopy = requiredCopy.filter(item => !login.includes(item));
  if (missingCopy.length) fail(`로그인 화면에 필요한 안내가 빠졌습니다: ${missingCopy.join(', ')}`);
  else ok('로그인 화면에 필요한 안내 문구가 있습니다.');
  if (/감사 로그로 추적|Information Flow|운영 철학|마케팅/.test(login)) fail('로그인 화면에 업무와 무관한 설명 문구가 남아 있습니다.');
  else ok('로그인 화면에서 불필요한 설명 문구를 제거했습니다.');
}

const side = html.match(/<aside\b[\s\S]*?<\/aside>/i)?.[0] || '';
if (!side) fail('사이드 메뉴 영역을 찾지 못했습니다.');
else {
  if (/<details\b/.test(side)) fail('사이드 메뉴는 접지 않고 항상 보여야 합니다. details가 남아 있습니다.');
  else ok('사이드 메뉴는 숨기지 않고 전체 노출됩니다.');
  const navButtons = count(/<button\b(?=[^>]*\bdata-go=)/g, side);
  if (navButtons !== 10) fail(`사이드 메뉴는 오늘/학생/출결/클리닉/단어/문자/클래스/리포트/직원/설정 10개여야 합니다. 현재 ${navButtons}개입니다.`);
  else ok('사이드 메뉴 10개가 모두 보입니다.');
}

const quickDock = html.match(/<div\b(?=[^>]*\bid=["']quickDock["'])[\s\S]*?(?=<section\b)/i)?.[0] || '';
if (!quickDock) fail('quickDock 영역을 찾지 못했습니다.');
else {
  const quickButtons = count(/<button\b/g, quickDock);
  if (quickButtons > 5) fail(`상단 빠른 처리 영역 버튼은 검색 포함 5개 이하여야 합니다. 현재 ${quickButtons}개입니다.`);
  else ok(`상단 빠른 처리 영역 버튼이 ${quickButtons}개입니다.`);
}

const thresholds = {
  dashboard: 4,
  students: 6,
  attendance: 3,
  clinic: 5,
  words: 6,
  messages: 4
};
for (const [id, maxButtons] of Object.entries(thresholds)) {
  const section = sectionById(id);
  if (!section) { fail(`${id} 화면을 찾지 못했습니다.`); continue; }
  const directButtons = count(/<button\b/g, stripDetails(section));
  if (directButtons > maxButtons) fail(`${id} 화면의 직접 노출 버튼이 많습니다. 최대 ${maxButtons}개, 현재 ${directButtons}개입니다.`);
  else ok(`${id} 화면 직접 노출 버튼 ${directButtons}개로 정리됐습니다.`);
}

const todayBoard = sectionById('dashboard');
if (!todayBoard.includes('data-today-priority-board="true"')) fail('오늘 화면에 자동 업무 우선순위 보드가 없습니다.');
else ok('오늘 화면에 자동 업무 우선순위 보드가 있습니다.');
if (!todayBoard.includes('todayAbsenceRows')) fail('오늘 화면에 출석 안 한 학생 목록이 없습니다.');
else ok('오늘 화면에 출석 안 한 학생 목록이 있습니다.');
if (!html.includes('today-auto-ops-v18')) fail('오늘 화면이 정적 소개 셸 대신 자동 업무판을 보이도록 잠금 처리되지 않았습니다.');
else ok('오늘 화면 자동 업무판 표시 잠금이 있습니다.');

if (!todayBoard.includes('data-today-staff-todo-v19="true"') || !todayBoard.includes('data-today-clean-v20="true"') || !todayBoard.includes('data-today-labels-v21="true"') || !todayBoard.includes('data-today-clean-v22="true"') || !todayBoard.includes('data-today-clean-v23="true"')) fail('오늘 화면이 설명을 줄인 v23 실무형 보드가 아닙니다.');
else ok('오늘 화면은 v23 실무형 보드입니다.');
if (!todayBoard.includes('data-today-worker-summary="true"')) fail('오늘 화면에 긴급/마감/확인필요 요약 카운터가 없습니다.');
else ok('오늘 화면에 직원 업무 요약 카운터가 있습니다.');
if (!html.includes('today-clean-task-board-v20') || !html.includes('today-clean-task-board-v21') || !html.includes('today-clean-task-board-v22') || !html.includes('today-task-board-v23')) fail('오늘의 업무 탭을 깔끔하게 줄이는 v23 CSS 잠금이 없습니다.');
else ok('오늘의 업무 탭 v23 정리 CSS가 있습니다.');
if (/다음 행동:|처리 기준|숫자가 뜬 항목부터|조교·강사가 오늘 놓치면/.test(todayBoard)) fail('오늘 화면에 설명 문구가 과하게 남아 있습니다.');
else ok('오늘 화면 설명 문구를 제거했습니다.');
if (!html.includes('data-abs-clinic')) fail('출석 안 한 학생 행에서 바로 클리닉으로 이동하는 액션이 없습니다.');
else ok('출석 안 한 학생 행에 클리닉 바로 처리 액션이 있습니다.');
if (!html.includes('data-abs-copy-student') || !html.includes('data-abs-copy-parent')) fail('미등원 행의 번호 복사가 학생/학부모로 분리되어 있지 않습니다.');
else ok('미등원 행의 번호 복사가 학생/학부모로 분리되어 있습니다.');
if (todayBoard.includes('data-daily-task="word"')) fail('오늘의 업무에 애매한 단어 카드가 남아 있습니다.');
else ok('오늘의 업무에서 애매한 단어 카드를 제거했습니다.');
if (!todayBoard.includes('todayDateTools') || !todayBoard.includes('todayRefreshAction')) fail('오늘의 업무 날짜/업데이트 UI가 정리되어 있지 않습니다.');
else ok('오늘의 업무 날짜/업데이트 UI를 정리했습니다.');
if (!apiRpc.includes('OFFLINE_CLINIC') || !apiRpc.includes('offline_clinic_missing_count')) fail('오프라인 클리닉 미등원이 오늘의 업무 미등원 보드에 포함되지 않습니다.');
else ok('오프라인 클리닉 미등원을 오늘의 업무에 포함합니다.');
if (!/학생 번호 복사|학부모 번호 복사|학생 정보|클리닉 추가|출결 처리/.test(html)) fail('미등원 행 작업 버튼명이 명확하지 않습니다.');
else ok('미등원 행 작업 버튼명을 명확하게 바꿨습니다.');
if (/data-abs-quick-excuse-class|>지각 연락<|>출결 입력<|<summary class="miniAction">번호 복사<\/summary>/.test(todayBoard)) fail('오늘 미등원 행에 오래된 지각/입력/드롭다운 버튼이 남아 있습니다.');
else ok('오늘 미등원 행에서 오래된 지각/입력/드롭다운 버튼을 제거했습니다.');
if (/id="btnTodayAbsenceAuto"[^>]*>자동 ON<|data-daily-task="student"[\s\S]*id="dailyStudentState"/.test(todayBoard)) fail('오늘 화면에 자동 ON 또는 학생 선택 카드가 남아 있습니다.');
else ok('오늘 화면에서 자동 ON/학생 선택 카드를 제거했습니다.');
if (todayBoard.includes('<span>예외</span>')) fail('오늘 미등원 통계에 예외라는 오래된 표현이 남아 있습니다.');
else ok('오늘 미등원 통계에서 예외 표현을 제거했습니다.');

if (!html.includes('__THEOREUM_ADMIN_BOOT_LAZY_READINESS_V30__')) fail('관리자 부팅 최적화 v30 마커가 없습니다.');
else ok('관리자 부팅 최적화 v30 마커가 있습니다.');
if (!html.includes('__THEOREUM_STAFF_SAVE_SPEED_V31__') || !html.includes("afterSaveReload: 'background'")) fail('직원 저장 후 백그라운드 갱신 v31 마커가 없습니다.');
else ok('직원 저장 후 백그라운드 갱신 v31 마커가 있습니다.');
if (/setTimeout\(\(\) => \{ loadClassCatalog\(\); loadStaffCatalog\(\); \}, 0\)/.test(html)) fail('로그인 직후 직원 목록을 자동 로드하고 있습니다. 직원 목록은 필요할 때만 불러와야 합니다.');
else ok('로그인 직후 직원 목록 자동 로드를 제거했습니다.');
if (!html.includes('로그인 직후 자동 실행하지 않습니다. 필요할 때만 최종 체크 실행을 누르세요.')) fail('최종 운영 체크가 온디맨드 실행임을 안내하지 않습니다.');
else ok('최종 운영 체크를 온디맨드 실행으로 안내합니다.');

if (/body\.opsFlowV3\[data-current-view="dashboard"\]\s+#dashboard\s*\{\s*display:\s*none\s*!important;\s*\}/.test(html)) fail('오늘 화면 #dashboard가 CSS로 숨겨져 있습니다.');
else ok('오늘 화면 #dashboard는 숨김 처리되어 있지 않습니다.');
if (!/body\.opsFlowV3\[data-current-view="dashboard"\]\s+\.calmOpsShell\s*\{\s*display:\s*none\s*!important;/.test(html)) fail('정적 calmOpsShell이 오늘 화면에서 숨겨지지 않았습니다.');
else ok('정적 calmOpsShell은 오늘 화면에서 숨겨집니다.');

const students = sectionById('students');
if (/단어 재시험|독해 오답|숙제 미완료|출결 상담|보강 필요/.test(students)) fail('학생 화면에 클리닉 프리셋 버튼이 남아 있습니다.');
else ok('학생 화면에서 클리닉 프리셋 버튼을 제거했습니다.');

const staff = sectionById('staff');
const staffOnlyIds = ['staffManualStaffId', 'centralStaffId', 'centralStaffPhone'];
for (const staffId of staffOnlyIds) {
  if (!staff.includes(`id="${staffId}"`)) fail(`${staffId}가 직원 화면 #staff 내부에 없습니다.`);
  else ok(`${staffId}가 직원 화면 #staff 내부에 있습니다.`);
}
if (!html.includes('data-section-scope="staff"')) fail('직원 전용 카드에 data-section-scope="staff" 안전장치가 없습니다.');
else ok('직원 전용 카드에 data-section-scope="staff" 안전장치를 부여했습니다.');
if (!html.includes('function repairStaffSectionScope')) fail('직원 카드 DOM 누수 복구용 repairStaffSectionScope()가 없습니다.');
else ok('직원 카드 DOM 누수 복구용 repairStaffSectionScope()가 있습니다.');
if (staff.indexOf('id="staffManualStaffId"') < 0 || staff.indexOf('id="staffManualStaffId"') > staff.lastIndexOf('</section>')) {
  fail('직원 수기 입력 카드가 staff section 밖으로 새는 구조입니다.');
}
['dashboard', 'students', 'advanced'].forEach(sectionId => {
  const area = sectionById(sectionId);
  const leaked = staffOnlyIds.filter(staffId => area.includes(`id="${staffId}"`));
  if (leaked.length) fail(`${sectionId} 화면에 직원 전용 입력칸이 섞였습니다: ${leaked.join(', ')}`);
  else ok(`${sectionId} 화면에는 직원 전용 입력칸이 없습니다.`);
});

const clinic = sectionById('clinic');
if (/data-quick-clinic|data-clinic-filter/.test(clinic)) fail('클리닉 화면에 프리셋/필터 버튼이 과도하게 남아 있습니다.');
else ok('클리닉 화면은 생성/조회 중심으로 단순화됐습니다.');

const words = sectionById('words');
if (/data-word-score-save|data-word-status-save|100점 저장|95점 저장|90점 저장|80점 저장/.test(words)) fail('단어시험 화면에 점수 프리셋 버튼이 남아 있습니다.');
else ok('단어시험 화면에서 점수 프리셋 버튼을 제거했습니다.');
if (!/Enter.*저장/.test(words)) fail('단어시험 맞은 개수 입력의 Enter 저장 안내가 없습니다.');
else ok('단어시험 맞은 개수 입력에 Enter 저장 안내가 있습니다.');

if (html.includes('id="qrCenter"')) fail('QR Center는 별도 메뉴/화면으로 두지 않고 출결 화면 안에서 처리해야 합니다.');
else ok('QR Center가 출결 화면 안으로 정리됐습니다.');

if (!html.includes('학부모 전달 문구')) fail('리포트에 학부모 전달 문구 영역이 없습니다.');
else ok('리포트 문구가 학부모 전달용으로 정리됐습니다.');

if (!html.includes('dashboard-focus-v10')) fail('대시보드 검색/자동화/전체메뉴 숨김 안전장치가 없습니다.');
else ok('대시보드 검색/자동화/전체메뉴 숨김 안전장치가 있습니다.');

if (!html.includes('function countLike')) fail('대시보드 숫자/상태 요약용 countLike 방어 함수가 없습니다.');
else ok('대시보드 숫자/상태 요약용 countLike 방어 함수가 있습니다.');
if (/PENDING '\s*\+ \(queue\.pending_all \?\? 0\)/.test(html)) fail('대시보드 상태 메모가 pending_all 객체를 직접 문자열로 붙입니다.');
else ok('대시보드 상태 메모가 pending_all 객체를 직접 노출하지 않습니다.');
if (html.includes("? overview.clinic.open_today : '보기'") || html.includes("? overview.word.today_sessions : '입력'")) fail('오늘 요약 카드의 큰 숫자 영역에 보기/입력 문구가 들어갑니다.');
else ok('오늘 요약 카드의 큰 숫자 영역은 숫자 중심으로 표시됩니다.');

const totalButtons = count(/<button\b/g, markupHtml);
if (totalButtons > 99) fail(`전체 버튼 수가 아직 과도합니다. 현재 ${totalButtons}개입니다.`);
else ok(`전체 버튼 수 ${totalButtons}개로 정리됐습니다. 직원 휴대폰만 저장/학부모 fallback 버튼 추가로 허용 상한을 99개로 조정했습니다.`);


// kiosk-admin-surface-split-v24: public kiosk and internal admin console must stay separated.
const kioskHtml = readFileSync('index.html', 'utf8');
if (!kioskHtml.includes('data-surface="kiosk"') || !kioskHtml.includes('data-kiosk-surface-lock="true"')) fail('index.html에 키오스크 전용 surface 잠금 마커가 없습니다.');
else ok('키오스크 전용 surface 잠금 마커가 있습니다.');
if (/id="navAdmin"|관리자 콘솔<\/button>|location\.href=['"]\/admin\.html/.test(kioskHtml)) fail('키오스크 루트에 관리자 콘솔 진입 버튼이 남아 있습니다.');
else ok('키오스크 루트에서 관리자 콘솔 진입 버튼을 제거했습니다.');
if (!html.includes('data-surface="admin-console"') || !html.includes('키오스크 새 창')) fail('관리자 콘솔 surface 마커 또는 키오스크 새 창 링크가 없습니다.');
else ok('관리자 콘솔 surface 마커와 키오스크 새 창 링크가 있습니다.');

if (!kioskHtml.includes('__THEOREUM_KIOSK_RUNTIME_SPLIT_V25__') || !kioskHtml.includes("return '/api/kiosk-unified'") || !kioskHtml.includes("return '/api/kiosk-settings'") || !kioskHtml.includes("return '/api/staff-clock'")) fail('키오스크 런타임/API 분리 마커 또는 전용 endpoint가 없습니다.');
else ok('키오스크 런타임/API 분리 마커와 전용 endpoint가 있습니다.');
if (!kioskHtml.includes('__THEOREUM_KIOSK_SPEED_V31__') || !kioskHtml.includes('queueSubmit(delayMs = 20)')) fail('키오스크 고속 입력 v31 마커 또는 20ms autosubmit이 없습니다.');
else ok('키오스크 고속 입력 v31 마커가 있습니다.');
if (!kioskHtml.includes('id="btnKioskSettings"') || !kioskHtml.includes('id="kioskSettingsPanel"')) fail('키오스크 설정 탭 또는 설정 패널이 없습니다.');
else ok('키오스크 설정 탭을 유지했습니다.');
const kioskSettingsPanel = (kioskHtml.match(/<div\s+id=["']kioskSettingsPanel["'][\s\S]*?<\/div>\s*<\/div>/i) || [''])[0];
if (/중앙DB|학생 관리|직원 관리|고급 관리자|실패 알림|미등원 즉시|캐시 비우기|알림톡 payload/.test(kioskSettingsPanel)) fail('키오스크 설정 패널에 관리자/무거운 기능이 남아 있습니다.');
else ok('키오스크 설정 패널은 층 설정 중심으로 정리되었습니다.');

if (!kioskApi.includes('phoneTailLookupCandidates') || !kioskApi.includes('KIOSK_PRESELECT_TRACE')) fail('키오스크 서버 hot path v31 최적화가 없습니다.');
else ok('키오스크 서버 hot path v31 최적화가 있습니다.');

if (!kioskApi.includes('parallel_state_notify_v32')) fail('kiosk-mark v32 병렬 상태/알림 hot path marker가 없습니다.');
else ok('kiosk-mark v32 병렬 상태/알림 hot path marker가 있습니다.');

if (!staffClockApi.includes('staff_phone_exact_index_v32')) fail('staff-clock v32 직원 전화번호 exact-index marker가 없습니다.');
else ok('staff-clock v32 직원 전화번호 exact-index marker가 있습니다.');

if (!staffClockApi.includes('readStaffExactRowsForPhoneClock')) fail('staff-clock v32 exact indexed lookup helper가 없습니다.');
else ok('staff-clock v32 exact indexed lookup helper가 있습니다.');

if (!kioskHtml.includes('__THEOREUM_UNIFIED_KIOSK_V33__')) fail('통합 키오스크 v33 마커가 없습니다.');
else ok('통합 키오스크 v33 마커가 있습니다.');
if (kioskHtml.includes('data-unified-kiosk-v33="true"')) fail('키오스크 하단 통합 안내 문구가 아직 남아 있습니다.');
else ok('키오스크 하단 통합 안내 문구가 제거되었습니다.');
if (!kioskHtml.includes('kioskFitV34') || !kioskHtml.includes('__THEOREUM_KIOSK_FIT_V34__') || !kioskHtml.includes('data-kiosk-fit-v34')) fail('키오스크 화면 자동 맞춤 v34 마커가 없습니다.');
else ok('키오스크 화면 자동 맞춤 v34 마커가 있습니다.');
if (!kioskUnifiedApi.includes('handleKioskMark') || !kioskUnifiedApi.includes('handleStaffClock') || !kioskUnifiedApi.includes('unified_staff_fallback_v33')) fail('kiosk-unified v33 학생/직원 통합 endpoint가 없습니다.');
else ok('kiosk-unified v33 학생/직원 통합 endpoint가 있습니다.');
if (!kioskSettingsApi.includes('kiosk_settings_pin_no_admin_session_v33') || !kioskSettingsApi.includes('writeRuntimeConfig')) fail('kiosk-settings v33 PIN 기반 층 설정 endpoint가 없습니다.');
else ok('kiosk-settings v33 PIN 기반 층 설정 endpoint가 있습니다.');
if (!html.includes('centralStaffOnlyPhoneChanged') || !html.includes('admin.central.staff.phoneOnly')) fail('직원 휴대폰만 변경 시 phoneOnly 저장 경로가 없습니다.');
else ok('직원 휴대폰만 변경 시 phoneOnly 저장 경로가 있습니다.');


if (!html.includes('data-today-task-state-v35="true"') || !html.includes('data-abs-task-state') || !html.includes('todayTaskStateBadge')) fail('오늘의 업무 처리상태 v35 UI가 없습니다.');
else ok('오늘의 업무 처리상태 v35 UI가 있습니다.');
if (!html.includes('data-today-task-state-v36="compact-menu"') || !html.includes('todayTaskStateMenu') || !html.includes('today-task-state-compact-v36')) fail('오늘의 업무 처리상태 v36 compact menu UI가 없습니다.');
else ok('오늘의 업무 처리상태 v36 compact menu UI가 있습니다.');
if (!apiRpc.includes('assistant.setTodayTaskState') || !apiRpc.includes('today-task-state-v35') || !apiRpc.includes('today_task_state_')) fail('오늘의 업무 처리상태 v35 API/runtime_config 저장 경로가 없습니다.');
else ok('오늘의 업무 처리상태 v35 API/runtime_config 저장 경로가 있습니다.');

if (failed > 0) {
  console.error('');
  console.error(`Admin UX check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('');
console.log('Admin UX check passed.');
