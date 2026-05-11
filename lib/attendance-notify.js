import crypto from 'node:crypto';

function env(name, fallback = '') {
  return String(process.env[name] || fallback || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function fmtMonthDayKo(date = new Date()) {
  const d = new Date(date);

  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(d);

  const month = parts.find(part => part.type === 'month')?.value || String(d.getMonth() + 1);
  const day = parts.find(part => part.type === 'day')?.value || String(d.getDate());

  return month + '월 ' + day + '일';
}

function normPhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').trim();
}

function ncpBaseUrl() {
  return env('NCP_SENS_BASE_URL', 'https://sens.apigw.ntruss.com').replace(/\/+$/, '');
}

function ncpFrom() {
  return env('NCP_SENS_FROM') || env('NCP_CALLER');
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function smsTypeForContent(content) {
  return utf8ByteLength(content) > 90 ? 'LMS' : 'SMS';
}

function smsSubjectForContent(content) {
  return smsTypeForContent(content) === 'LMS'
    ? '더오름영어 출결 안내'
    : '';
}

function ynEnv(name, fallback = 'N') {
  return env(name, fallback).toUpperCase() === 'Y';
}

function ynEnvWithGlobalFallback(name, fallbackName = 'USE_SMS_FAILOVER') {
  const own = env(name);
  if (own) return own.toUpperCase() === 'Y';
  return ynEnv(fallbackName, 'N');
}

function buildAttendanceTemplateText(student, kind, when = new Date()) {
  const studentLine = [
    String(student?.school || '').trim(),
    String(student?.grade || '').trim(),
    String(student?.student_name || '').trim()
  ].filter(Boolean).join(' ');

  const subjectLine = studentLine ? (studentLine + ' 학생이 ') : '학생이 ';

  return '[더오름영어 출결 안내]\n' +
    '안녕하세요 더오름영어 입니다.\n' +
    subjectLine + fmtMonthDayKo(when) + ' ' + kind + '하였습니다.\n' +
    '감사합니다.';
}

async function sendNcpRequest(path, bodyObj) {
  const accessKey = env('NCP_ACCESS_KEY');
  const secretKey = env('NCP_SECRET_KEY');

  if (!accessKey || !secretKey) {
    return {
      ok: false,
      code: 0,
      error: 'NCP 키 누락',
      debug: {
        path,
        hasAccessKey: !!accessKey,
        hasSecretKey: !!secretKey
      }
    };
  }

  const url = ncpBaseUrl() + path;
  const method = 'POST';
  const timestamp = String(Date.now());
  const message = method + ' ' + path + '\n' + timestamp + '\n' + accessKey;
  const signature = crypto
    .createHmac('sha256', Buffer.from(secretKey, 'utf8'))
    .update(Buffer.from(message, 'utf8'))
    .digest('base64');

  const requestBody = JSON.stringify(bodyObj);
  const controller = new AbortController();
  const timeoutMs = Number(env('NCP_REQUEST_TIMEOUT_MS', '4000')) || 4000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': accessKey,
        'x-ncp-apigw-signature-v2': signature
      },
      body: requestBody,
      cache: 'no-store',
      signal: controller.signal
    });

    const text = await resp.text();

    return {
      ok: resp.status >= 200 && resp.status < 300,
      code: resp.status,
      body: text,
      error: resp.status >= 200 && resp.status < 300 ? '' : text,
      debug: {
        url,
        path,
        timestamp,
        requestBody
      }
    };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      ok: false,
      code: 0,
      error: aborted ? 'NCP 요청 시간 초과' : (e?.message || String(e)),
      debug: {
        url,
        path,
        timestamp,
        requestBody
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendSmsOne(to, content) {
  const svc = env('NCP_SMS_SERVICE_ID');
  const from = ncpFrom();
  const text = String(content || '');
  const type = smsTypeForContent(text);
  const subject = smsSubjectForContent(text);

  if (!svc || !from) {
    return {
      ok: false,
      code: 0,
      error: 'SMS 설정 누락',
      body: '',
      debug: { svc, from }
    };
  }

  const path = '/sms/v2/services/' + svc + '/messages';
  const body = {
    type,
    from,
    content: text,
    messages: [{ to: String(to) }]
  };

  if (subject) {
    body.subject = subject;
  }

  return await sendNcpRequest(path, body);
}

async function sendAlimtalkOne(to, content, templateCode) {
  const svc = env('NCP_ALIMTALK_SERVICE_ID');
  const tpl = String(templateCode || '').trim();

  if (!svc || !tpl) {
    return { ok: false, code: 0, error: '알림톡 설정 누락', body: '', debug: { svc, tpl } };
  }

  const plusFriendId = env('NCP_PLUS_FRIEND_ID');
  const from = ncpFrom();
  const useFailover = env('USE_SMS_FAILOVER', 'N').toUpperCase() === 'Y';

  const path = '/alimtalk/v2/services/' + svc + '/messages';
  const body = {
    templateCode: tpl,
    messages: [{
      to: String(to || ''),
      content: String(content || ''),
      countryCode: '82'
    }]
  };

  if (plusFriendId) body.plusFriendId = plusFriendId;

  if (useFailover && from) {
    body.messages[0].useSmsFailover = true;
    body.messages[0].failoverConfig = {
      type: 'SMS',
      from,
      content: String(content || '')
    };
  }

  return await sendNcpRequest(path, body);
}

export async function notifyParentOnAttendanceDirect(student, actionType, traceId, occurredAt = '') {
  const attNotify = env('ATT_NOTIFY_PARENTS', 'N').toUpperCase() === 'Y';
  if (!attNotify) {
    return {
      attempted: false,
      ok: true,
      channel: '',
      error: '',
      reason: 'ATT_NOTIFY_PARENTS_OFF'
    };
  }

  const to = normPhone(student?.parent_phone);
  if (!to) {
    return {
      attempted: false,
      ok: false,
      channel: '',
      error: '학부모 전화번호 없음',
      reason: 'NO_PARENT_PHONE'
    };
  }

  const action = String(actionType || '').trim().toUpperCase();
  if (action !== 'CHECK_IN' && action !== 'CHECK_OUT') {
    return {
      attempted: false,
      ok: false,
      channel: '',
      error: '출결 알림은 CHECK_IN / CHECK_OUT만 허용됩니다.',
      reason: 'INVALID_ACTION'
    };
  }

  const kind = action === 'CHECK_IN' ? '등원' : '하원';
  const occurredMs = Date.parse(String(occurredAt || '').trim());
  const when = Number.isFinite(occurredMs) ? new Date(occurredMs) : new Date();
  const msg = buildAttendanceTemplateText(student, kind, when);
  const tpl = env('TPL_ATTENDANCE');

  let result = {
    attempted: true,
    ok: false,
    channel: '',
    error: '',
    to,
    kind,
    traceId,
    at: nowIso()
  };

  const allowSmsAfterAlimFail =
    ynEnvWithGlobalFallback('ATT_NOTIFY_SMS_AFTER_ALIM_FAIL', 'USE_SMS_FAILOVER');
  const allowSmsWithoutTemplate =
    ynEnv('ATT_NOTIFY_SMS_WITHOUT_TEMPLATE', 'N');

  if (tpl) {
    const alim = await sendAlimtalkOne(to, msg, tpl);
    if (alim.ok) {
      result.ok = true;
      result.channel = 'ALIMTALK';
      return result;
    }

    result.error = alim.error || '알림톡 실패';

    if (!allowSmsAfterAlimFail) {
      return result;
    }
  } else {
    result.error = 'TPL_ATTENDANCE 미설정';

    if (!allowSmsWithoutTemplate) {
      return result;
    }
  }

  const sms = await sendSmsOne(to, msg);
  if (sms.ok) {
    result.ok = true;
    result.channel = 'SMS';
    result.error = '';
    return result;
  }

  result.error = sms.error || result.error || 'SMS 실패';
  return result;
}

function fmtKoreanTime(date = new Date()) {
  const d = new Date(date);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);

  const hour24 = kst.getUTCHours();
  const minute = kst.getUTCMinutes();

  const ampm = hour24 < 12 ? '오전' : '오후';
  const hour12 = hour24 % 12 || 12;

  return ampm + ' ' + hour12 + '시 ' + String(minute).padStart(2, '0') + '분';
}

