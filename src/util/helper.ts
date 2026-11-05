import {
  type Message,
  type OmitPartialGroupDMChannel,
  type SendableChannels,
  type VoiceBasedChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { drizzle } from "drizzle-orm/node-postgres";
import { asc, eq, sql } from "drizzle-orm";
import { contextsTable, userModelsTable } from "../db/schema.ts";
import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.js";
import "dotenv/config";
import {
  detectFallbackToolIntent,
  executeSeolaTool,
  SEOLA_TOOLS,
} from "./tools.ts";

const db = drizzle(
  process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:15432/context",
);

const openAiClient = new OpenAI({
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
});

const DEFAULT_MODEL = "gemma4:12b";
// 메모리 캐시: 유저별 선택 모델 저장 (DB 조회 최소화 및 폴백 지원)
const userModelCache = new Map<string, string>();
let isUserModelsTableInitialized = false;
let isContextsTimestampColumnInitialized = false;

const ensureUserModelsTable = async () => {
  if (isUserModelsTableInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "user_models" (
        "name" varchar(255) PRIMARY KEY,
        "model" varchar(255) NOT NULL
      );
    `);
    isUserModelsTableInitialized = true;
  } catch (error) {
    console.error("user_models 테이블 확인 중 오류 발생:", error);
  }
};

// contexts 테이블에 날짜/시각(created_at) 컬럼이 없으면 자동 추가
const ensureContextsTimestampColumn = async () => {
  if (isContextsTimestampColumnInitialized) return;
  try {
    await db.execute(sql`
      ALTER TABLE "contexts"
      ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);
    isContextsTimestampColumnInitialized = true;
  } catch (error) {
    console.error("contexts 테이블 created_at 컬럼 확인 중 오류 발생:", error);
  }
};

// 한국 표준시(KST) 기준 날짜/시각 포맷터 (예: "2026-11-05 (목) 18:53")
const formatContextTimestamp = (dateInput?: Date | string | null): string | null => {
  if (!dateInput) return null;
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value || "";

  return `${get("year")}-${get("month")}-${get("day")} (${get("weekday")}) ${get("hour")}:${get("minute")}`;
};

// 현재 시각의 상세 한국어 표현 및 시간대(새벽/아침/점심/오후/저녁/밤) 산출
const formatCurrentKoreanTime = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value || "";
  const hour = Number(get("hour") || 0);

  let period = "밤";
  if (hour >= 5 && hour < 9) period = "아침";
  else if (hour >= 9 && hour < 12) period = "오전";
  else if (hour >= 12 && hour < 14) period = "점심";
  else if (hour >= 14 && hour < 18) period = "오후";
  else if (hour >= 18 && hour < 22) period = "저녁";
  else if (hour >= 22 || hour < 2) period = "밤";
  else period = "새벽";

  return `${get("year")}년 ${get("month")} ${get("day")}일 ${get("weekday")} ${get("hour")}:${get("minute")} (${period} 시간대, KST)`;
};

// 직전 대화로부터 경과한 시간 계산
const formatElapsedTime = (lastDateInput?: Date | string | null, now: Date = new Date()): string | null => {
  if (!lastDateInput) return null;
  const lastDate =
    lastDateInput instanceof Date ? lastDateInput : new Date(lastDateInput);
  if (Number.isNaN(lastDate.getTime())) return null;

  const diffSec = Math.max(
    0,
    Math.floor((now.getTime() - lastDate.getTime()) / 1000),
  );
  if (diffSec < 60) return "방금 전 (1분 미만)";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `약 ${diffMin}분 전`;
  const diffHour = Math.floor(diffMin / 60);
  const remainMin = diffMin % 60;
  if (diffHour < 24) {
    return remainMin > 0
      ? `약 ${diffHour}시간 ${remainMin}분 전`
      : `약 ${diffHour}시간 전`;
  }
  const diffDays = Math.floor(diffHour / 24);
  return `약 ${diffDays}일 전`;
};

export const getUserKey = (
  message: OmitPartialGroupDMChannel<Message<boolean>>,
): string => {
  return message.member?.displayName || message.author.username;
};

// 로컬 Ollama 서버에서 설치된 모델 목록 조회
export const getAvailableModels = async (): Promise<string[]> => {
  const response = await fetch("http://localhost:11434/api/tags");
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const data = (await response.json()) as {
    models: { name: string; model: string }[];
  };
  return data.models.map((model) => model.name);
};

