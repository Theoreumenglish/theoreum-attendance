# DEV_SPEED_STABILITY_V1

## 목적

개발 속도가 느려지고 잡다한 오류가 반복되는 문제를 줄이기 위한 개발 루틴 안정화 문서이다.

## 핵심 변경

핵심 키워드: 중복 검증 제거


1. `one-click-release.ps1`에서 중복 검증을 제거한다.
   - 이전: `npm run check` → `npm run verify` → `npm run build`
   - 이후: `npm run verify` 단일 실행

2. `npm run verify`는 이미 아래를 포함한다.
   - `check`
   - `contract-check`
   - `ux-check`
   - `flow-sim`
   - `integrity-check`
   - `ops-checklist`
   - `final-readiness-check`
   - `build`

3. 빠른 국소 확인용 명령어를 추가한다.
   - `npm run dev:fast-check`
   - `npm run verify:no-build`

## 기본 사용법

패치 적용은 아래 한 줄을 기본으로 사용한다.

```powershell
cd "C:\Users\USER\Desktop\더오름_출결"; npm run dev:apply-patch -- -CommitMessage "커밋 메시지"
```

`PatchZip`을 생략하면 다운로드 폴더에서 가장 최근 `*-patch.zip`을 자동으로 사용한다.

## 실패 시

실패하면 `_logs/LAST_FAILURE_TO_SEND.txt`만 ChatGPT에 보내면 된다. 전체 터미널을 스크롤해서 복사하지 않는다.

## 제품 표면 점검

매 패치마다 Vercel, Supabase, GitHub, OpenAI Platform, Google Drive 영향 여부를 확인한다. 실제 변경이 없는 표면은 “변경 없음”으로 명시한다.

## Fast but safe DB changes

Speed optimization must not skip DB safety. SQL-backed patches are gated before deploy/smoke through `DB_MIGRATION_GATE_V1`.
