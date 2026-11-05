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
import { asc, eq, sql } from "drizzle-orm";
import { db, contextsTable, userModelsTable } from "../db/index.ts";
import CONFIG from "../config/index.ts";
import {
  extractPersonaCommand,
  getUserPersona,
  PERSONA_DEFINITIONS,
  setUserPersona,
  type PersonaId,
} from "./persona.ts";
import {
  extractAndStoreImplicitMemories,
  retrieveRelevantMemories,
} from "./memoryRag.ts";
import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.js";
import "dotenv/config";
import {
  detectFallbackToolIntent,
  executeSeolaTool,
  SEOLA_TOOLS,
} from "./tools.ts";

const openAiClient = new OpenAI({
  baseURL: `${CONFIG.OLLAMA_BASE_URL}/v1`,
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
  const response = await fetch(`${CONFIG.OLLAMA_BASE_URL}/api/tags`);
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

// 괄호가 열린 채로 아직 닫히지 않았는지 확인 (괄호 내부 쉼표/구두점에 의한 오분할 방지)
const hasUnclosedParen = (str: string): boolean => {
  const openCount = (str.match(/[\(\[\{（【]/g) || []).length;
  const closeCount = (str.match(/[\)\]\}）】]/g) || []).length;
  return openCount > closeCount;
};

// LLM 토큰 스트리밍 중 문장 종결부호(. ! ? … ~ \n) 단위로 즉시 콜백을 호출하는 헬퍼 (TTFA 최적화)
const streamCompletionWithSentences = async (
  model: string,
  messages: ChatCompletionMessageParam[],
  onSentence: (sentence: string) => void,
  options?: { maxTokens?: number },
): Promise<string> => {
  const stream = await openAiClient.chat.completions.create({
    model,
    messages,
    stream: true,
    ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
  });

  let rawContent = "";
  let emittedLength = 0;
  let emittedSentenceCount = 0;

  const flushCompleteSentences = (isFinal: boolean) => {
    // <think> 태그가 열려 있고 아직 닫히지 않았다면 대기
    if (/<think>(?![\s\S]*<\/think>)/i.test(rawContent)) {
      return;
    }

    const visibleContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "");
    let unread = visibleContent.slice(emittedLength);

    while (unread.length > 0) {
      // 1) 앞부분에 있는 괄호 지문((지문), **(지문)**, *지문* 등)은 문장으로 읽지 않고 즉시 스킵
      const leadingActionMatch = unread.match(
        /^\s*(?:\*\*\s*\([^)]*\)\s*\*\*|\*\*\s*\[[^\]]*\]\s*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}|（[^（）]*）|【[^【】]*】)\s*/,
      );
      if (leadingActionMatch) {
        emittedLength += leadingActionMatch[0].length;
        unread = visibleContent.slice(emittedLength);
        continue;
      }

      // 2) 아직 닫히지 않은 괄호 지문이 시작된 상태라면 닫힐 때까지 대기
      if (/^\s*(?:\*\*\s*\(|\(|\[|\{|（|【)/.test(unread) && !isFinal) {
        return;
      }

      // 마침표/물음표/느낌표/말줄임표/물결표 뒤 공백이나 줄바꿈, 혹은 줄바꿈 자체를 문장 경계로 인식
      const boundaryMatch = unread.match(
        /^([\s\S]+?(?:[.!?…~](?=\s|$)|(?=\n)))(\s+|\n+)/,
      );

      if (boundaryMatch && boundaryMatch[1]) {
        const candidate = boundaryMatch[1].trim();
        const consumed = boundaryMatch[0].length;

        // 괄호 내부의 구두점(예: (매우 부드럽고 다정한 목소리로, ...))에 걸린 경우 괄호가 닫힐 때까지 보류
        if (hasUnclosedParen(candidate) && !isFinal) {
          break;
        }

        // TTFA(Time-to-First-Audio) 극대화: 첫 번째 문장은 3자 이상이면 즉각 방출, 이후 문장은 6자 이상 시 방출
        const minLength = emittedSentenceCount === 0 ? 3 : 6;
        if (candidate.length >= minLength) {
          emittedLength += consumed;
          emittedSentenceCount++;
          unread = visibleContent.slice(emittedLength);
          onSentence(candidate);
          continue;
        }
      }

      // 첫 문장에서 쉼표(,)가 나오면 12자 이상일 때 즉각 조기 방출하여 음성 대기 시간 단축
      if (emittedSentenceCount === 0) {
        const earlyClauseMatch = unread.match(/^([\s\S]{10,40}?,)(\s+)/);
        if (earlyClauseMatch && earlyClauseMatch[1]) {
          const candidate = earlyClauseMatch[1].trim();
          const consumed = earlyClauseMatch[0].length;

          if (hasUnclosedParen(candidate) && !isFinal) {
            break;
          }

          emittedLength += consumed;
          emittedSentenceCount++;
          unread = visibleContent.slice(emittedLength);
          onSentence(candidate);
          continue;
        }
      }

      // 구두점 없이 문장이 45자 이상 길어지고 쉼표(,) 뒤 공백이 나오면 절 단위로 조기 분할
      const clauseMatch = unread.match(/^([\s\S]{25,75}?,)(\s+)/);
      if (clauseMatch && clauseMatch[1]) {
        const candidate = clauseMatch[1].trim();
        const consumed = clauseMatch[0].length;

        if (hasUnclosedParen(candidate) && !isFinal) {
          break;
        }

        emittedLength += consumed;
        emittedSentenceCount++;
        unread = visibleContent.slice(emittedLength);
        onSentence(candidate);
        continue;
      }

      break;
    }

    if (isFinal) {
      let remaining = visibleContent.slice(emittedLength).trim();
      // 마지막 잔여 텍스트에서도 지문/괄호 블록 제거
      remaining = remaining
        .replace(/^\s*(?:\*\*\s*\([^)]*\)\s*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|\([^()]*\)|\[[^[\]]*\]|（[^（）]*）|【[^【】]*】)\s*/g, "")
        .trim();
      emittedLength = visibleContent.length;
      if (remaining) {
        emittedSentenceCount++;
        onSentence(remaining);
      }
    }
  };

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      rawContent += delta;
      flushCompleteSentences(false);
    }
  }

  flushCompleteSentences(true);
  return rawContent.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
};