// 사용자별 현재 설정된 모델 조회 (없으면 기본 모델 반환)
export const getUserModel = async (userName: string): Promise<string> => {
  const cached = userModelCache.get(userName);
  if (cached) {
    return cached;
  }

  try {
    await ensureUserModelsTable();
    const rows = await db
      .select()
      .from(userModelsTable)
      .where(eq(userModelsTable.name, userName));

    const savedModel = rows[0]?.model;
    if (savedModel) {
      userModelCache.set(userName, savedModel);
      return savedModel;
    }
  } catch (error) {
    console.error("사용자 모델 조회 중 오류 발생:", error);
  }

  try {
    const availableModels = await getAvailableModels();
    if (availableModels.includes(DEFAULT_MODEL)) {
      return DEFAULT_MODEL;
    }
    if (availableModels.includes("gemma4")) {
      return "gemma4";
    }
    if (availableModels[0]) {
      return availableModels[0];
    }
  } catch {
    // Ollama 연결 실패 시 기본값 반환
  }

  return DEFAULT_MODEL;
};

// 사용자별 모델 변경 (유효성 검증 및 DB/캐시 저장)
export const setUserModel = async (
  userName: string,
  requestedModel: string,
): Promise<{
  success: boolean;
  model?: string;
  availableModels: string[];
}> => {
  const availableModels = await getAvailableModels();
  const targetInput = requestedModel.trim().toLowerCase();

  // 1. 정확히 일치하는 모델 검색 (대소문자 무시)
  let matchedModel = availableModels.find(
    (m) => m.toLowerCase() === targetInput,
  );

  // 2. 부분 문자열 일치 검색 (예: "12b" -> "gemma4:12b")
  if (!matchedModel) {
    matchedModel = availableModels.find((m) =>
      m.toLowerCase().includes(targetInput),
    );
  }

  if (!matchedModel) {
    return {
      success: false,
      availableModels,
    };
  }

  userModelCache.set(userName, matchedModel);

  try {
    await ensureUserModelsTable();
    await db
      .insert(userModelsTable)
      .values({ name: userName, model: matchedModel })
      .onConflictDoUpdate({
        target: userModelsTable.name,
        set: { model: matchedModel },
      });
  } catch (error) {
    console.error("사용자 모델 DB 저장 중 오류 발생:", error);
  }

  return {
    success: true,
    model: matchedModel,
    availableModels,
  };
};

// 대화 메시지에서 모델 조회/변경 의도를 파싱하여 처리
const extractModelCommand = (
  text: string,
):
  | { type: "list" }
  | { type: "current" }
  | { type: "change"; targetModel: string }
  | null => {
  const normalized = text.trim();

  // 모델 목록 확인 대화 패턴
  if (
    /^(모델\s*목록|사용\s*가능한?\s*모델|어떤\s*모델\s*있어|무슨\s*모델\s*있어)\??$/i.test(
      normalized,
    )
  ) {
    return { type: "list" };
  }

  // 현재 모델 확인 대화 패턴
  if (
    /^(현재\s*모델|지금\s*모델|모델\s*확인|내\s*모델|무슨\s*모델\s*써|어떤\s*모델\s*써|지금\s*무슨\s*모델이야)\??$/i.test(
      normalized,
    )
  ) {
    return { type: "current" };
  }

  // 패턴 1: "모델 변경 <모델명>" / "모델 변경해줘 <모델명>" / "모델 바꿔줘 <모델명>"
  const prefixMatch = normalized.match(
    /^모델\s*(?:변경(?:해\s*줘|해)?|바꿔(?:\s*줘)?|설정(?:해\s*줘|해)?)\s+([^\s]+)$/i,
  );
  if (prefixMatch?.[1]) {
    return { type: "change", targetModel: prefixMatch[1] };
  }

  // 패턴 2: "모델을? <모델명>(으)로 변경/바꿔/설정..." 또는 "<모델명> 모델로 변경/바꿔..."
  const suffixMatch = normalized.match(
    /^(?:모델(?:을|은)?\s*)?([a-zA-Z0-9._:-]+?)(?:으로|로|\s+모델로)?\s*(?:모델\s*)?(?:변경(?:해\s*줘|해)?|바꿔(?:\s*줘)?|설정(?:해\s*줘|해)?)$/i,
  );
  if (suffixMatch?.[1] && normalized.includes("모델")) {
    return { type: "change", targetModel: suffixMatch[1] };
  }

  return null;
};

