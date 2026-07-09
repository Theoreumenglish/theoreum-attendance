import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const required = [
  ['visible phone middle segment exists', 'id="kPhoneMid"'],
  ['visible phone last segment exists', 'id="kPhoneLast"'],
  ['010 segmented phone row exists', 'phoneSegmentRow'],
  ['hidden raw scanner input exists', 'id="kInput"'],
  ['kiosk segment autofocus', 'autofocus'],
  ['focus loss guard', "input.addEventListener('blur'"],
  ['focus watchdog keeps segment focus', 'activeIsKioskTarget'],
  ['phone tail segmented submit', 'Kiosk.submitPhoneSegmentsOnEnter()'],
  ['unified kiosk direct endpoint', "case 'kiosk.unified':"],
  ['unified kiosk endpoint path', "return '/api/kiosk-unified'"],
  ['kiosk mark direct endpoint retained', "case 'kiosk.mark':"],
  ['kiosk mark endpoint path retained', "return '/api/kiosk-mark'"],
  ['staff clock direct endpoint path', "return '/api/staff-clock'"],
  ['staff QR direct endpoint path', "return '/api/staff-clock-qr'"],
  ['kiosk runtime split QA marker', '__THEOREUM_KIOSK_RUNTIME_SPLIT_V25__'],
  ['kiosk settings tab restored', 'id="btnKioskSettings"'],
  ['kiosk settings panel exists', 'id="kioskSettingsPanel"'],
  ['kiosk settings PIN local autofill marker', 'data-kiosk-pin-autofill="true"'],
  ['kiosk settings PIN focus marker', 'kioskSettingsPinFocusV29'],
  ['kiosk speed marker', 'kioskSpeedV31'],
  ['kiosk speed runtime marker', '__THEOREUM_KIOSK_SPEED_V31__'],
  ['kiosk autosubmit 20ms', 'queueSubmit(delayMs = 20)'],
  ['kiosk settings focus guard helper', 'function isKioskSettingsOpen()'],
  ['kiosk settings event isolation helper', 'function isInsideKioskSettings(target)'],
  ['kiosk settings PIN event stop propagation', "pinEl.addEventListener(type, event =>"],
  ['kiosk settings local PIN key', 'THEOREUM_KIOSK_SETTINGS_PIN'],
  ['kiosk settings floor 5F action', 'id="btnKioskSetFloor5"'],
  ['kiosk settings floor 7F action', 'id="btnKioskSetFloor7"'],
  ['13-inch staff quick inline marker', 'staff-quick-inline-v28'],
  ['staff quick inline dataset marker', 'data-staff-quick-inline-v28="true"'],
  ['staff quick keeps phone segment visible copy', '번호 입력칸은 계속 보이게 유지됩니다'],
  ['compact kiosk visual marker', 'kiosk-visual-qa-v1'],
  ['kiosk speed v32 runtime marker', '__THEOREUM_KIOSK_SPEED_V32__'],
  ['kiosk speed v32 student hot path', 'student-exact-lookup-plus-parallel-state-notify'],
  ['kiosk speed v32 staff hot path', 'staff-phone-exact-index-first'],
  ['unified kiosk v33 runtime marker', '__THEOREUM_UNIFIED_KIOSK_V33__'],
  ['kiosk fit v34 body marker', 'kioskFitV34'],
  ['kiosk fit v34 runtime marker', '__THEOREUM_KIOSK_FIT_V34__'],
  ['kiosk fit v34 CSS variable', '--kiosk-fit'],
  ['unified kiosk action label in', '등원/출근'],
  ['unified kiosk action label out', '하원/퇴근'],
  ['kiosk settings dedicated endpoint', "case 'kiosk.setFloor':"],
  ['kiosk settings endpoint path', "return '/api/kiosk-settings'"],
];

