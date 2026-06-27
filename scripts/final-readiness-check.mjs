#!/usr/bin/env node
// Static final readiness contract check for TheOreum 2차 완성본.
// This does not call production APIs; it prevents final-check UI/API drift before deploy.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = p => readFileSync(join(root, p), 'utf8');
let failed = 0;
const ok = msg => console.log('OK', msg);
const fail = msg => { failed += 1; console.error('FAIL', msg); };
const must = (cond, msg) => cond ? ok(msg) : fail(msg);

const rpc = read('api/rpc.js');
const admin = read('public/admin.html');
const smoke = read('scripts/smoke-test.mjs');
const pkg = JSON.parse(read('package.json'));

must(rpc.includes('async function adminFinalReadinessDirect'), 'admin.finalReadiness Direct 함수가 있습니다.');
must(rpc.includes("op === 'admin.finalReadiness'"), 'admin.finalReadiness RPC 라우팅이 있습니다.');
must(rpc.includes("['students', ['student_id', 'student_name', 'student_phone', 'parent_phone']]"), '학생/학부모 연락처 스키마 점검이 있습니다.');
must(rpc.includes("'phone_identity'"), '최종 체크에 휴대폰 출결 준비도 항목이 있습니다.');
must(rpc.includes("['clinic_tasks', ['clinic_task_id'"), '클리닉 필수 컬럼 점검이 있습니다.');
must(rpc.includes("TPL_CLINIC_RESERVATION_PARENT"), '클리닉 알림톡 템플릿 환경변수 점검이 있습니다.');
must(rpc.includes("CLINIC_%"), '클리닉 알림 큐 상태 점검이 있습니다.');

['btnFinalReadiness', 'finalReadinessSummary', 'finalReadinessRows'].forEach(id => {
  must(admin.includes(`id="${id}"`), `최종 체크 UI id ${id}가 있습니다.`);
});
must(admin.includes("rpc('admin.finalReadiness'"), '관리자 화면에서 admin.finalReadiness를 호출합니다.');
must(admin.includes('readinessNextAction'), '최종 체크 다음 조치 문구가 있습니다.');

must(smoke.includes("admin.finalReadiness"), 'live smoke-test가 admin.finalReadiness를 호출합니다.');
must(smoke.includes("admin.phoneIdentity.audit"), 'live smoke-test가 admin.phoneIdentity.audit를 호출합니다.');
must(pkg.scripts?.['final-readiness-check'] === 'node scripts/final-readiness-check.mjs', 'package.json에 final-readiness-check가 등록되어 있습니다.');
must(String(pkg.scripts?.verify || '').includes('final-readiness-check'), 'npm run verify에 final-readiness-check가 포함되어 있습니다.');
must(existsSync(join(root, 'docs/FINAL_READINESS_CHECKLIST.md')), '최종 운영 체크리스트 문서가 있습니다.');

if (failed > 0) {
  console.error(`\nFinal readiness check failed: ${failed} issue(s)`);
  process.exit(1);
}
console.log('\nFinal readiness static check passed.');