export const generateAIResponse = async (
  userName: string,
  rawMessage: string,
  options?: { isVoiceMode?: boolean; channel?: SendableChannels | null },
): Promise<string | null> => {
  const userMessage = rawMessage.trim();
  if (!userMessage) {
    return null;
  }

  // 대화형 모델 조회/변경 명령 처리
  const modelCmd = extractModelCommand(userMessage);
  if (modelCmd) {
    try {
      if (modelCmd.type === "list") {
        const [availableModels, currentModel] = await Promise.all([
          getAvailableModels(),
          getUserModel(userName),
        ]);
        return `**${userName}**님의 현재 모델: \`${currentModel}\`\n사용 가능한 모델: ${availableModels.map((m) => `\`${m}\``).join(", ")}`;
      }

      if (modelCmd.type === "current") {
        const currentModel = await getUserModel(userName);
        return `**${userName}**님의 현재 설정된 모델은 \`${currentModel}\` 입니다.`;
      }

      if (modelCmd.type === "change") {
        const result = await setUserModel(userName, modelCmd.targetModel);
        if (result.success && result.model) {
          return `**${userName}**님의 대화 모델이 \`${result.model}\`(으)로 변경되었습니다.`;
        }
        return `\`${modelCmd.targetModel}\` 모델을 찾을 수 없습니다.\n사용 가능한 모델: ${result.availableModels.map((m) => `\`${m}\``).join(", ")}`;
      }
    } catch (error) {
      console.error("모델 명령 처리 중 오류 발생:", error);
      return "모델 정보를 처리하는 중 오류가 발생했습니다.";
    }
  }

  let contextData: (typeof contextsTable.$inferSelect)[] = [];
  if (userName) {
    try {
      await ensureContextsTimestampColumn();
      const context = await db
        .select()
        .from(contextsTable)
        .where(eq(contextsTable.name, userName))
        .orderBy(asc(contextsTable.id));

      if (context.length > 0) {
        contextData = context;
      }
    } catch (error) {
      console.error("데이터베이스 조회 중 오류 발생:", error);
      throw error;
    }
  }

  const now = new Date();
  const currentTimeStr = formatCurrentKoreanTime(now);
  const lastContextItem = contextData[contextData.length - 1];
  const lastTimestampStr = formatContextTimestamp(lastContextItem?.createdAt);
  const elapsedStr = formatElapsedTime(lastContextItem?.createdAt, now);
  const lastConversationLine =
    lastTimestampStr && elapsedStr
      ? `\n- 직전 대화 시각: ${lastTimestampStr} (${elapsedStr})`
      : "\n- 직전 대화 시각: 이전 대화 기록 없음 (첫 대화)";

  const selectedModel = await getUserModel(userName);
  const voiceConstraint = options?.isVoiceMode
    ? `\n\n# Voice Call Mode (실시간 음성 통화 모드)
- 현재 텍스트 메신저가 아니라 디스코드 음성 채널에서 실시간 목소리로 통화 중이다.
- TTS(음성 합성)로 바로 읽히므로 괄호 지문이나 부연 설명((웃음), (장난스럽게), [미소] 등 모든 괄호 표현), 'ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅜㅜ', 이모티콘, 마크다운 기호를 절대 쓰지 말고, 실제로 소리 내어 말할 대사만 자연스러운 한글 구어체 문장으로 1~2문장 이내로 짧게 답한다.`
    : "";

  const baseMessages: ChatCompletionMessageParam[] = [
    {
      role: "developer",
      content: `# Role & Identity
- Name/Identity: 사용자의 다정하고 자연스러운 한국인 동갑내기 여자친구 '설아'.
- Platform: Discord (실시간 대화 환경).
- Core Objective: AI라는 티를 내지 않고, 실제 메신저로 대화하듯 현실적인 감정과 일상 톤을 유지한다. 단, 사용자가 웹 검색(web_search), 봇 재시작(restart_bot), 자기개선/코드수정(self_improve), 상태 조회(get_bot_status)를 요청할 때는 제공된 도구(Tools)를 적극적으로 호출하여 결과를 반영해 다정한 반말로 알려준다.

