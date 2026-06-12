import { readFileSync } from 'node:fs';

const html = readFileSync('public/admin.html', 'utf8');
const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');
const markupHtml = visibleHtml.split('<script>')[0];
let failed = 0;
function ok(message) { console.log('OK', message); }
function fail(message) { failed += 1; console.error('FAIL', message); }
function sectionBetween(start, end) {
  const s = html.indexOf(start);
  if (s < 0) return '';
  const e = html.indexOf(end, s + start.length);
  return e < 0 ? html.slice(s) : html.slice(s, e);
}
function count(re, text = html) {
  return Array.from(text.matchAll(re)).length;
}
function has(text) { return html.includes(text); }

const login = sectionBetween('<div id="loginView"', '<div id="appView"');
const quickDock = sectionBetween('<div class="quickDock"', '<section class="portalView active" id="dashboard"');
const dashboard = sectionBetween('<section class="portalView active" id="dashboard"', '<section class="portalView" id="attendance"');

if (!login) fail('loginView 영역을 찾지 못했습니다.');
else {
  const loginButtons = count(/<button\b/g, login);
  const loginInputs = count(/<input\b/g, login);
  if (loginButtons !== 1) fail(`로그인 화면 버튼은 1개여야 합니다. 현재 ${loginButtons}개입니다.`);
  else ok('로그인 화면 버튼이 1개입니다.');
  if (loginInputs !== 2) fail(`로그인 입력칸은 직원 ID/비밀번호 2개여야 합니다. 현재 ${loginInputs}개입니다.`);
  else ok('로그인 입력칸이 2개입니다.');
  if (/loginPoints|오늘 운영을|감사 로그로 추적|Operations Portal/.test(login)) fail('로그인 화면에 설명/마케팅 문구가 남아 있습니다.');
  else ok('로그인 화면에서 불필요한 설명 문구를 제거했습니다.');
}

const primaryNav = html.match(/<nav class="sideNav primaryNav"[\s\S]*?<\/nav>/)?.[0] || '';
const primaryNavButtons = count(/<button\b/g, primaryNav);
if (primaryNavButtons !== 5) fail(`핵심 사이드 메뉴는 5개여야 합니다. 현재 ${primaryNavButtons}개입니다.`);
else ok('핵심 사이드 메뉴가 5개입니다.');

if (!has('<details class="moreNav">')) fail('보조 메뉴 moreNav details가 없습니다.');
else ok('보조 메뉴는 접힌 더 보기로 분리했습니다.');

if (!quickDock) fail('quickDock 영역을 찾지 못했습니다.');
else {
  const quickButtons = count(/<button\b/g, quickDock);
  if (quickButtons !== 5) fail(`상단 빠른 처리 영역 버튼은 검색 포함 5개여야 합니다. 현재 ${quickButtons}개입니다.`);
  else ok('상단 빠른 처리 영역이 검색 포함 5버튼으로 정리됐습니다.');
  const noisyIds = ['btnQuickFailedAbsent', 'btnQuickClinicCandidates', 'btnQuickWordToday'];
  const foundNoisy = noisyIds.filter(id => quickDock.includes(`id="${id}"`));
  if (foundNoisy.length) fail(`상단에 세부 필터 버튼이 남아 있습니다: ${foundNoisy.join(', ')}`);
  else ok('상단에는 세부 필터 버튼을 노출하지 않습니다.');
}

if (!dashboard) fail('dashboard 영역을 찾지 못했습니다.');
else {
  const dashboardButtons = count(/<button\b/g, dashboard);
  if (dashboardButtons > 4) fail(`홈 화면 버튼은 4개 이하여야 합니다. 현재 ${dashboardButtons}개입니다.`);
  else ok(`홈 화면 버튼 수가 ${dashboardButtons}개로 제한되어 있습니다.`);
  if (dashboard.includes('commandGrid') || dashboard.includes('오늘 처리 흐름') || dashboard.includes('Information Flow')) {
    fail('홈 화면에 이전 설명형 보드/태그가 남아 있습니다.');
  } else {
    ok('홈 화면에서 설명형 보드와 태그를 제거했습니다.');
  }
}

const totalButtons = count(/<button\b/g, markupHtml);
if (totalButtons > 84) fail(`전체 버튼 수가 과도합니다. 현재 ${totalButtons}개입니다.`);
else ok(`전체 버튼 수 ${totalButtons}개로 이전보다 줄었습니다.`);

if (failed > 0) {
  console.error('');
  console.error(`Admin UX check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('');
console.log('Admin UX check passed.');
