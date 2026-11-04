import path from "path";
import fs from "fs";
import express from "express";
import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  StreamType,
  entersState,
} from "@discordjs/voice";

import { chatAI, connectToVoiceChannel } from "./util/helper.ts";
import { songMap } from "./util/songmap.ts";

const app = express();
const port = process.env.PORT || 3000;

const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

player.on("error", (error) => {
  console.error("오디오 플레이어 에러 발생:", error.message, error);
});

player.on(AudioPlayerStatus.Playing, () => {
  console.log("오디오 재생이 음성 채널에서 실제로 시작되었습니다.");
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log("재생이 종료되어 플레이어가 대기(Idle) 상태로 복귀했습니다.");
});

// 1. 디스코드 봇 클라이언트 설정
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
  ],
});

discordClient.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

// 2. 프리픽스 명령어 처리
discordClient.on("messageCreate", async (message) => {
  // 봇이 보낸 메시지 무시
  if (message.author.bot) {
    return;
  }

  if (message.content.startsWith("!text")) {
    await message.reply("응답 성공!");
  }

  if (message.content.startsWith("설아야 이리온")) {
    const voiceChannel = message.member?.voice.channel;

    if (!voiceChannel) {
      await message.reply("먼저 음성 채널에 들어가야 합니다.");
      return;
    }

    try {
      await connectToVoiceChannel(voiceChannel);
      await message.reply("음성 채널에 연결되었습니다!");
      return;
    } catch (error) {
      console.error("음성 채널 연결 중 오류 발생:", error);
      await message.reply("음성 채널에 연결할 수 없습니다.");
      return;
    }
  }

  if (
    message.content.startsWith("설아야") &&
    message.content.endsWith("틀어줘")
  ) {
    const userMessage = message.content
      .replace("설아야", "")
      .replace("틀어줘", "")
      .trim();
    if (!userMessage) {
      await message.reply("재생할 음악 제목을 입력해주세요.");
      return;
    }

    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      await message.reply("먼저 음성 채널에 들어가야 합니다.");
      return;
    }

    const connection = getVoiceConnection(voiceChannel.guild.id);
    if (!connection) {
      await message.reply(
        "먼저 '설아야 이리온' 명령어로 저를 음성 채널에 불러주세요.",
      );
      return;
    }

    const songFileName = songMap[userMessage];
    if (songFileName) {
      try {
        const targetPath = path.resolve(
          process.cwd(),
          "src",
          "audio",
          songFileName,
        );

        if (!fs.existsSync(targetPath)) {
          console.error("오류: 해당 경로에 파일이 없습니다 ->", targetPath);
          await message.reply(
            "서버에 오디오 파일이 존재하지 않습니다. 경로를 확인해주세요.",
          );
          return;
        }

        const resource = createAudioResource(targetPath, {
          inputType: StreamType.Arbitrary,
        });

        player.play(resource);
        connection.subscribe(player);

        entersState(player, AudioPlayerStatus.Playing, 5_000)
          .then(() =>
            console.log("오디오 재생이 음성 채널에서 실제로 시작되었습니다."),
          )
          .catch((err) =>
            console.error(
              "플레이어가 5초 이내에 재생 상태로 진입하지 못함:",
              err,
            ),
          );

        await message.reply(`${userMessage} 재생 시작!`);
        return;
      } catch (error) {
        console.error("오디오 리소스 생성 실패:", error);
        await message.reply("오디오 파일을 읽어오는 중 오류가 발생했습니다.");
        return;
      }
    }

    await message.reply("해당 음악은 재생할 수 없습니다.");
    return;
  }

  if (message.content.startsWith("설아야 꺼져")) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      await message.reply("먼저 음성 채널에 들어가야 합니다.");
      return;
    }

    const connection = getVoiceConnection(voiceChannel.guild.id);
    if (!connection) {
      await message.reply(
        "먼저 '설아야 이리온' 명령어로 저를 음성 채널에 불러주세요.",
      );
      return;
    }

    player.stop();
    connection.destroy();
    await message.reply("음악 재생을 중지하고 음성 채널에서 나왔습니다.");
    return;
  }

  // 모델 목록을 가져오는 명령어 처리
  if (message.content.startsWith("!models")) {
    try {
      const response = await fetch("http://localhost:11434/api/tags");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = (await response.json()) as {
        models: { name: string; model: string }[];
      };
      const modelNames = data.models.map((model) => model.name);
      const modelList = modelNames.join(", ");

      await message.reply(`사용 가능한 모델: ${modelList}`);
    } catch (error) {
      console.error("모델 목록 조회 중 오류 발생:", error);
      await message.reply("모델 목록을 불러오는 중 오류가 발생했습니다.");
    }
    return;
  }

  // "설아야"로 시작하는 메시지 처리
  if (message.content.startsWith("설아야")) {
    message.content = message.content.replace("설아야", "");
    await chatAI(message);
    return;
  }

  // "설아"로 시작하는 메시지 처리
  if (message.content.startsWith("설아")) {
    message.content = message.content.replace("설아", "");
    await chatAI(message);
    return;
  }
});

// 3. Express 서버 실행
app.get("/", (req, res) => {
  res.send("Bot is running!");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// 4. 봇 로그인
discordClient.login(process.env.DISCORD_TOKEN);