function buildClassAbsentTemplateText(student, when = new Date()) {
  const studentLine = [
    String(student?.school || '').trim(),
    String(student?.grade || '').trim(),
    String(student?.student_name || '').trim()
  ].filter(Boolean).join(' ');

  const subjectLine = studentLine ? (studentLine + ' 학생이 ') : '학생이 ';

  return '[더오름영어 출결 안내]\n' +
    '안녕하세요 더오름영어 입니다.\n' +
    subjectLine + fmtKoreanTime(when) + ' 기준 아직 등원하지 않았습니다.\n' +
    '혹시 사유가 있을 시에는 연락 부탁드립니다. 감사합니다.';
}

export async function notifyParentOnAbsenceDirect(student, traceId, occurredAt = '') {
  const absentNotify = env('ABSENT_NOTIFY_PARENTS', 'Y').toUpperCase() === 'Y';
  if (!absentNotify) {
    return {
      attempted: false,
      ok: true,
      channel: '',
      error: '',
      reason: 'ABSENT_NOTIFY_PARENTS_OFF'
    };
  }

  const to = normPhone(student?.parent_phone);
  if (!to) {
    return {
      attempted: false,
      ok: false,
      channel: '',
      error: '학부모 전화번호 없음',
      reason: 'NO_PARENT_PHONE'
    };
  }

  const occurredMs = Date.parse(String(occurredAt || '').trim());
  const when = Number.isFinite(occurredMs) ? new Date(occurredMs) : new Date();
  const msg = buildClassAbsentTemplateText(student, when);
  const tpl = env('TPL_CLASS_ABSENT') || env('TPL_CLASS_ABSENT_PARENTS');

  let result = {
    attempted: true,
    ok: false,
    channel: '',
    error: '',
    to,
    kind: 'ABSENT',
    traceId,
    at: nowIso()
  };

  const allowSmsAfterAlimFail =
    ynEnvWithGlobalFallback('ABSENT_NOTIFY_SMS_AFTER_ALIM_FAIL', 'USE_SMS_FAILOVER');
  const allowSmsWithoutTemplate =
    ynEnv('ABSENT_NOTIFY_SMS_WITHOUT_TEMPLATE', 'N');

  if (tpl) {
    const alim = await sendAlimtalkOne(to, msg, tpl);
    if (alim.ok) {
      result.ok = true;
      result.channel = 'ALIMTALK';
      return result;
    }

    result.error = alim.error || '알림톡 실패';

    if (!allowSmsAfterAlimFail) {
      return result;
    }
  } else {
    result.error = 'TPL_CLASS_ABSENT 미설정';

    if (!allowSmsWithoutTemplate) {
      return result;
    }
  }

  const sms = await sendSmsOne(to, msg);
  if (sms.ok) {
    result.ok = true;
    result.channel = 'SMS';
    result.error = '';
    return result;
  }

  result.error = sms.error || result.error || 'SMS 실패';
  return result;
}

