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
  ['staff fast clock buttons', 'btnStaffClockInFast'],
  ['staff hotword global guard', 'bindGlobalStaffHotkeys'],
  ['compact kiosk visual marker', 'kiosk-visual-qa-v1']
];

const forbidden = [
  ['touch keypad container removed', 'id="touchPad"'],
  ['touch keypad digit handlers removed', 'data-touch-digit'],
  ['large single physical input removed', 'kioskPhysicalInputWrap'],
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

if (failed) process.exit(1);
console.log('Kiosk 010 segmented physical-keyboard flow static check passed.');
