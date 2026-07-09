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
  ['staff quick phone clock path', "App.rpc('staff.clock'"],
  ['kiosk mark direct endpoint', "case 'kiosk.mark':"],
  ['kiosk mark endpoint path', "return '/api/kiosk-mark'"],
  ['staff clock direct endpoint path', "return '/api/staff-clock'"],
  ['staff QR direct endpoint path', "return '/api/staff-clock-qr'"],
  ['kiosk runtime split QA marker', '__THEOREUM_KIOSK_RUNTIME_SPLIT_V25__'],
  ['kiosk settings tab restored', 'id="btnKioskSettings"'],
  ['kiosk settings panel exists', 'id="kioskSettingsPanel"'],
  ['kiosk settings PIN local autofill marker', 'data-kiosk-pin-autofill="true"'],
  ['kiosk settings local PIN key', 'THEOREUM_KIOSK_SETTINGS_PIN'],
  ['kiosk settings floor 5F action', 'id="btnKioskSetFloor5"'],
  ['kiosk settings floor 7F action', 'id="btnKioskSetFloor7"'],
  ['13-inch staff quick inline marker', 'staff-quick-inline-v28'],
  ['staff quick inline dataset marker', 'data-staff-quick-inline-v28="true"'],
  ['staff quick keeps phone segment visible copy', '번호 입력칸은 계속 보이게 유지됩니다'],
  ['staff fast clock buttons', 'btnStaffClockInFast'],
  ['staff hotword global guard', 'bindGlobalStaffHotkeys'],
  ['compact kiosk visual marker', 'kiosk-visual-qa-v1']
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

// v25: kiosk runtime writes should use dedicated API files rather than the heavy admin RPC bundle.
if (/case 'kiosk\.mark':[\s\S]{0,160}return '\/api\/kiosk-mark'/.test(html) && /fetch\(endpoint,/.test(html)) {
  console.log('OK kiosk mark uses dedicated endpoint');
} else {
  console.error('FAIL kiosk mark dedicated endpoint guard missing');
  failed += 1;
}

if (failed) process.exit(1);
console.log('Kiosk 010 segmented physical-keyboard flow static check passed.');
