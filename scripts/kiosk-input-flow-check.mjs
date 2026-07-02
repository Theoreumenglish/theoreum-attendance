import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const required = [
  ['physical keyboard input class', 'kioskPhysicalInput'],
  ['single raw kiosk input exists', 'id="kInput"'],
  ['kiosk input autofocus', 'autofocus'],
  ['focus loss guard', "input.addEventListener('blur'"],
  ['focus watchdog prefers raw input', 'activeIsKioskInput'],
  ['phone tail raw input submit', 'Kiosk.shouldSubmitPhoneTail8(v)'],
  ['enter submits physical input', 'Kiosk.submitPhoneSegmentsOnEnter()'],
  ['staff clock visible opener', 'btnOpenStaffQuick'],
  ['staff quick phone clock path', "App.rpc('staff.clock'"],
  ['compact kiosk visual marker', 'kiosk-visual-qa-v1']
];

const forbidden = [
  ['touch keypad container removed', 'id="touchPad"'],
  ['touch keypad digit handlers removed', 'data-touch-digit'],
  ['visible phone mid input removed', 'id="kPhoneMid"'],
  ['visible phone last input removed', 'id="kPhoneLast"']
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
console.log('Kiosk physical keyboard flow static check passed.');
