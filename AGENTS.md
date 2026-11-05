# Project Agent Rules (discord-bot-seola)

## 1. 코드 검증 (TypeScript)
- 모든 코드 수정 후 반드시 `node ./node_modules/typescript/bin/tsc --noEmit`을 실행하여 타입 에러가 없는지 검증할 것.

## 2. Git 워크플로우 (자동 커밋 및 푸시)
- 모든 코드 수정 및 타입 검증이 완료될 때마다, 변경 사항을 명확히 요약한 커밋 메시지로 `git add`, `git commit`, `git push`를 자동으로 수행할 것.
