import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const required = [
  ['shared segment keydown handler', 'handlePhoneSegmentKeydown(e, part)'],
  ['mid segment keydown bound to shared handler', "phoneMid.addEventListener('keydown', e => Kiosk.handlePhoneSegmentKeydown(e, 'mid'))"],
  ['last segment keydown bound to shared handler', "phoneLast.addEventListener('keydown', e => Kiosk.handlePhoneSegmentKeydown(e, 'last'))"],
  ['phone stabilization marker', 'phone-attendance-stabilization-v1'],
  ['mid accepts first 4 physical digits', "part === 'mid'"],
  ['mid segment manually writes physical digit', "mid.value = (midDigits + key).slice(0, 4)"],
  ['last segment manually writes physical digit', "last.value = (lastDigits + key).slice(0, 4)"],
  ['non-digit route to staff/raw scanner', 'Kiosk.routePhysicalKeyToRawScanner(key)'],
  ['immediate focus handoff', 'safeFocus(last, 0)'],
  ['compact kiosk visual marker', 'kiosk-visual-qa-v1'],
  ['phone row still displays 010', '<span class="phoneStatic">010-</span>'],
  ['phone row still displays dash separator', '<span class="phoneStatic">-</span>']
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

if (/studentSearchTimer:\s*null,[\s\S]*studentSearchTimer:\s*null,/.test(html)) {
  console.error('FAIL duplicate StaffUI studentSearchTimer property remains');
  failed += 1;
} else {
  console.log('OK duplicate StaffUI search timer removed');
}

if (failed) process.exit(1);
console.log('Kiosk input flow static check passed.');
