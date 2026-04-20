function toPositiveInt(value, fallback, min = 1000, max = 60000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function proxyRpcToGas(op, args = {}, sessionToken = '') {
  const gasUrl = String(process.env.GAS_WEBAPP_URL || '').trim();
  if (!gasUrl) {
    return {
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'CONFIG_REQUIRED',
          message: 'Vercel 환경변수 GAS_WEBAPP_URL이 없습니다.'
        }
      }
    };
  }

  const controller = new AbortController();
  const timeoutMs = toPositiveInt(process.env.GAS_TIMEOUT_MS, 25000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      op: String(op || '').trim(),
      args: { ...(args || {}) }
    };

    const token = String(sessionToken || '').trim();
    if (token) {
      payload.sessionToken = token;
      if (!payload.args.sessionToken) {
        payload.args.sessionToken = token;
      }
    }

    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal,
      cache: 'no-store'
    });

    const text = await upstream.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      return {
        status: 502,
        body: {
          ok: false,
          error: {
            code: 'UPSTREAM_BAD_JSON',
            message: 'GAS 응답 JSON 파싱 실패',
            detail: {
              status: upstream.status,
              preview: String(text || '').slice(0, 400)
            }
          }
        }
      };
    }

    return {
      status: upstream.ok ? 200 : upstream.status,
      body: data || {
        ok: false,
        error: {
          code: 'EMPTY_RESPONSE',
          message: 'GAS 응답이 비어 있습니다.'
        }
      }
    };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      status: aborted ? 504 : 502,
      body: {
        ok: false,
        error: {
          code: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAIL',
          message: aborted ? 'GAS 응답 시간 초과' : (e?.message || 'GAS 요청 실패')
        }
      }
    };
  } finally {
    clearTimeout(timer);
  }
}