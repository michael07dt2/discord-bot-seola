# Project Agent Rules (discord-bot-seola)

## 1. 코드 검증 (TypeScript)
- 모든 코드 수정 후 반드시 `node ./node_modules/typescript/bin/tsc --noEmit`을 실행하여 타입 에러가 없는지 검증할 것.

## 2. Git 워크플로우 (자동 커밋 및 푸시)
- 모든 코드 수정 및 타입 검증이 완료될 때마다, 변경 사항을 명확히 요약한 커밋 메시지로 `git add`, `git commit`, `git push`를 자동으로 수행할 것.

## 3. 디스코드 및 외부 인프라 설정 점검 (외부적 요인 최우선 확인)
- 슬래시 명령어(`The application did not respond`), 웹훅, 음성 채널 등 디스코드 이슈 발생 시 코드 내부뿐만 아니라 **Discord Developer Portal 외부 설정**을 반드시 최우선으로 점검할 것:
  1. **Interactions Endpoint URL**: Discord.js WebSocket 게이트웨이 기반 봇은 Developer Portal의 `Interactions Endpoint URL`이 **반드시 비어 있어야 함** (URL이 입력되어 있으면 디스코드가 웹소켓 대신 HTTP 웹훅으로 패킷을 쏘아 봇이 인터랙션을 받지 못함).
  2. **Privileged Gateway Intents**: `Message Content Intent`, `Server Members Intent` 등 필요한 인텐트가 포털에서 활성화되어 있는지 점검.
  3. **네트워크 및 외부 터널링**: ngrok, Cloudflare Tunnel, 방화벽 포트(13000, 15432, 11434 등) 상태 확인.

