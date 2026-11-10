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

## 4. 기능 추가 및 변경 시 전방위 인터페이스 정합성 점검 (필수)
새로운 기능(목소리 프리셋, 페르소나, LLM 모델 등)을 추가하거나 기존 설정을 수정할 때는 다음 5개 핵심 인터페이스에 누락 없이 일관되게 반영되었는지 반드시 교차 점검할 것:
1. **! 텍스트 명령어 (`src/util/prefixCommands.ts`, `aliasMap` 등)**: 
   - 프리셋 목록(`list`), 별칭 매핑(`aliasMap`), 도움말/선택지 안내 텍스트에 신규 항목이 포함되었는지 확인.
2. **슬래시 명령어 (`src/util/slashCommands.ts`)**: 
   - `SlashCommandBuilder`의 옵션 선택지(`addChoices`) 및 서브커맨드 핸들러에 신규 항목이 등록되었는지 확인.
3. **웹 대시보드 (`src/dashboard/index.html`, `src/util/dashboard.ts`)**: 
   - 프론트엔드 드롭다운(`<select id="presetSelect">`, `<select id="personaSelect">` 등) 및 SSE/REST 제어 API에 정상 반영되었는지 확인.
4. **채팅 (텍스트 대화 엔진 / 컨텍스트)**: 
   - Ollama 프롬프트, 키워드 감지 및 대화 맥락 저장 시 정합성이 유지되는지 점검.
5. **음성 (음성 채널 STT/TTS)**: 
   - STT 발음 정규화(오인식 보정), 각 엔진(MeloTTS, CosyVoice, Qwen3-TTS)별 합성 파라미터 전달 및 스마트 폴백 로직이 누락 없이 연결되었는지 확인.

