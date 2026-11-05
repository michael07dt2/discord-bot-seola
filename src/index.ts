import path from "path";
import fs from "fs";
import express from "express";
import "dotenv/config";
import { Client, EmbedBuilder, Events, GatewayIntentBits } from "discord.js";
import {
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  StreamType,
  entersState,
} from "@discordjs/voice";

import {
  chatAI,
  connectToVoiceChannel,
  getAvailableModels,
  getUserKey,
  getUserModel,
  setUserModel,
} from "./util/helper.ts";
import { songMap } from "./util/songmap.ts";
import {
  getBotStatusReport,
  performWebSearch,
  runSelfImprovement,
  scheduleBotRestart,
} from "./util/tools.ts";
import {
  getActiveVoiceSessions,
  getCurrentVoicePreset,
  preloadWhisperModel,
  removeVoiceChatSession,
  setGuildPlaybackMode,
  setVoiceChatEnabled,
  setVoicePreset,
  setupVoiceChatListener,
  speakInVoiceChannel,
  VOICE_PRESETS,
} from "./util/voiceChat.ts";
import {
  notifyDashboardStatusChanged,
  registerDashboardRoutes,
  type DashboardStatusSnapshot,
} from "./util/dashboard.ts";

const app = express();
const port = process.env.PORT || 3000;
const dashboardUrl =
  process.env.DASHBOARD_URL || `http://localhost:${port}/dashboard`;

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

const getDashboardStatusSnapshot = (): DashboardStatusSnapshot => {
  const preset = getCurrentVoicePreset();
  return {
    botTag: discordClient.user?.tag || "Seola Bot",
    uptimeSec: Math.floor(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    voicePreset: {
      id: preset.id,
      label: preset.label,
    },
    sessions: getActiveVoiceSessions(),
  };
};

discordClient.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  // 봇 시작 시 로컬 Whisper STT 모델을 백그라운드에서 사전 로드
  preloadWhisperModel().catch(() => {});
});

