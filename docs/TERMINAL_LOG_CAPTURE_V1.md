# Terminal log capture v1

## 목적

PowerShell에서 긴 원클릭 명령을 실행한 뒤 오류 구간을 매번 스크롤해서 찾지 않도록, 실행 로그와 복사용 실패 요약을 자동 생성한다.

## 포함 기능

- `scripts/one-click-release.ps1`가 실행 시작 시 `_logs/one-click-release_yyyyMMdd_HHmmss.log`를 생성한다.
- 성공하면 `_logs/LAST_RUN.log`와 `_logs/LAST_SUCCESS_SUMMARY.txt`를 갱신한다.
- 실패하면 `_logs/LAST_FAILURE_TO_SEND.txt`를 만들고, 마지막 180줄과 실패 메시지를 복사용 블록으로 정리한다.
- 가능한 경우 실패 요약을 자동으로 클립보드에 복사한다.
- `scripts/copy-last-run-log.ps1`로 마지막 실패 요약 또는 전체 로그를 다시 클립보드에 복사할 수 있다.
- release zip에는 `_logs/`와 `.env*` 파일을 포함하지 않는다.

## 사용법

일반 원클릭 실행:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\one-click-release.ps1 -CommitMessage "feat: ..."
```

오류가 나면 터미널 전체를 복사하지 말고 아래 파일만 보내면 된다.

```txt
_logs/LAST_FAILURE_TO_SEND.txt
```

클립보드에 다시 복사:

```powershell
npm run copy-last-log
```

전체 최신 로그를 복사:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\copy-last-run-log.ps1 -FullLog
```

## 운영 원칙

- 실패했을 때 사용자는 `LAST_FAILURE_TO_SEND.txt` 내용만 보내면 된다.
- 성공했을 때는 `LAST_SUCCESS_SUMMARY.txt`로 완료 여부를 확인한다.
- `_logs/`는 로컬 전용이며 GitHub와 release zip에 포함하지 않는다.
