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
import { eq } from "drizzle-orm";
import { contextsTable } from "../db/schema.ts";
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
const models: string[] = ["qwen2.5:14b", "gemma4", "llama3"];

export const chatAI = async (
  message: OmitPartialGroupDMChannel<Message<boolean>>,
) => {
  const userName = message?.member?.displayName;
  const userMessage = message.content.slice("설아야".length).trim();

  if (!userMessage) {
    await message.reply("메시지를 입력해주세요.");
    return;
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
    // console.log(contextData);
    const completion = await openAiClient.chat.completions.create({
      model: models[1]!,
      messages: [
        { role: "developer", content: "You are a korean girlfriend." },
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