// 2. 프리픽스 명령어 처리
discordClient.on("messageCreate", async (message) => {
  // 봇이 보낸 메시지 무시
  if (message.author.bot) {
    return;
  }

  if (message.content.startsWith("!text")) {
    await message.reply("응답 성공!");
    return;
  }

  // 도움말 명령어 처리 (!help, !도움말, 설아야 도움말, 설아야 명령어)
  if (
    message.content.startsWith("!help") ||
    message.content.startsWith("!도움말") ||
    /^설아야?\s*(도움말|명령어)/.test(message.content.trim())
  ) {
    const currentPreset = getCurrentVoicePreset();
    const helpEmbed = new EmbedBuilder()
      .setColor(0xff85a2)
      .setTitle("🌸 설아 봇 (Seola Bot) 명령어 도움말")
      .setDescription(
        "로컬 AI(Ollama) 기반 텍스트 채팅 및 실시간 음성 대화·음악 재생을 지원하는 설아 봇입니다.",
      )
      .addFields(
        {
          name: "💬 AI 텍스트 대화",
          value: [
            "`설아야 <할 말>` 또는 `설아 <할 말>` — 설아와 대화 (개인별 문맥 유지)",
          ].join("\n"),
        },
        {
          name: "🎙️ 실시간 음성 대화 (음성 채널)",
          value: [
            "`설아야 이리온` / `설아야 들어와` / `설아야 통화하자` — 음성 채널 입장 및 실시간 대화 시작",
            "*(입장 후에는 호출어 없이 마이크로 말하면 설아가 바로 대답하며, 음성 대화록은 채팅창 대신 대시보드에만 실시간 기록됩니다)*",
            `\`!dashboard\` / \`!대시보드\` — 실시간 음성 대화록 웹 대시보드 주소 확인 (${dashboardUrl})`,
            "`설아야 조용히 해` / `설아야 음성대화 꺼줘` — 음성 듣기 일시 중지",
            "`설아야 다시 말해` / `설아야 음성대화 켜줘` — 음성 듣기 재개",
            "`설아야 꺼져` — 음성 채널 퇴장 *(음성으로 말해도 퇴장 가능)*",
          ].join("\n"),
        },
        {
          name: `🗣️ 목소리(TTS) 설정 (현재: ${currentPreset.label})`,
          value: [
            "`!voice` 또는 `!목소리` — 사용 가능한 목소리 프리셋 목록 확인",
            "`!voice <이름>` 또는 `!목소리 <이름>` — 설아 목소리 변경",
            "지원 프리셋: `아바`(`ava`), `설아`(`seola`), `선희`(`sunhi`), `엠마`(`emma`), `세라피나`(`seraphina`), `비비안`(`vivienne`)",
          ].join("\n"),
        },
        {
          name: "🤖 AI 모델 설정 (유저별 개별 적용)",
          value: [
            "`!models` 또는 `설아야 모델 목록` — 현재 모델 및 사용 가능한 로컬 모델 조회",
            "`!model <모델명>` 또는 `설아야 모델 <모델명>으로 바꿔줘` — 대화 모델 변경",
          ].join("\n"),
        },
        {
          name: "🛠️ 에이전트 도구 (검색 · 재시작 · 자기개선)",
          value: [
            "`!search <검색어>` / `!검색 <검색어>` / `설아야 <내용> 검색해줘` — 실시간 웹·뉴스·위키 검색",
            "`!improve <요청>` / `!자기개선 <요청>` / `설아야 agy로 <요청> 개선해줘` — Antigravity CLI(`agy`) 또는 Hermes 호출 자기개선",
            "`!restart` / `!재시작` / `설아야 재시작해` — 설아 봇 프로세스 자체 재시작",
            "`!status` / `!상태` / `설아야 상태 확인` — 봇 프로세스·메모리·Git 상태 확인",
          ].join("\n"),
        },
        {
          name: "🎵 음악 재생 (텍스트 및 음성 명령 모두 가능)",
          value: [
            "`설아야 <곡명> 틀어줘` — 지정한 곡 재생 *(음성으로 \"<곡명> 틀어줘\" 가능)*",
            "지원 곡 키워드: `아리아`, `어웨이크`, `브레이크 더 체인`, `크레이지`, `리다인`, `노 머시`, `세컨드 라이트`, `댓 걸`, `바토리`, `미래소녀`",
          ].join("\n"),
        },
      )
      .setFooter({ text: "도움말 다시 보기: !help 또는 !도움말" });

    await message.reply({ embeds: [helpEmbed] });
    return;
  }

  // 봇 프로세스 재시작 명령어 (!restart, !재시작)
  if (
    message.content.startsWith("!restart") ||
    message.content.startsWith("!재시작")
  ) {
    const reason =
      message.content.replace(/^(!restart|!재시작)\s*/i, "").trim() ||
      `${getUserKey(message)}님의 명령어 요청`;
    const msg = scheduleBotRestart(reason);
    await message.reply(`🔄 ${msg}`);
    return;
  }

  // 실시간 웹 검색 명령어 (!search <검색어>, !검색 <검색어>)
  if (
    message.content.startsWith("!search") ||
    message.content.startsWith("!검색")
  ) {
    const query = message.content.replace(/^(!search|!검색)\s*/i, "").trim();
    if (!query) {
      await message.reply("검색어를 입력해주세요. (예: `!검색 오늘 주요 뉴스`)");
      return;
    }
    const result = await performWebSearch(query);
    await message.reply(`🔍 ${result.slice(0, 1900)}`);
    return;
  }

  // 자기개선 명령어 (!improve, !자기개선, !agy, !hermes)
  if (
    message.content.startsWith("!improve") ||
    message.content.startsWith("!자기개선") ||
    message.content.startsWith("!agy") ||
    message.content.startsWith("!hermes")
  ) {
    const isHermes = message.content.toLowerCase().startsWith("!hermes");
    const instruction = message.content
      .replace(/^(!improve|!자기개선|!agy|!hermes)\s*/i, "")
      .trim();

    if (!instruction) {
      await message.reply(
        "자기개선 지시사항을 입력해주세요.\n예: `!자기개선 노래 목록에 새로운 키워드 별칭 추가해줘` 또는 `!agy 상태 메시지에 현재 시간도 표시해줘`",
      );
      return;
    }

    try {
      const statusMsg = await runSelfImprovement({
        instruction,
        engine: isHermes ? "hermes" : "agy",
        channel: message.channel.isSendable() ? message.channel : null,
      });
      await message.reply(`🛠️ ${statusMsg}`);
    } catch (error) {
      console.error("자기개선 실행 중 오류 발생:", error);
      await message.reply("자기개선 에이전트를 호출하는 중 오류가 발생했습니다.");
    }
    return;
  }

  // 봇 상태 조회 명령어 (!status, !상태)
  if (
    message.content.startsWith("!status") ||
    message.content.startsWith("!상태")
  ) {
    const report = await getBotStatusReport();
    await message.reply(
      `📊 **설아 봇 현재 상태**\n${report}\n- 음성 대화록 대시보드: ${dashboardUrl}`,
    );
    return;
  }

  // 음성 대화록 대시보드 안내 명령어 (!dashboard, !대시보드, 설아야 대시보드)
  if (
    message.content.startsWith("!dashboard") ||
    message.content.startsWith("!대시보드") ||
    /^설아야?\s*대시보드/.test(message.content.trim())
  ) {
    await message.reply(
      `📋 **설아 실시간 음성 대화록 대시보드**\n음성 채널 대화 내용은 채팅 채널에 전송되지 않고 아래 대시보드에서 실시간으로 확인할 수 있어요!\n👉 ${dashboardUrl}`,
    );
    return;
  }

  // 목소리(TTS) 프리셋 조회 및 변경 명령어 처리 (!voice, !목소리, 설아야 목소리 ...)
  if (
    message.content.startsWith("!voice") ||
    message.content.startsWith("!목소리") ||
    /^설아야?\s*목소리/.test(message.content.trim())
  ) {
    const targetVoice = message.content
      .replace(/^(!voice|!목소리|설아야?\s*목소리)\s*/i, "")
      .replace(/(으로|로)?\s*(바꿔\s*줘|변경해\s*줘|바꿔|변경|설정)?$/i, "")
      .trim();

    if (!targetVoice) {
      const current = getCurrentVoicePreset();
      const presetLines = Object.values(VOICE_PRESETS)
        .map(
          (p) =>
            `- \`${p.id}\` (**${p.label}**): ${p.description}${p.id === current.id ? " ✅ *(현재 설정)*" : ""}`,
        )
        .join("\n");

      await message.reply(
        `🗣️ **현재 설아 목소리**: **${current.label}** (\`${current.id}\`)\n\n**사용 가능한 목소리 프리셋:**\n${presetLines}\n\n변경 방법: \`!목소리 아바\`, \`!목소리 설아\`, \`!목소리 엠마\` 등`,
      );
      return;
    }

    const updated = setVoicePreset(targetVoice);
    if (!updated) {
      const availableKeys = Object.keys(VOICE_PRESETS)
        .map((k) => `\`${k}\``)
        .join(", ");
      await message.reply(
        `\`${targetVoice}\` 목소리 프리셋을 찾을 수 없어요.\n선택 가능한 목소리: ${availableKeys} (또는 \`아바\`, \`설아\`, \`선희\`, \`엠마\`, \`세라피나\`, \`비비안\`)`,
      );
      return;
    }

    await message.reply(
      `🗣️ 설아의 목소리가 **${updated.label}**(\`${updated.id}\`)로 변경되었어요!`,
    );
    notifyDashboardStatusChanged(getDashboardStatusSnapshot());

    // 현재 음성 채널에 연결되어 있다면 변경된 목소리로 즉시 샘플 인사 재생
    const guildId = message.guild?.id;
    const connection = guildId ? getVoiceConnection(guildId) : undefined;
    if (connection && guildId) {
      await speakInVoiceChannel(
        connection,
        player,
        guildId,
        "목소리를 바꿔봤는데 어때? 마음에 들어?",
      );
    }
    return;
  }

  if (
    message.content.startsWith("설아야 이리온") ||
    message.content.startsWith("설아야 들어와") ||
    message.content.startsWith("설아야 통화하자")
  ) {
    const voiceChannel = message.member?.voice.channel;

    if (!voiceChannel) {
      await message.reply("먼저 음성 채널에 들어가야 합니다.");
      return;
    }

    try {
      const connection = await connectToVoiceChannel(voiceChannel);
      setupVoiceChatListener({
        client: discordClient,
        connection,
        voiceChannel,
        textChannel: message.channel.isSendable() ? message.channel : null,
        player,
      });
      notifyDashboardStatusChanged(getDashboardStatusSnapshot());

      await message.reply(
        `음성 채널에 연결되었습니다! 이제 마이크에 대고 말씀하시면 실시간으로 대화할 수 있어요.\n*(음성 대화록은 채팅창 대신 대시보드에만 표시됩니다: ${dashboardUrl})*`,
      );
      await speakInVoiceChannel(
        connection,
        player,
        voiceChannel.guild.id,
        "안녕! 불렀어?",
      );
      return;
    } catch (error) {
      console.error("음성 채널 연결 중 오류 발생:", error);
      await message.reply("음성 채널에 연결할 수 없습니다.");
      return;
    }
  }

  // 음성 대화 듣기 일시정지 / 재개 명령어 처리
  if (
    message.content.startsWith("설아야 음성대화 꺼") ||
    message.content.startsWith("설아야 조용히")
  ) {
    const guildId = message.guild?.id;
    if (guildId && setVoiceChatEnabled(guildId, false)) {
      notifyDashboardStatusChanged(getDashboardStatusSnapshot());
      await message.reply("실시간 음성 대화를 일시 중지했어요. 다시 켜려면 `설아야 음성대화 켜줘`라고 해주세요.");
      return;
    }
  }

  if (
    message.content.startsWith("설아야 음성대화 켜") ||
    message.content.startsWith("설아야 다시 말해")
  ) {
    const guildId = message.guild?.id;
    if (guildId && setVoiceChatEnabled(guildId, true)) {
      notifyDashboardStatusChanged(getDashboardStatusSnapshot());
      await message.reply("실시간 음성 대화를 다시 시작했어요! 편하게 말씀해주세요.");
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

        setGuildPlaybackMode(voiceChannel.guild.id, "music");
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
    removeVoiceChatSession(voiceChannel.guild.id);
    connection.destroy();
    notifyDashboardStatusChanged(getDashboardStatusSnapshot());
    await message.reply("음악 재생 및 음성 대화를 중지하고 음성 채널에서 나왔습니다.");
    return;
  }

  // 모델 목록을 가져오는 명령어 처리
  if (message.content.startsWith("!models")) {
    try {
      const userName = getUserKey(message);
      const [modelNames, currentModel] = await Promise.all([
        getAvailableModels(),
        getUserModel(userName),
      ]);
      const modelList = modelNames.map((m) => `\`${m}\``).join(", ");

      await message.reply(
        `**${userName}**님의 현재 모델: \`${currentModel}\`\n사용 가능한 모델: ${modelList}`,
      );
    } catch (error) {
      console.error("모델 목록 조회 중 오류 발생:", error);
      await message.reply("모델 목록을 불러오는 중 오류가 발생했습니다.");
    }
    return;
  }

  // 유저별 모델 확인 및 변경 명령어 처리 (!model <모델명> / !모델 <모델명>)
  if (
    message.content.startsWith("!model") ||
    message.content.startsWith("!모델")
  ) {
    try {
      const userName = getUserKey(message);
      const targetModel = message.content
        .replace(/^(!model|!모델)\s*/i, "")
        .trim();

      if (!targetModel) {
        const [availableModels, currentModel] = await Promise.all([
          getAvailableModels(),
          getUserModel(userName),
        ]);
        await message.reply(
          `**${userName}**님의 현재 모델: \`${currentModel}\`\n사용 가능한 모델: ${availableModels.map((m) => `\`${m}\``).join(", ")}\n변경 방법: \`!model <모델명>\` 또는 \`설아야 모델 <모델명>으로 바꿔줘\``,
        );
        return;
      }

      const result = await setUserModel(userName, targetModel);
      if (result.success && result.model) {
        await message.reply(
          `**${userName}**님의 대화 모델이 \`${result.model}\`(으)로 변경되었습니다.`,
        );
      } else {
        await message.reply(
          `\`${targetModel}\` 모델을 찾을 수 없습니다.\n사용 가능한 모델: ${result.availableModels.map((m) => `\`${m}\``).join(", ")}`,
        );
      }
    } catch (error) {
      console.error("모델 변경 중 오류 발생:", error);
      await message.reply("모델을 변경하는 중 오류가 발생했습니다.");
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

// 3. Express 서버 및 음성 대화록 대시보드 실행
registerDashboardRoutes(app, getDashboardStatusSnapshot);

app.listen(port, () => {
  console.log(`Server & Voice Dashboard running on http://localhost:${port}/dashboard`);
});

// 4. 봇 로그인
discordClient.login(process.env.DISCORD_TOKEN);
