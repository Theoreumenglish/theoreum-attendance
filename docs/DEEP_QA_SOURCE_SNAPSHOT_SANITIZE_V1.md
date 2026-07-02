# deep-qa-source-snapshot-sanitize-v1

## 목적

`npm run prod:qa:deep` 실행 후 ChatGPT에게 보내는 전체 QA 패키지 안의 코드 스냅샷을 더 작고 안전하게 만든다.

이전 문제:
- source snapshot zip 안에 `node_modules`, `_logs`, patch backup, 생성 zip 등이 섞일 수 있었다.
- 패키지 크기가 불필요하게 커졌다.
- 스크린샷/로그/과거 백업까지 같이 들어가면 실제 코드 검토가 느려졌다.

## 변경

- source snapshot을 Node.js에서 직접 staging 후 압축한다.
- Windows PowerShell 경로 정규화 문제를 피한다.
- 다음 항목은 항상 제외한다.

```txt
.env*
node_modules
dist
_logs
.git
.vercel
_patch_backup*
release / releases
*.zip
*.log
*.tmp
*.bak
대용량 생성 파일
```

## 생성 파일

```txt
_logs/PRODUCTION_DEEP_QA_SOURCE_<runId>.zip
_logs/PRODUCTION_DEEP_QA_SOURCE.zip
_logs/PRODUCTION_DEEP_QA_PACKAGE_<runId>.zip
_logs/PRODUCTION_DEEP_QA_PACKAGE.zip
```

source zip 내부에는 아래가 포함된다.

```txt
SOURCE_SNAPSHOT_README.txt
SOURCE_SNAPSHOT_MANIFEST.json
실제 검토가 필요한 코드/문서/설정 파일
```

## 운영 기준

ChatGPT에게 보낼 때는 아래 두 개만 보내면 된다.

```txt
PRODUCTION_DEEP_QA_TO_SEND.txt
PRODUCTION_DEEP_QA_PACKAGE_<runId>.zip
```

패키지 안의 source snapshot은 민감 파일과 대용량 생성물을 제외해야 한다.