const forbidden = [
  ['touch keypad container removed', 'id="touchPad"'],
  ['touch keypad digit handlers removed', 'data-touch-digit'],
  ['large single physical input removed', 'kioskPhysicalInputWrap'],
  ['old fixed staff quick bottom overlay removed', 'bottom: 18px;\n        width: min(560px'],
  ['old staff quick translate overlay removed', 'transform: translateX(-50%)'],
  ['visible staff quick opener removed', 'id="btnOpenStaffQuick"'],
  ['invalid scanner pattern removed', 'pattern="[0-9A-Za-z.:-]*"']
];

let failed = 0;
for (const [label, needle] of required) {
  if (html.includes(needle)) {
    console.log(`OK ${label}`);
  } else {
    console.error(`FAIL ${label}: missing ${needle}`);
    failed += 1;
  }
}

for (const [label, needle] of forbidden) {
  if (html.includes(needle)) {
    console.error(`FAIL ${label}: still found ${needle}`);
    failed += 1;
  } else {
    console.log(`OK ${label}`);
  }
}

if (/studentSearchTimer:\s*null,[\s\S]*studentSearchTimer:\s*null,/.test(html)) {
  console.error('FAIL duplicate StaffUI studentSearchTimer property remains');
  failed += 1;
} else {
  console.log('OK duplicate StaffUI search timer removed');
}


// v24: root must be kiosk-only; admin console is not visibly launched from the tablet surface.
if (!html.includes('data-surface="kiosk"') || !html.includes('data-kiosk-surface-lock="true"')) {
  console.error('FAIL kiosk-only root surface markers missing');
  failed += 1;
} else {
  console.log('OK kiosk-only root surface markers');
}
if (/id="navAdmin"|관리자 콘솔<\/button>|location\.href=['"]\/admin\.html/.test(html)) {
  console.error('FAIL visible admin console launcher remains on kiosk root');
  failed += 1;
} else {
  console.log('OK no visible admin console launcher on kiosk root');
}

// v26: kiosk settings tab must exist, but only with kiosk device settings.
const settingsPanelMatch = html.match(/<div\s+id=["']kioskSettingsPanel["'][\s\S]*?<\/div>\s*<\/div>/i);
const settingsPanel = settingsPanelMatch ? settingsPanelMatch[0] : '';
if (!settingsPanel) {
  console.error('FAIL kiosk settings panel markup missing');
  failed += 1;
} else if (/관리자 콘솔|중앙DB|학생 관리|직원 관리|고급 관리자|실패 알림|미등원 즉시|캐시 비우기|알림톡 payload/.test(settingsPanel)) {
  console.error('FAIL kiosk settings panel contains admin/runtime-heavy tools');
  failed += 1;
} else {
  console.log('OK kiosk settings panel is minimal');
}

// v33: kiosk runtime writes should enter the unified endpoint. The unified endpoint can resolve
// student CHECK_IN/CHECK_OUT first and then staff IN/OUT without exposing separate staff UI.
if (/case 'kiosk\.unified':[\s\S]{0,180}return '\/api\/kiosk-unified'/.test(html) && /fetch\(endpoint,/.test(html)) {
  console.log('OK kiosk unified uses dedicated endpoint');
} else {
  console.error('FAIL kiosk unified dedicated endpoint guard missing');
  failed += 1;
}

if (!/__THEOREUM_UNIFIED_KIOSK_V33__/.test(html)) {
  console.error('FAIL unified kiosk v33 marker missing');
  failed += 1;
} else if (/data-unified-kiosk-v33=["']true["']/.test(html)) {
  console.error('FAIL bottom unified kiosk helper text still exists');
  failed += 1;
} else {
  console.log('OK unified kiosk v33 marker without bottom helper text');
}

if (!/kioskFitV34/.test(html) || !/__THEOREUM_KIOSK_FIT_V34__/.test(html) || !/data-kiosk-fit-v34/.test(html)) {
  console.error('FAIL kiosk fit v34 marker missing');
  failed += 1;
} else {
  console.log('OK kiosk fit v34 markers');
}

if (failed) process.exit(1);
console.log('Kiosk 010 segmented physical-keyboard flow static check passed.');
