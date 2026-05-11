# QR endpoint handler policy

## Scope

Applies to:

- api/student-qr/session-start.js
- api/student-qr/frame.js
- api/student-qr/verify.js
- api/staff-qr/session-start.js
- api/staff-qr/frame.js
- api/staff-qr/verify.js

## Rules

1. Every endpoint must return JSON only.
2. Every endpoint must set no-store cache headers.
3. POST-only endpoints must reject non-POST methods with METHOD_NOT_ALLOWED.
4. Handler must follow this order:

```js
try {
  if (req.method !== 'POST') {
    return send(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'POST만 허용됩니다.'
      }
    });
  }

  const body = await readBody(req);
  const out = await coreFunction(body);
  return send(res, statusFromOut(out), out);
} catch (e) {
  return send(res, 500, {
    ok: false,
    error: {
      code: 'SERVER_ERROR',
      message: e?.message || '서버 오류'
    }
  });
}
```

5. Do not consume nonce before validating signature and session.
6. Do not expose secrets in diagnostic responses.
7. Use server time, not client time, for expiration decisions.
8. QR cleanup should be available through `admin.cleanupQrExpired`.