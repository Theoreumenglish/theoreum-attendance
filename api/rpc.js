const DEFAULT_TIMEOUT_MS = 25000;

function send(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) return JSON.parse(req.body);
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST만 허용됩니다.' }
    });
  }

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    return send(res, 500, {
      ok: false,
      error: { code: 'CONFIG_REQUIRED', message: 'Vercel 환경변수 GAS_WEBAPP_URL이 없습니다.' }
    });
  }

  let payload = {};
  try {
    payload = await readBody(req);
  } catch (e) {
    return send(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: '요청 JSON 형식이 올바르지 않습니다.' }
    });
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.GAS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });

    const text = await upstream.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      return send(res, 502, {
        ok: false,
        error: {
          code: 'UPSTREAM_BAD_JSON',
          message: 'GAS 응답 JSON 파싱 실패',
          detail: {
            status: upstream.status,
            preview: String(text || '').slice(0, 400)
          }
        }
      });
    }

    return send(
      res,
      upstream.ok ? 200 : upstream.status,
      data || {
        ok: false,
        error: { code: 'EMPTY_RESPONSE', message: 'GAS 응답이 비어 있습니다.' }
      }
    );
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return send(res, aborted ? 504 : 502, {
      ok: false,
      error: {
        code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAIL',
        message: aborted ? 'GAS 응답 시간 초과' : (e && e.message ? e.message : 'GAS 요청 실패')
      }
    });
  } finally {
    clearTimeout(timer);
  }
}