export const generateAIResponse = async (
  userName: string,
  rawMessage: string,
  options?: {
    isVoiceMode?: boolean;
    isMultiPersonVoice?: boolean;
    humanMemberCount?: number;
    channel?: SendableChannels | null;
    onSentence?: (sentence: string) => void;
  },
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

  // 대화형 페르소나(시스템 프롬프트) 조회/변경 명령 처리
  const personaCmd = extractPersonaCommand(userMessage);
  if (personaCmd) {
    try {
      if (personaCmd.type === "list") {
        const listText = Object.values(PERSONA_DEFINITIONS)
          .map((p) => `• **${p.name}** (\`${p.id}\`): ${p.tagline}`)
          .join("\n");
        return `🎭 **사용 가능한 페르소나 목록**\n${listText}\n\n변경 방법: \`설아야 페르소나 <이름>\` 또는 \`/persona set <이름>\``;
      }

      if (personaCmd.type === "current") {
        const current = await getUserPersona(userName);
        const def = PERSONA_DEFINITIONS[current.personaId] || PERSONA_DEFINITIONS.girlfriend;
        const customNote = current.customPrompt
          ? `\n*지정된 프롬프트:* \`\`\`${current.customPrompt.slice(0, 150)}...\`\`\``
          : "";
        return `🎭 **${userName}**님의 현재 페르소나: **${def.name}** (\`${def.id}\`)\n*설명:* ${def.tagline}${customNote}`;
      }

      if (personaCmd.type === "change") {
        const result = await setUserPersona(
          userName,
          personaCmd.personaId,
          personaCmd.customPrompt,
        );
        return `🎭 **${userName}**님의 페르소나가 **${result.persona.name}**(으)로 변경되었습니다!\n*특징:* ${result.persona.tagline}`;
      }
    } catch (error) {
      console.error("페르소나 명령 처리 중 오류 발생:", error);
      return "페르소나 설정을 변경하는 중 오류가 발생했습니다.";
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
  const userPersona = await getUserPersona(userName);
  const personaDef =
    PERSONA_DEFINITIONS[userPersona.personaId] || PERSONA_DEFINITIONS.girlfriend;

  const multiPersonConstraint = options?.isMultiPersonVoice
    ? `\n- 현재 음성 채널에 총 ${options.humanMemberCount ?? 2}명의 사람이 함께 접속해 있다. 다른 사람들끼리 나누는 대화에 불필요하게 끼어들지 않도록, 방금 ${userName}님이 설아를 불러서 직접 물어보거나 요청한 내용에만 집중하여 간결하게 답한다.`
    : "";
  const voiceConstraint = options?.isVoiceMode
    ? `\n\n# Voice Call Mode (실시간 음성 통화 모드 - 최우선 절대 규칙)
- 현재 텍스트 메신저가 아니라 디스코드 음성 채널에서 실시간 목소리로 통화 중이다.
- [답변 길이 엄격 제한]: 답변은 반드시 1문장(최대 2문장), 공백 포함 40자 이내로 매우 짧고 간결하게 대답한다.
- [괄호/지문/행동묘사 절대 금지]: TTS(음성 합성 엔진)가 그대로 소리 내어 읽으므로, 어조 지문, 표정 지문, 행동 묘사, 괄호 표현(예: (웃으며), (다정하게), **(목소리로 대답한다)**, [미소], *미소*)을 단 한 글자도 출력하지 마라.
- 'ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅜㅜ', 이모티콘, 마크다운 기호를 절대 쓰지 말고, 실제로 입으로 발음하여 소리 낼 한국어 대사만 바로 출력한다.${multiPersonConstraint}`
    : "";

  const systemPromptContent = personaDef.buildPrompt({
    userName,
    currentTimeStr,
    lastConversationLine,
    voiceConstraint,
    customPrompt: userPersona.customPrompt,
  });

  // 벡터 RAG: 사용자의 과거 중요한 선호도/기억 검색
  const relevantMemories = await retrieveRelevantMemories(userName, userMessage, 3);
  const memorySection =
    relevantMemories.length > 0
      ? `\n\n# Long-term Personal Memories (${userName}님에 대해 기억하고 있는 중요한 사실들)\n` +
        relevantMemories.map((m) => `- ${m.memory}`).join("\n") +
        "\n*위 기억들을 자연스럽게 대화에 녹여내어 사용자를 친밀하게 알고 있음을 보여준다.*"
      : "";

  const baseMessages: ChatCompletionMessageParam[] = [
    {
      role: "developer",
      content: systemPromptContent + memorySection,
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
    const toolMessages: ChatCompletionMessageParam[] = [
      ...baseMessages,
      {
        role: "developer",
        content: `[도구(${explicitToolIntent.name}) 실행 완료 결과]\n${toolResult}\n\n위 도구 실행 결과를 바탕으로 사용자에게 설아의 다정한 반말 톤으로 자연스럽게 답변해줘.`,
      },
    ];
    if (options?.onSentence) {
      responseContent = await streamCompletionWithSentences(
        selectedModel,
        toolMessages,
        options.onSentence,
        options?.isVoiceMode ? { maxTokens: 80 } : undefined,
      );
    } else {
      const completion = await openAiClient.chat.completions.create({
        model: selectedModel,
        messages: toolMessages,
      });
      responseContent = completion.choices[0]?.message.content;
    }
  } else if (options?.onSentence) {
    // 실시간 음성 통화 모드: 첫 문장이 생성되는 즉시 TTS 파이프라인으로 스트리밍 전달하여 응답 지연 최소화 (짧은 대답 유지를 위해 80 토큰 제한)
    responseContent = await streamCompletionWithSentences(
      selectedModel,
      baseMessages,
      options.onSentence,
      options?.isVoiceMode ? { maxTokens: 80 } : undefined,
    );
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

    // 백그라운드에서 사용자 장기 기억(선호, 취향 등) 자동 추출 및 RAG 저장
    extractAndStoreImplicitMemories(userName, userMessage).catch((err) => {
      console.warn("[MemoryRAG] 기억 추출 중 오류 무시:", err);
    });

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

export {
  getUserPersona,
  setUserPersona,
  PERSONA_DEFINITIONS,
  extractPersonaCommand,
  type PersonaId,
} from "./persona.ts";

export {
  saveUserMemory,
  listUserMemories,
  deleteUserMemory,
  retrieveRelevantMemories,
  extractAndStoreImplicitMemories,
  type MemoryItem,
} from "./memoryRag.ts";

