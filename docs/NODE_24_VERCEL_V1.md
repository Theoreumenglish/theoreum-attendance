# NODE_24_VERCEL_V1

## 목적

Vercel build log에서 Node.js 20.x deprecation 경고가 반복되어 `package.json`과 `package-lock.json`의 root engine을 `24.x`로 올린다.

## 변경

```json
"engines": {
  "node": "24.x"
}
```

## 근거

Vercel은 Node.js 24.x를 기본/지원 런타임으로 제공하며, package.json의 engines.node로 사용할 Node major version을 지정할 수 있다.

## 검증

- `npm run check`
- `npm run verify`
- `npm run build`
- Vercel deployment log에서 Node 20 deprecation 경고 감소 확인