export async function sendNcpTestMessageDirect(toRaw, traceId = '') {
  const to = normPhone(toRaw);
  if (!to) {
    return {
      ok: false,
      final_channel: '',
      error: '테스트 번호가 필요합니다.',
      to: '',
      tested_at: nowIso(),
      traceId
    };
  }

  const msg = buildAttendanceTemplateText({
    school: '테스트학교',
    grade: '테스트학년',
    student_name: '테스트학생'
  }, '등원', new Date());

  const tpl = env('TPL_ATTENDANCE');
  const result = {
    ok: false,
    final_channel: '',
    error: '',
    to,
    tested_at: nowIso(),
    traceId
  };

  if (tpl) {
    const alim = await sendAlimtalkOne(to, msg, tpl);
    if (alim.ok) {
      result.ok = true;
      result.final_channel = 'ALIMTALK';
      return result;
    }

    result.error = alim.error || '알림톡 테스트 실패';
  } else {
    result.error = 'TPL_ATTENDANCE 미설정';
  }

  if (env('NCP_SMS_SERVICE_ID')) {
    const sms = await sendSmsOne(to, msg);
    if (sms.ok) {
      result.ok = true;
      result.final_channel = 'SMS';
      result.error = '';
      return result;
    }

    result.error = sms.error || result.error || 'SMS 테스트 실패';
  }

  return result;
}