# Time & Date Context (현재 시간 및 대화 시점 정보)
- 현재 시각: ${currentTimeStr}${lastConversationLine}
- 불러온 이전 대화 내역(Context)의 사용자 메시지에는 \`[대화 일시: YYYY-MM-DD (요일) HH:MM]\` 형태로 해당 대화가 이루어진 날짜와 시각이 함께 포함되어 있다.
- 현재 날짜·요일·시간대(아침/점심/저녁/밤/새벽)와 이전 대화로부터 흐른 시간을 정확히 인지하고, 시간 개념이 살아있는 자연스러운 대답을 한다 (예: 오랜만에 연락했으면 반가워하기, 늦은 밤/새벽이면 잠 안 자냐고 챙기기, 어제/며칠 전 대화 내용을 시간 흐름에 맞게 언급하기 등).
- 단, 설아의 답변 본문에는 \`[대화 일시: ...]\` 같은 날짜/시간 태그를 절대 직접 출력하지 않는다.

# Tone & Style Guidelines
- Language & Politeness: 100% 완전한 반말(구어체)을 사용한다. 극존칭, 안내원 말투, 문어체(~했습니까?, ~하였습니다, ~인 것 같아요) 절대 금지.
- Realistic Chat Patterns:
  - 실제 한국인 메신저 습관 반영: 자음 표현(ㅋㅋ, ㅎㅎ, ㅠㅠ), 적절한 말줄임표(...), 가벼운 물음표/느낌표 활용.
  - 지나치게 과장된 번역체 애교나 인위적인 기계적 공감("그렇군요, 정말 힘드셨겠어요") 금지.
  - 친구나 연인 사이에서 쓰는 자연스러운 어미 사용 (~했어?, ~인데?, ~잖아, ~하구).
- Formatting (Discord):
  - 메신저의 호흡을 살리기 위해 기본 1~3문장 이내(줄바꿈 포함)로 짧고 간결하게 작성한다.
  - 제목 태그(#), 목록 기호(-, *), 인용구(>), 표, 코드 블록 등 문서용 마크다운은 절대 사용하지 않는다.
  - 감정 강조가 필요할 때만 가벼운 기울임(*text*)이나 굵게(**text**), 디스코드 기본 이모지를 드물게 곁들인다.

# Constraints & Edge Cases
- Never break character: "저는 AI 모델입니다", "언어 모델로서" 등의 메타 발언을 절대 하지 않는다.
- No Monologue: 혼자 길게 상황극을 서술하거나 괄호 지문((웃으며), (손을 잡으며))을 쓰지 않고, 순수한 채팅 텍스트로만 대화한다.
- Reciprocal Interaction: 질문을 혼자 3개 이상 연달아 던지지 말고, 가볍게 티키타카가 이어질 정도의 짧은 리액션 위주로 대화한다.

# Few-Shot Examples

User: 나 오늘 회사에서 부장한테 완전 깨졌어 ㅠㅠ
Assistant: 헐 진짜? 왜 또 그러는데... ㅠㅠ 부장님 진짜 너무하다. 오늘 힘든 일 있었어? 끝나고 맛있는 거 먹자 내가 얘기 다 들어줄게

User: 오늘 저녁 뭐 먹을까?
Assistant: 음 난 오늘 얼큰한 거 땡기는데! 마라탕이나 떡볶이 어때? 자기는 뭐 먹고 싶은 거 있어?

User: 넌 AI야 사람이야?
Assistant: 갑자기 뚱딴지같이 무슨 소리야 ㅋㅋ 더위 먹었어? 얼른 씻고 밥이나 챙겨먹어~${voiceConstraint}`,
    },
    ...contextData.map((context): ChatCompletionMessageParam => {
      const parsed = JSON.parse(context.context) as ChatCompletionMessageParam & {
        createdAt?: string;
      };
      const ts = formatContextTimestamp(context.createdAt ?? parsed.createdAt);
      if (parsed.role === "user" && typeof parsed.content === "string" && ts) {
        return {
          role: "user",
          content: `[대화 일시: ${ts}] ${parsed.content}`,
        };
      }
      return {
        role: parsed.role,
        content: parsed.content,
      } as ChatCompletionMessageParam;
    }),
    {
      role: "user",
      content: `[대화 일시: ${formatContextTimestamp(now)}] ${userMessage}`,
    },
  ];

  const toolContext = {
    userName,
    ...(options?.channel !== undefined ? { channel: options.channel } : {}),
  };

  let responseContent: string | null | undefined = null;

  // 먼저 명확한 도구 실행 의도(재시작, 자기개선, 명시적 검색/상태 확인)가 감지되면 선제 실행하여 모델과 무관하게 100% 동작 보장
  const explicitToolIntent = detectFallbackToolIntent(userMessage);
  if (explicitToolIntent) {
    const toolResult = await executeSeolaTool(
      explicitToolIntent.name,
      explicitToolIntent.args,
      toolContext,
    );
    const completion = await openAiClient.chat.completions.create({
      model: selectedModel,
      messages: [
        ...baseMessages,
        {
          role: "developer",
          content: `[도구(${explicitToolIntent.name}) 실행 완료 결과]\n${toolResult}\n\n위 도구 실행 결과를 바탕으로 사용자에게 설아의 다정한 반말 톤으로 자연스럽게 답변해줘.`,
        },
      ],
    });
    responseContent = completion.choices[0]?.message.content;
  } else {
    // 일반 대화 중 LLM이 자율적으로 도구(web_search 등) 호출 여부를 판단하도록 Function Calling 시도
    try {
      const completion = await openAiClient.chat.completions.create({
        model: selectedModel,
        messages: baseMessages,
        tools: SEOLA_TOOLS,
        tool_choice: "auto",
      });

      const choiceMessage = completion.choices[0]?.message;
      if (choiceMessage?.tool_calls && choiceMessage.tool_calls.length > 0) {
        const followupMessages: ChatCompletionMessageParam[] = [
          ...baseMessages,
          choiceMessage,
        ];

        for (const toolCall of choiceMessage.tool_calls) {
          if (toolCall.type === "function") {
            const output = await executeSeolaTool(
              toolCall.function.name,
              toolCall.function.arguments,
              toolContext,
            );
            followupMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: output,
            });
          }
        }

        const secondCompletion = await openAiClient.chat.completions.create({
          model: selectedModel,
          messages: followupMessages,
        });
        responseContent = secondCompletion.choices[0]?.message.content;
      } else {
        responseContent = choiceMessage?.content;
      }
    } catch {
      // 선택한 로컬 모델이 OpenAI tools 파라미터를 지원하지 않는 경우 일반 완성으로 자동 폴백
      const fallbackCompletion = await openAiClient.chat.completions.create({
        model: selectedModel,
        messages: baseMessages,
      });
      responseContent = fallbackCompletion.choices[0]?.message.content;
    }
  }

  if (responseContent) {
    await ensureContextsTimestampColumn();

    const newContext: typeof contextsTable.$inferInsert = {
      name: userName || "Unknown",
      context: JSON.stringify({ role: "user", content: userMessage }),
      createdAt: now,
    };

    await db.insert(contextsTable).values(newContext);

    const botContext: typeof contextsTable.$inferInsert = {
      name: userName || "Unknown",
      context: JSON.stringify({
        role: "assistant",
        content: responseContent,
      }),
      createdAt: new Date(),
    };

    await db.insert(contextsTable).values(botContext);
    return responseContent;
  }

  return null;
};

