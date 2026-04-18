import { approveKioskPinDirect } from '../lib/staff-auth.js';

export async function handleKioskApprovePin(payload) {
  const args = payload?.args && typeof payload.args === 'object' ? payload.args : {};
  const traceId = String(
    payload?.traceId ||
    payload?.trace_id ||
    args?.traceId ||
    args?.trace_id ||
    ('vercel-pin-' + Date.now().toString(36))
  ).trim();

  return await approveKioskPinDirect({
    sessionToken: args.sessionToken || payload?.sessionToken || '',
    pin: args.pin || '',
    student_id: args.student_id || args.sid || ''
  }, traceId);
}