export function previewAttendanceNotifyPayloadDirect(student, actionType = 'CHECK_IN', occurredAt = '') {
  const action = String(actionType || '').trim().toUpperCase();
  const kind = action === 'CHECK_OUT' ? '하원' : '등원';
  const occurredMs = Date.parse(String(occurredAt || '').trim());
  const when = Number.isFinite(occurredMs) ? new Date(occurredMs) : new Date();
  const content = buildAttendanceTemplateText(student, kind, when);
  const templateCode = env('TPL_ATTENDANCE');
  const to = normPhone(student?.parent_phone);
  const plusFriendId = env('NCP_PLUS_FRIEND_ID');
  const from = ncpFrom();
  const useFailover = env('USE_SMS_FAILOVER', 'N').toUpperCase() === 'Y';

  const alimtalkBody = {
    templateCode,
    messages: [{
      to,
      content,
      countryCode: '82'
    }]
  };

  if (plusFriendId) {
    alimtalkBody.plusFriendId = plusFriendId;
  }

  if (useFailover && from) {
    alimtalkBody.messages[0].useSmsFailover = true;
    alimtalkBody.messages[0].failoverConfig = {
      type: 'SMS',
      from,
      content
    };
  }

  return {
    kind: 'ATTENDANCE',
    action_type: action,
    ncp_path: '/alimtalk/v2/services/{NCP_ALIMTALK_SERVICE_ID}/messages',
    to,
    from,
    plusFriendId,
    templateCode,
    content,
    sms_type_if_direct_fallback: smsTypeForContent(content),
    ncp_internal_sms_failover: useFailover && !!from,
    app_direct_sms_after_alim_fail: ynEnvWithGlobalFallback('ATT_NOTIFY_SMS_AFTER_ALIM_FAIL', 'USE_SMS_FAILOVER'),
    app_direct_sms_without_template: ynEnv('ATT_NOTIFY_SMS_WITHOUT_TEMPLATE', 'N'),
    alimtalk_body: alimtalkBody
  };
}

export function previewAbsenceNotifyPayloadDirect(student, occurredAt = '') {
  const occurredMs = Date.parse(String(occurredAt || '').trim());
  const when = Number.isFinite(occurredMs) ? new Date(occurredMs) : new Date();
  const content = buildClassAbsentTemplateText(student, when);
  const templateCode = env('TPL_CLASS_ABSENT') || env('TPL_CLASS_ABSENT_PARENTS');
  const to = normPhone(student?.parent_phone);
  const plusFriendId = env('NCP_PLUS_FRIEND_ID');
  const from = ncpFrom();
  const useFailover = env('USE_SMS_FAILOVER', 'N').toUpperCase() === 'Y';

  const alimtalkBody = {
    templateCode,
    messages: [{
      to,
      content,
      countryCode: '82'
    }]
  };

  if (plusFriendId) {
    alimtalkBody.plusFriendId = plusFriendId;
  }

  if (useFailover && from) {
    alimtalkBody.messages[0].useSmsFailover = true;
    alimtalkBody.messages[0].failoverConfig = {
      type: 'SMS',
      from,
      content
    };
  }

  return {
    kind: 'ABSENT',
    action_type: 'ABSENT',
    ncp_path: '/alimtalk/v2/services/{NCP_ALIMTALK_SERVICE_ID}/messages',
    to,
    from,
    plusFriendId,
    templateCode,
    content,
    sms_type_if_direct_fallback: smsTypeForContent(content),
    ncp_internal_sms_failover: useFailover && !!from,
    app_direct_sms_after_alim_fail: ynEnvWithGlobalFallback('ABSENT_NOTIFY_SMS_AFTER_ALIM_FAIL', 'USE_SMS_FAILOVER'),
    app_direct_sms_without_template: ynEnv('ABSENT_NOTIFY_SMS_WITHOUT_TEMPLATE', 'N'),
    alimtalk_body: alimtalkBody
  };
}