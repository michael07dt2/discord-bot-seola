# Seola Bot (설아 디스코드 봇)

디스코드 음성 채널 오디오 재생 및 로컬 LLM(Ollama) 기반 대화 기능을 제공하는 디스코드 봇 프로젝트입니다. 사용자별 대화 맥락(Context)을 PostgreSQL(Drizzle ORM)에 저장하여 연속적인 대화를 지원합니다.

---

## 주요 기능

- **AI 대화 (`설아야`, `설아`)**
  - 로컬 Ollama 서버(`http://localhost:11434/v1`)의 LLM 모델(`gemma4` 등)과 연동하여 대화합니다.
  - 디스코드 사용자(`displayName`)별로 이전 대화 내역을 PostgreSQL 데이터베이스에 저장하고 불러와 문맥을 유지합니다.
- **음성 채널 실시간 대화 (STT → LLM → TTS) 및 로컬 음원 재생**
  - 음성 채널에 접속하면 사용자의 음성을 로컬 Whisper 모델(`@huggingface/transformers`)로 실시간 인식(STT)하고, Ollama LLM 응답을 생성해 한국어 신경망 음성(`msedge-tts`)으로 즉시 대답(TTS)합니다.
  - 음성으로 말한 내용과 설아의 답변은 디스코드 채팅 채널에 전송되지 않으며, 전용 **웹 대시보드**(`http://localhost:3000/dashboard`)에서만 실시간(SSE)으로 확인·검색할 수 있습니다.
  - 음성 채널 입/퇴장 및 `src/audio/` 경로에 배치된 로컬 MP3 음원 스트리밍 재생(텍스트 및 음성 명령 모두 지원)을 제공합니다.
- **LLM 모델 목록 조회 (`!models`)**
  - 현재 로컬 Ollama에 설치된 모델 목록을 디스코드 채팅에서 바로 확인할 수 있습니다.
- **실시간 음성 대화록 웹 대시보드 및 헬스체크 서버**
  - Express 기반 웹 서버에서 실시간 음성 대화록 대시보드(`GET /`, `GET /dashboard`), SSE 스트림(`GET /api/voice-logs/stream`), 헬스체크(`GET /health`)를 제공합니다.

---

## 기술 스택 및 요구 사항

