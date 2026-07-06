import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
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

const totalButtons = count(/<button\b/g, markupHtml);
if (totalButtons > 99) fail(`전체 버튼 수가 아직 과도합니다. 현재 ${totalButtons}개입니다.`);
else ok(`전체 버튼 수 ${totalButtons}개로 정리됐습니다. 직원 휴대폰만 저장/학부모 fallback 버튼 추가로 허용 상한을 99개로 조정했습니다.`);

if (failed > 0) {
  console.error('');
  console.error(`Admin UX check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('');
console.log('Admin UX check passed.');
