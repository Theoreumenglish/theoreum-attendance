# DEVELOPER_SURFACE_ROUTINE_V1

## 목적

개발 패치마다 관련 운영 표면을 빠뜨리지 않고 확인한다.

## 기본 확인 표면

- Vercel: Node runtime, build log, deploy result, smoke-test
- Supabase: SQL migration 필요 여부, 인덱스, 데이터 보존, RLS/개인정보 영향
- GitHub: branch 상태, commit, push, release zip
- OpenAI Platform: AI/API 기능 또는 `OPENAI_API_KEY`가 필요한 경우에만 확인
- Google Drive: 산출물 백업, 문서/시트/슬라이드 연계가 필요한 경우에만 확인

## 원칙

- 패치 명령어는 patch-files 직접 복사 방식을 기본으로 한다.
- PowerShell 한글 경로 깨짐 방지를 위해 APPLY_PATCH 스크립트 실행을 기본으로 쓰지 않는다.
- 실패 시 `_logs/LAST_FAILURE_TO_SEND.txt`를 우선 확인한다.
- 비밀번호와 API key는 Git에 넣지 않는다.


## Developer convenience additions

Use these helper scripts before and after patches:

```powershell
npm run dev:doctor
npm run dev:quick-check
npm run dev:apply-patch -- -PatchZip "$env:USERPROFILE\Downloads\PATCH_NAME.zip" -CommitMessage "commit message"
npm run dev:rollback-latest
```

Default patch application should use `scripts/apply-patch-files.ps1` because it copies `patch-files` directly and avoids Korean path encoding problems in generated `APPLY_PATCH_*.ps1` files.

If an error happens, send one of these files first:

```txt
_logs/LAST_FAILURE_TO_SEND.txt
_logs/LAST_QUICK_CHECK_TO_SEND.txt
_logs/DEV_DOCTOR_TO_SEND.txt
```
