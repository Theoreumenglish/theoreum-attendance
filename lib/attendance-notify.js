import crypto from 'node:crypto';

function env(name, fallback = '') {
  return String(process.env[name] || fallback || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function fmtMonthDayKo(date = new Date()) {
  const d = new Date(date);
  const mm = String(d.getMonth() + 1);
  const dd = String(d.getDate());
  return mm + '월 ' + dd + '일';
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

function buildAttendanceTemplateText(student, kind, when = new Date()) {
  return '[더오름영어 출결 안내]\n' +
    '안녕하세요 더오름영어 입니다.\n' +
    (student.school || '') + ' ' + (student.grade || '') + ' ' + (student.student_name || '') +
    ' 학생이 ' + fmtMonthDayKo_(when) + ' ' + kind + '하였습니다.\n' +
    '감사합니다.';
}

function fmtMonthDayKo_(when) {
  return fmtMonthDayKo(when);
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
    type: 'SMS',
    from,
    content: String(content || ''),
    messages: [{ to: String(to) }]
  };

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

export async function notifyParentOnAttendanceDirect(student, actionType, traceId) {
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

  const kind = actionType === 'CHECK_IN' ? '등원' : '하원';
  const msg = buildAttendanceTemplateText(student, kind, new Date());
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

  if (tpl) {
    const alim = await sendAlimtalkOne(to, msg, tpl);
    if (alim.ok) {
      result.ok = true;
      result.channel = 'ALIMTALK';
      return result;
    }
    result.error = alim.error || '알림톡 실패';
  } else {
    result.error = 'TPL_ATTENDANCE 미설정';
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