- **Runtime**: Node.js `>= 24.0.0` (`.node-version`: `26`, 네이티브 TypeScript 실행 지원)
- **Language**: TypeScript 7 (`ES2025`, `NodeNext`)
- **Discord**: `discord.js` v14, `@discordjs/voice`, `@discordjs/opus`, `ffmpeg-static`, `libsodium-wrappers`
- **AI / LLM**: `openai` SDK + [Ollama](https://ollama.com/) (`http://localhost:11434`)
- **Database**: PostgreSQL 18 (Docker Compose), `drizzle-orm`, `drizzle-kit`
- **Server**: `express` v5

---

## 시작하기 (Getting Started)

### 1. 패키지 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env.example` 파일을 복사하여 `.env` 파일을 생성하고 디스코드 봇 토큰 및 환경 변수를 입력합니다.

```bash
cp .env.example .env
```

```env
APP_ID=your_discord_app_id
DISCORD_TOKEN=your_discord_bot_token
PUBLIC_KEY=your_discord_public_key
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:15432/context
```

### 3. 데이터베이스 실행 및 스키마 적용

Docker Compose로 PostgreSQL 컨테이너(`localhost:15432`)를 실행합니다.

```bash
docker compose up -d
```

Drizzle Kit을 사용해 데이터베이스 스키마를 반영하거나 동기화합니다.

```bash
# 스키마를 DB에 직접 푸시할 때
npx drizzle-kit push

# 기존 DB에서 스키마를 가져올 때 (초기화)
npx drizzle-kit pull --init
```

<details>
<summary>수동 SQL 테이블 생성 (참고)</summary>

```sql
CREATE TABLE "contexts" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "name" varchar(255) NOT NULL,
  "context" text NOT NULL,
  CONSTRAINT "contexts_id_unique" UNIQUE("id")
);

CREATE TABLE "user_models" (
  "name" varchar(255) PRIMARY KEY,
  "model" varchar(255) NOT NULL
);
```
</details>

### 4. Ollama 준비

로컬 환경에서 Ollama가 실행 중이어야 하며(`http://localhost:11434`), 기본 설정된 모델을 사전에 받아둡니다.

```bash
ollama pull gemma4
```

### 5. 봇 실행

```bash
# 개발 모드 (파일 변경 감지 및 자동 재시작)
npm run dev

# 프로덕션 실행 (Node.js 네이티브 TS 실행)
npm start
```

---

## 디스코드 명령어 안내

| 명령어 예시 | 설명 |
| :--- | :--- |
| `!help` / `!도움말` / `설아야 도움말` | 전체 명령어 및 기능을 정리한 도움말 임베드 출력 |
| `!text` | 봇 응답 테스트 (`응답 성공!` 반환) |
| `!voice` / `!목소리` | 현재 설정된 TTS 목소리 및 선택 가능한 목소리 프리셋 목록 확인 |
| `!voice <프리셋>` / `!목소리 <프리셋>` | 설아의 TTS 목소리 변경 (`아바`, `설아`, `선희`, `엠마`, `세라피나`, `비비안`) |
| `!models` | 현재 유저의 설정 모델 및 로컬 Ollama에서 사용 가능한 모델 목록 출력 |
| `!model <모델명>` / `!모델 <모델명>` | 해당 유저의 대화 모델을 `<모델명>`으로 변경 (인자 생략 시 현재 모델 확인) |
| `설아야 현재 모델` / `설아야 모델 목록` | 대화로 본인의 현재 설정된 모델 또는 사용 가능한 모델 목록 확인 |
| `설아야 모델 <모델명>으로 바꿔줘` | 대화로 본인의 LLM 모델을 `<모델명>`으로 변경 (예: `설아야 모델 gemma4:12b로 바꿔줘`, `설아야 모델 변경 e2b`) |
| `설아야 <메시지>` / `설아 <메시지>` | 설아 AI와 대화 (유저별 선택 모델 및 이전 대화 맥락 유지, 도구 자동 호출 지원) |
| `!search <검색어>` / `!검색 <검색어>` / `설아야 <내용> 검색해줘` | 실시간 웹·뉴스·위키백과 검색 및 요약 응답 |
| `!improve <요청>` / `!자기개선 <요청>` / `!agy <요청>` / `!hermes <요청>` | Antigravity CLI(`agy`) 또는 Hermes 에이전트를 호출해 설아 봇 코드 자체 수정(자기개선) |
| `!restart` / `!재시작` / `설아야 재시작해` | 설아 봇 프로세스 자체 재시작 (`tsx watch` 핫 리스타트 및 일반 프로세스 재스폰 모두 지원) |
| `!status` / `!상태` / `설아야 상태 확인` | 현재 프로세스 PID, 업타임, 메모리, 목소리 설정, Git 상태 및 대시보드 주소 조회 |
| `!dashboard` / `!대시보드` / `설아야 대시보드` | 실시간 음성 대화록 전용 웹 대시보드 URL 안내 |
| `설아야 이리온` / `설아야 들어와` / `설아야 통화하자` | 명령어를 입력한 사용자가 접속 중인 음성 채널에 연결하고 실시간 음성 대화 시작 |
| `설아야 음성대화 꺼줘` / `설아야 조용히 해` | 음성 채널에 머문 상태에서 실시간 음성 인식(듣기) 일시 중지 |
| `설아야 음성대화 켜줘` / `설아야 다시 말해줘` | 일시 중지된 실시간 음성 대화 재개 |
| `설아야 <곡명> 틀어줘` | 음성 채널에서 지정한 곡 재생 (음성으로 `"<곡명> 틀어줘"`라고 말해도 재생 가능) |
| `설아야 꺼져` | 오디오 재생 및 음성 대화를 중지하고 음성 채널에서 퇴장 (음성으로 `"설아야 꺼져"`라고 말해도 퇴장) |

### 지원 음원 키워드 (`src/util/songmap.ts`)

음원 파일(`.mp3`)은 `.gitignore`에 의해 Git 추적에서 제외되므로 `src/audio/` 디렉터리에 직접 배치해야 합니다.

| 호출 키워드 (`설아야 <키워드> 틀어줘`) | 매핑 파일명 (`src/audio/`) |
| :--- | :--- |
| `아리아`, `aria` | `Aria.mp3` |
| `어웨이크`, `awake` | `AWAKE.mp3` |
| `브레이크 더 체인` | `Break The Chains.mp3` |
| `크레이지`, `crazy` | `Crazy.mp3` |
| `리다인`, `리다이인`, `REDIEIN`, `RE;DIEIN` | `RE;DIEIN.mp3` |
| `노 머시`, `no mercy` | `No Mercy.mp3` |
| `세컨드 라이트`, `second light` | `Second Light.mp3` |
| `댓 걸`, `that girl` | `That Girl.mp3` |
| `바토리` | `The Castle of Bathory.mp3` |
| `미래소녀` | `미래소녀.mp3` |

---

## 프로젝트 구조

```text
.
├── compose.yaml          # PostgreSQL 18 Docker Compose 설정
├── drizzle.config.ts     # Drizzle Kit 설정
├── drizzle/              # DB 마이그레이션 및 스키마 스냅샷
└── src/
    ├── index.ts          # 디스코드 봇 클라이언트, 이벤트 핸들러 및 Express 서버
    ├── audio/            # 재생할 로컬 MP3 파일 디렉터리 (.gitignore 제외)
    ├── db/
    │   └── schema.ts     # Drizzle ORM 테이블 정의 (contexts)
    └── util/
        ├── helper.ts     # AI 대화 처리(generateAIResponse, chatAI) 및 음성 채널 연결 유틸리티
        ├── dashboard.ts  # 음성 대화록 DB/메모리 저장소 및 실시간 웹 대시보드(SSE/REST API)
        ├── tools.ts      # 설아 에이전트 Tool 정의 및 실행기 (웹 검색, 재시작, agy/hermes 자기개선, 상태 조회)
        ├── voiceChat.ts  # 실시간 음성 대화 파이프라인 (로컬 Whisper STT + Edge TTS)
        └── songmap.ts    # 노래 제목 키워드 ↔ MP3 파일명 매핑
```
