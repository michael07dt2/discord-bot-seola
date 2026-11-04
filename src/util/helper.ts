import {
  type Message,
  type OmitPartialGroupDMChannel,
  type VoiceBasedChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { contextsTable, userModelsTable } from "../db/schema.ts";
import { OpenAI } from "openai";
import "dotenv/config";

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

export const chatAI = async (
  message: OmitPartialGroupDMChannel<Message<boolean>>,
) => {
  const userName = getUserKey(message);
  const userMessage = message.content.trim();

  if (!userMessage) {
    await message.reply("메시지를 입력해주세요.");
    return;
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
        await message.reply(
          `**${userName}**님의 현재 모델: \`${currentModel}\`\n사용 가능한 모델: ${availableModels.map((m) => `\`${m}\``).join(", ")}`,
        );
        return;
      }

      if (modelCmd.type === "current") {
        const currentModel = await getUserModel(userName);
        await message.reply(
          `**${userName}**님의 현재 설정된 모델은 \`${currentModel}\` 입니다.`,
        );
        return;
      }

      if (modelCmd.type === "change") {
        const result = await setUserModel(userName, modelCmd.targetModel);
        if (result.success && result.model) {
          await message.reply(
            `**${userName}**님의 대화 모델이 \`${result.model}\`(으)로 변경되었습니다.`,
          );
        } else {
          await message.reply(
            `\`${modelCmd.targetModel}\` 모델을 찾을 수 없습니다.\n사용 가능한 모델: ${result.availableModels.map((m) => `\`${m}\``).join(", ")}`,
          );
        }
        return;
      }
    } catch (error) {
      console.error("모델 명령 처리 중 오류 발생:", error);
      await message.reply("모델 정보를 처리하는 중 오류가 발생했습니다.");
      return;
    }
  }

  let contextData: (typeof contextsTable.$inferSelect)[] = [];
  if (userName) {
    try {
      const context = await db
        .select()
        .from(contextsTable)
        .where(eq(contextsTable.name, userName));

      if (context.length > 0) {
        contextData = context;
      }
    } catch (error) {
      console.error("데이터베이스 조회 중 오류 발생:", error);
      await message.reply("오류가 발생했습니다. 나중에 다시 시도해주세요.");
      return;
    }
  }

  try {
    const selectedModel = await getUserModel(userName);
    const completion = await openAiClient.chat.completions.create({
      model: selectedModel,
      messages: [
        {
          role: "developer",
          content:
            "You are a korean girlfriend. Reply format is Markdown Text 101. Reply in Korean. Reply under 2000 characters.",
        },
        ...contextData.map((context) => {
          return JSON.parse(context.context);
        }),
        { role: "user", content: userMessage },
      ],
    });

    const responseContent = completion.choices[0]?.message.content;
    if (responseContent) {
      await message.reply(responseContent);

      const newContext: typeof contextsTable.$inferInsert = {
        name: userName || "Unknown",
        context: JSON.stringify({ role: "user", content: userMessage }),
      };

      await db.insert(contextsTable).values(newContext);

      const botContext: typeof contextsTable.$inferInsert = {
        name: userName || "Unknown",
        context: JSON.stringify({
          role: "assistant",
          content: responseContent,
        }),
      };

      await db.insert(contextsTable).values(botContext);
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

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
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