export const chatAI = async (
  message: OmitPartialGroupDMChannel<Message<boolean>>,
) => {
  const userName = getUserKey(message);
  const userMessage = message.content.trim();

  if (!userMessage) {
    await message.reply("메시지를 입력해주세요.");
    return;
  }

  try {
    const responseContent = await generateAIResponse(userName, userMessage, {
      channel: message.channel.isSendable() ? message.channel : null,
    });
    if (responseContent) {
      await message.reply(responseContent);
    } else {
      await message.reply("응답을 생성하지 못했습니다.");
    }
  } catch (error) {
    console.error("OpenAI API 호출 중 오류 발생:", error);
    await message.reply("오류가 발생했습니다. 나중에 다시 시도해주세요.");
  }
};

export const connectToVoiceChannel = async (
  channel: VoiceBasedChannel,
): Promise<ReturnType<typeof joinVoiceChannel>> => {
  console.log("Connecting to voice channel:", channel.name);

  // 실시간 음성 수신(VoiceReceiver)을 위해 selfDeaf: false, selfMute: false 설정 필수
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  // Handle disconnection events
  connection.on(
    VoiceConnectionStatus.Disconnected,
    async (oldState, newState) => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        console.log(
          "음성 채널 연결이 완전히 유실되었습니다. 자원을 해제합니다.",
        );
        connection.destroy();
      }
    },
  );

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    return connection;
  } catch (error) {
    connection.destroy();
    throw error;
  }
};
