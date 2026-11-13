import path from "path";
import fs from "fs";
import {
  EmbedBuilder,
  type Message,
  type OmitPartialGroupDMChannel,
  type VoiceBasedChannel,
} from "discord.js";
import {
  AudioPlayerStatus,
  createAudioResource,
  entersState,
  getVoiceConnection,
  StreamType,
} from "@discordjs/voice";
import { getGuildAudioPlayer } from "./audioPlayer.ts";
import {
  chatAI,
  connectToVoiceChannel,
  getAvailableModels,
  getUserKey,
  getUserModel,
  getUserPersona,
  PERSONA_DEFINITIONS,
  setUserModel,
  setUserPersona,
  appendConversationContext,
  type PersonaId,
} from "./helper.ts";
import { songMap } from "./songmap.ts";
import {
  playMusicTrack,
  stopGuildMusic,
  getGuildCurrentTrack,
  createMusicTrackEmbed,
  getGuildMusicVolumePercent,
  setGuildMusicVolume,
  getGuildMusicQueue,
  skipGuildMusic,
  clearGuildMusicQueue,
} from "./youtubeMusic.ts";
import {
  getBotStatusReport,
  getSelfImproveStatusReport,
  performWebSearch,
  runSelfImprovement,
  scheduleBotRestart,
} from "./tools.ts";
import {
  getCurrentVoicePreset,
  removeVoiceChatSession,
  setGuildPlaybackMode,
  setVoiceChatEnabled,
  setVoicePreset,
  setupVoiceChatListener,
  speakInVoiceChannel,
  VOICE_PRESETS,
} from "./voiceChat.ts";
import {
  notifyDashboardStatusChanged,
  type DashboardStatusSnapshot,
} from "./dashboard.ts";
import CONFIG from "../config/index.ts";

export type PrefixDiscordMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export interface PrefixCommandContext {
  getDashboardStatusSnapshot: () => DashboardStatusSnapshot;
}

/**
 * 디스코드 메시지(! 및 "설아야") 프리픽스 명령어 디스패처
 */
export const handlePrefixCommand = async (
  message: PrefixDiscordMessage,
  ctx: PrefixCommandContext,
): Promise<void> => {
  const { getDashboardStatusSnapshot } = ctx;
  const dashboardUrl = CONFIG.DASHBOARD_URL;

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
    const userPersona = await getUserPersona(getUserKey(message));
    const personaDef =
      PERSONA_DEFINITIONS[userPersona.personaId] || PERSONA_DEFINITIONS.girlfriend;

    const helpEmbed = new EmbedBuilder()
      .setColor(0xff85a2)
      .setTitle("🌸 설아 봇 (Seola Bot) 명령어 도움말")
      .setDescription(
        "로컬 AI(Ollama) 기반 텍스트 채팅, 실시간 음성 통화, 다채로운 페르소나, 슬래시(/) 명령어를 지원합니다.",
      )
      .addFields(
        {
          name: "⚡ 슬래시(/) 명령어",
          value: [
            "`/chat` 대화 | `/persona` 페르소나 변경 | `/voice` 음성통화 제어",
            "`/preset` 목소리 변경 | `/model` 모델 변경 | `/music` 음악 재생",
            "`/search` 웹 검색 | `/improve` 자기개선 | `/status` 상태 | `/help` 도움말",
          ].join("\n"),
        },
        {
          name: `🎭 페르소나(시스템 프롬프트) 설정 (현재: ${personaDef.name})`,
          value: [
            "`!persona` 또는 `!페르소나` — 사용 가능한 페르소나 목록 확인",
            "`!persona <이름>` 또는 `설아야 페르소나 <이름>` — 페르소나 변경",
            "`!persona custom <프롬프트>` — 원하는 시스템 프롬프트 직접 등록",
            "지원 페르소나: `girlfriend`(여자친구), `assistant`(비서), `tsundere`(츤데레), `senior`(선배), `cute`(발랄), `custom`(사용자지정)",
          ].join("\n"),
        },
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
            "*(1:1 통화 시에는 호출어 없이 바로 대답하며, 사람이 여러 명일 때는 `설아야`라고 부르며 질문한 경우에만 대답합니다. 음성 대화록은 대시보드에 실시간 기록됩니다)*",
            `\`!dashboard\` / \`!대시보드\` — 실시간 음성 대화록 웹 대시보드 주소 확인 (${dashboardUrl})`,
            "`설아야 조용히 해` / `설아야 음성대화 꺼줘` — 음성 듣기 일시 중지",
            "`설아야 다시 말해` / `설아야 음성대화 꺼줘` — 음성 듣기 재개",
            "`설아야 꺼져` — 음성 채널 퇴장 *(음성으로 말해도 퇴장 가능)*",
          ].join("\n"),
        },
        {
          name: `🗣️ 목소리(TTS) 설정 (현재: ${currentPreset.label})`,
          value: [
            "`!voice` 또는 `!목소리` — 사용 가능한 목소리 프리셋 목록 확인 (로컬 MeloTTS-Korean 기본 적용)",
            "`!voice <이름>` 또는 `!목소리 <이름>` — 설아 목소리 변경",
            "지원 프리셋: `설아`(`seola`), `발랄`(`lively`), `차분`(`calm`), `속삭임`(`whisper`), `멜로`(`melo`), `아바`(`ava`), `선희`(`sunhi`)",
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
            "`!작업상태` / `!agy-status` / `설아야 agy 지금 뭐해?` — 자기개선 에이전트(`agy`) 현재 작업 및 진행 상태 확인",
            "`!restart` / `!재시작` / `설아야 재시작해` — 설아 봇 프로세스 자체 재시작",
            "`!status` / `!상태` / `설아야 상태 확인` — 봇 프로세스·메모리·Git 상태 확인",
          ].join("\n"),
        },
        {
          name: "🎵 음악 재생 및 대기열 (텍스트 및 음성 명령 모두 가능)",
          value: [
            "`!play <곡명/링크>` / `설아야 <곡명> 틀어줘` — 음악 재생 *(재생 중이면 대기열 추가)*",
            "`!queue` / `!대기열` / `설아야 대기열` — 현재 재생 곡 및 대기열 목록 확인",
            "`!skip` / `!스킵` / `설아야 다음곡` — 다음 곡으로 건너뛰기",
            "`!clearqueue` / `!대기열비우기` — 대기열 비우기",
            "`!volume <0~100>` 또는 `!볼륨 <수치>` — 음악 재생 음량 조절 *(기본 20%)*",
            "`!stop` / `설아야 노래 꺼줘` — 음악 및 대기열 중지",
            "지원 곡 키워드: `아리아`, `어웨이크`, `브레이크 더 체인`, `크레이지`, `리다인`, `노 머시`, `세컨드 라이트`, `댓 걸`, `바토리`, `미래소녀`",
          ].join("\n"),
        },
      )
      .setFooter({ text: "도움말 다시 보기: !help 또는 !도움말 또는 /help" });

    await message.reply({ embeds: [helpEmbed] });
    return;
  }

  // 페르소나 명령어 (!persona, !페르소나)
  if (
    message.content.startsWith("!persona") ||
    message.content.startsWith("!페르소나")
  ) {
    const rawArgs = message.content
      .replace(/^(!persona|!페르소나)\s*/i, "")
      .trim();
    const userName = getUserKey(message);

    if (!rawArgs) {
      const current = await getUserPersona(userName);
      const def =
        PERSONA_DEFINITIONS[current.personaId] || PERSONA_DEFINITIONS.girlfriend;
      const listText = Object.values(PERSONA_DEFINITIONS)
        .map((p) => `• **${p.name}** (\`${p.id}\`): ${p.tagline}`)
        .join("\n");

      await message.reply(
        `🎭 **${userName}님의 현재 페르소나: ${def.name}**\n\n**사용 가능한 페르소나 목록:**\n${listText}\n\n변경 방법: \`!persona <이름>\` (예: \`!persona 비서\` 또는 \`!persona girlfriend\`)\n커스텀 프롬프트 지정: \`!persona custom <프롬프트내용>\``,
      );
      return;
    }

    if (rawArgs.toLowerCase().startsWith("custom ") || rawArgs.startsWith("커스텀 ")) {
      const customPrompt = rawArgs.replace(/^(custom|커스텀)\s+/i, "").trim();
      if (!customPrompt) {
        await message.reply("커스텀 시스템 프롬프트를 함께 입력해주세요. (예: `!persona custom 너는 명탐정 코난이야...`)");
        return;
      }
      await setUserPersona(userName, "custom", customPrompt);
      const replyMsg = `🎭 **${userName}**님의 커스텀 시스템 프롬프트가 성공적으로 등록되었습니다!`;
      await appendConversationContext(userName, message.content, replyMsg);
      await message.reply(replyMsg);
      return;
    }

    const target = rawArgs.toLowerCase().replace(/(으로|로)$/, "");
    let matchedId: PersonaId | null = null;
    if (["여자친구", "여친", "girlfriend"].includes(target)) matchedId = "girlfriend";
    else if (["비서", "비서관", "assistant"].includes(target)) matchedId = "assistant";
    else if (["츤데레", "소꿉친구", "tsundere"].includes(target)) matchedId = "tsundere";
    else if (["선배", "멘토", "senior"].includes(target)) matchedId = "senior";
    else if (["귀여운", "발랄", "cute"].includes(target)) matchedId = "cute";
    else if (["커스텀", "custom"].includes(target)) matchedId = "custom";

    if (!matchedId) {
      await message.reply(
        `❌ \`${rawArgs}\` 페르소나를 찾을 수 없습니다.\n지원 페르소나: \`girlfriend\`(여자친구), \`assistant\`(비서), \`tsundere\`(츤데레), \`senior\`(선배), \`cute\`(발랄), \`custom\`(커스텀)`,
      );
      return;
    }

    const result = await setUserPersona(userName, matchedId);
    const personaReply = `🎭 **${userName}**님의 페르소나가 **${result.persona.name}**(으)로 변경되었습니다!\n*특징:* ${result.persona.tagline}`;
    await appendConversationContext(userName, message.content, `페르소나가 ${result.persona.name}(으)로 변경되었습니다.`);
    await message.reply(personaReply);
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
    await appendConversationContext(
      getUserKey(message),
      message.content,
      `웹 검색 결과: ${result.slice(0, 300)}`,
    );
    await message.reply(`🔍 ${result.slice(0, 1900)}`);
    return;
  }

  // 자기개선(agy/hermes) 작업 진행 상태 조회 명령어 (!작업상태, !자기개선상태, !agy-status)
  if (
    message.content.startsWith("!작업상태") ||
    message.content.startsWith("!자기개선상태") ||
    message.content.startsWith("!agy-status")
  ) {
    const report = await getSelfImproveStatusReport();
    await message.reply(`🛠️ **자기개선 에이전트(agy) 작업 상태**\n${report}`);
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
      const currentReport = await getSelfImproveStatusReport();
      await message.reply(
        `🛠️ **현재 자기개선 에이전트(agy) 상태**\n${currentReport}\n\n새로운 작업을 지시하려면 내용을 함께 입력해주세요.\n예: \`!자기개선 노래 목록에 새로운 키워드 별칭 추가해줘\` 또는 \`!agy 상태 메시지에 현재 시간도 표시해줘\``,
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
        `🗣️ **현재 설아 목소리**: **${current.label}** (\`${current.id}\`)\n\n**사용 가능한 목소리 프리셋:**\n${presetLines}\n\n변경 방법: \`!voice 설아\`, \`!voice 케이\`, \`!voice 레바\`, \`!voice 감규리\`, \`!voice 다시는 만날 수 없는\`, \`!voice 코지\` 등`,
      );
      return;
    }

    const updated = await setVoicePreset(targetVoice);
    if (!updated) {
      const availableKeys = Object.keys(VOICE_PRESETS)
        .map((k) => `\`${k}\``)
        .join(", ");
      await message.reply(
        `\`${targetVoice}\` 목소리 프리셋을 찾을 수 없어요.\n선택 가능한 목소리: ${availableKeys} (또는 \`케이\`, \`큐웬\`, \`코지\`, \`레바\`, \`감규리\`, \`다시는 만날 수 없는\`, \`설아\`, \`발랄\`, \`차분\`, \`속삭임\`, \`멜로\`, \`아바\`, \`선희\`)`,
      );
      return;
    }

    await message.reply(
      `🗣️ 설아의 목소리가 **${updated.label}**(\`${updated.id}\`)로 변경되었어요!`,
    );
    await appendConversationContext(
      getUserKey(message),
      message.content,
      `설아의 목소리가 ${updated.label}(${updated.id})로 변경되었습니다.`,
    );
    notifyDashboardStatusChanged(getDashboardStatusSnapshot());

    // 현재 음성 채널에 연결되어 있다면 변경된 목소리로 즉시 샘플 인사 재생
    const guildId = message.guild?.id;
    const connection = guildId ? getVoiceConnection(guildId) : undefined;
    if (connection && guildId) {
      await speakInVoiceChannel(
        connection,
        getGuildAudioPlayer(guildId),
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
      const guildPlayer = getGuildAudioPlayer(voiceChannel.guild.id);
      const connection = await connectToVoiceChannel(voiceChannel);
      setupVoiceChatListener({
        client: message.client,
        connection,
        voiceChannel,
        textChannel: message.channel.isSendable() ? message.channel : null,
        player: guildPlayer,
      });
      notifyDashboardStatusChanged(getDashboardStatusSnapshot());

      await message.reply(
        `음성 채널에 연결되었습니다! 이제 마이크에 대고 말씀하시면 실시간으로 대화할 수 있어요.`,
      );
      await appendConversationContext(
        getUserKey(message),
        message.content,
        "음성 채널에 연결되었습니다.",
      );
      await speakInVoiceChannel(
        connection,
        guildPlayer,
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
      await appendConversationContext(
        getUserKey(message),
        message.content,
        "실시간 음성 대화를 일시 중지했습니다.",
      );
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
      await appendConversationContext(
        getUserKey(message),
        message.content,
        "실시간 음성 대화를 다시 시작했습니다.",
      );
      await message.reply("실시간 음성 대화를 다시 시작했어요! 편하게 말씀해주세요.");
      return;
    }
  }

  // 음악 다음 곡 건너뛰기(스킵) 프리픽스 명령
  if (
    /^(!skip|!스킵|!다음곡|!넘겨|설아야?\s*(?:노래\s*|음악\s*)?(?:스킵|다음\s*곡|넘겨)(?:해\s*줘|줘)?)$/i.test(
      message.content.trim(),
    )
  ) {
    const guildId = message.guild?.id;
    if (guildId) {
      const guildPlayer = getGuildAudioPlayer(guildId);
      const skipResult = await skipGuildMusic(guildId, guildPlayer);
      if (!skipResult.skipped && !skipResult.nextTrack) {
        await message.reply("⏭️ 현재 재생 중인 음악이 없습니다.");
        return;
      }
      if (skipResult.nextTrack) {
        setGuildPlaybackMode(guildId, "music");
        const embed = createMusicTrackEmbed(
          skipResult.nextTrack,
          getUserKey(message),
          guildId,
        );
        await message.reply({
          content: `⏭️ **${skipResult.skipped?.title || "이전 곡"}**을(를) 건너뛰고 다음 곡을 재생합니다! (남은 대기열: ${skipResult.remainingQueue}곡)`,
          embeds: [embed],
        });
      } else {
        setGuildPlaybackMode(guildId, "idle");
        await message.reply(
          `⏭️ **${skipResult.skipped?.title || "현재 곡"}**을(를) 건너뛰었습니다. 대기열에 남은 곡이 없어 재생을 마칩니다.`,
        );
      }
      return;
    }
  }

  // 음악 대기열 조회 프리픽스 명령
  if (
    /^(!queue|!큐|!대기열|설아야?\s*(?:노래\s*|음악\s*)?(?:대기열|큐)(?:\s*보여줘|\s*알려줘)?)$/i.test(
      message.content.trim(),
    )
  ) {
    const guildId = message.guild?.id;
    if (guildId) {
      const currentSession = getGuildCurrentTrack(guildId);
      const queue = getGuildMusicQueue(guildId);
      if (!currentSession && queue.length === 0) {
        await message.reply("📜 현재 재생 중인 곡과 대기열이 모두 비어 있습니다.");
        return;
      }
      const nowText = currentSession
        ? `🎶 **현재 재생 중**: ${currentSession.track.title}${currentSession.requesterName ? ` *(신청: ${currentSession.requesterName})*` : ""}`
        : "🎶 **현재 재생 중**: 없음";
      const queueLines =
        queue.length > 0
          ? queue
              .slice(0, 15)
              .map(
                (item, idx) =>
                  `**${idx + 1}.** ${item.track.title}${item.track.isLocal ? " *(로컬)*" : ` (${item.track.formattedDuration})`}${item.requesterName ? ` — ${item.requesterName}` : ""}`,
              )
              .join("\n") +
            (queue.length > 15 ? `\n... 외 ${queue.length - 15}곡` : "")
          : "대기열에 예약된 곡이 없습니다.";
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`📜 음악 대기열 (${queue.length}곡 대기 중)`)
            .setDescription(`${nowText}\n\n**다음 대기 곡**\n${queueLines}`)
            .setFooter({ text: "스킵: !skip • 비우기: !clearqueue" }),
        ],
      });
      return;
    }
  }

  // 음악 대기열 비우기 프리픽스 명령
  if (
    /^(!clearqueue|!대기열비우기|!큐비우기|설아야?\s*(?:대기열|큐)\s*(?:비워줘|초기화|삭제))$/i.test(
      message.content.trim(),
    )
  ) {
    const guildId = message.guild?.id;
    if (guildId) {
      const count = clearGuildMusicQueue(guildId);
      await message.reply(
        count > 0
          ? `🗑️ 음악 대기열에서 **${count}곡**을 모두 비웠습니다.`
          : "📜 이미 음악 대기열이 비어 있습니다.",
      );
      return;
    }
  }

  // 음악 중지 프리픽스 명령
  if (
    message.content === "설아야 노래 꺼" ||
    message.content === "설아야 노래 꺼줘" ||
    message.content === "설아야 노래 멈춰" ||
    message.content === "설아야 노래 멈춰줘" ||
    message.content === "설아야 음악 꺼" ||
    message.content === "설아야 음악 멈춰" ||
    message.content === "!stop" ||
    message.content === "!정지"
  ) {
    const guildId = message.guild?.id;
    if (guildId) {
      stopGuildMusic(guildId);
      getGuildAudioPlayer(guildId).stop();
      setGuildPlaybackMode(guildId, "idle");
      await appendConversationContext(
        getUserKey(message),
        message.content,
        "음악 재생을 중지했습니다.",
      );
      await message.reply("⏹️ 음악 재생을 중지했습니다.");
      return;
    }
  }

  // 음악/유튜브 재생 프리픽스 명령
  const isPlayMusicPrefix =
    (message.content.startsWith("설아야") &&
      (message.content.endsWith("틀어줘") ||
        message.content.endsWith("재생해줘") ||
        message.content.endsWith("틀어") ||
        message.content.endsWith("재생"))) ||
    message.content.startsWith("!play ") ||
    message.content.startsWith("!노래 ") ||
    message.content.startsWith("!음악 ");

  if (isPlayMusicPrefix) {
    let userQuery = "";
    if (message.content.startsWith("!play ")) {
      userQuery = message.content.slice(6).trim();
    } else if (message.content.startsWith("!노래 ")) {
      userQuery = message.content.slice(4).trim();
    } else if (message.content.startsWith("!음악 ")) {
      userQuery = message.content.slice(4).trim();
    } else {
      userQuery = message.content
        .replace(/^설아야?/, "")
        .replace(/(?:틀어줘|재생해줘|틀어|재생)$/, "")
        .trim();
    }

    if (!userQuery) {
      await message.reply("재생할 음악 제목이나 유튜브 링크를 입력해주세요. 예: `설아야 뉴진스 디토 틀어줘` 또는 `!play 아이유 밤편지`");
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

    const loadingMsg = await message.reply(`🔍 \`${userQuery}\` 음원을 탐색 중입니다...`);

    try {
      setGuildPlaybackMode(voiceChannel.guild.id, "music");
      const result = await playMusicTrack({
        guildId: voiceChannel.guild.id,
        query: userQuery,
        player: getGuildAudioPlayer(voiceChannel.guild.id),
        connection,
        requesterName: message.member?.displayName || message.author.username,
        onQueueEnd: () => {
          setGuildPlaybackMode(voiceChannel.guild.id, "idle");
          notifyDashboardStatusChanged(getDashboardStatusSnapshot());
        },
      });

      if (!result.success || !result.track) {
        if (!getGuildCurrentTrack(voiceChannel.guild.id)) {
          setGuildPlaybackMode(voiceChannel.guild.id, "idle");
        }
        await loadingMsg.edit(
          `❌ ${result.errorMessage || "음악을 재생할 수 없습니다."}`,
        );
        return;
      }

      const track = result.track;
      const embed = createMusicTrackEmbed(
        track,
        message.member?.displayName || message.author.username,
        voiceChannel.guild.id,
        result.queued
          ? {
              queued: true,
              ...(result.queuePosition !== undefined
                ? { queuePosition: result.queuePosition }
                : {}),
            }
          : undefined,
      );
      await appendConversationContext(
        getUserKey(message),
        message.content,
        result.queued
          ? `📜 대기열 #${result.queuePosition}번에 ${track.title} 곡을 추가했습니다.`
          : `🎶 ${track.title} 음악 재생을 시작했습니다.`,
      );
      await loadingMsg.edit({ content: null, embeds: [embed] });
      return;
    } catch (error: any) {
      console.error("오디오 리소스 생성 실패:", error);
      if (!getGuildCurrentTrack(voiceChannel.guild.id)) {
        setGuildPlaybackMode(voiceChannel.guild.id, "idle");
      }
      await loadingMsg.edit("오디오를 재생하는 중 오류가 발생했습니다.");
      return;
    }
  }

  // 음악 볼륨 조절 명령어 (!volume, !볼륨, !음량, 설아야 볼륨 ...)
  if (
    /^(!volume|!볼륨|!음량|설아야?\s*(?:음악\s*)?(?:볼륨|음량|소리))/i.test(
      message.content.trim(),
    )
  ) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply("서버(길드) 채널에서만 음량을 조절할 수 있습니다.");
      return;
    }

    const rawInput = message.content
      .replace(/^(!volume|!볼륨|!음량|설아야?\s*(?:음악\s*)?(?:볼륨|음량|소리))\s*/i, "")
      .replace(/(?:으로|로)?\s*(?:바꿔\s*줘|설정해\s*줘|조절해\s*줘|해\s*줘|바꿔|설정|조절)?$/i, "")
      .trim();

    const currentVolume = getGuildMusicVolumePercent(guildId);

    if (!rawInput) {
      await message.reply(
        `🔊 현재 음악 볼륨은 **${currentVolume}%**입니다.\n(변경: \`!volume 20\`, \`!볼륨 35\`, \`!음량 50\`)`,
      );
      return;
    }

    const parsed = parseInt(rawInput.replace(/[^0-9]/g, ""), 10);
    if (isNaN(parsed)) {
      await message.reply(
        `❌ 유효한 볼륨 숫자를 입력해주세요 (0~100).\n현재 볼륨: **${currentVolume}%**`,
      );
      return;
    }

    const { percent } = await setGuildMusicVolume(guildId, parsed);
    notifyDashboardStatusChanged(getDashboardStatusSnapshot());

    await message.reply(
      `🔊 음악 볼륨을 **${percent}%**로 설정했어요! ${percent === 0 ? "🔇 (음소거)" : percent > 70 ? "📢 (매우 큼 주의)" : "✨"}`,
    );
    await appendConversationContext(
      getUserKey(message),
      message.content,
      `음악 볼륨을 ${percent}%로 변경했습니다.`,
    );
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

    getGuildAudioPlayer(voiceChannel.guild.id).stop();
    removeVoiceChatSession(voiceChannel.guild.id);
    connection.destroy();
    notifyDashboardStatusChanged(getDashboardStatusSnapshot());
    await appendConversationContext(
      getUserKey(message),
      message.content,
      "음악 재생 및 음성 대화를 중지하고 음성 채널에서 나왔습니다.",
    );
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
        await appendConversationContext(
          userName,
          message.content,
          `대화 모델이 ${result.model}(으)로 변경되었습니다.`,
        );
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

  // "설아야"로 시작하는 메시지 처리 -> 호출어 "설아야"를 제거하거나 단순 호출 시 자연스럽게 처리
  if (message.content.startsWith("설아야")) {
    const remaining = message.content.replace(/^설아야\s*/, "").trim();
    if (!remaining || /^[.!?~^]+$/.test(remaining)) {
      message.content = "설아야";
      await chatAI(message);
      return;
    }
    message.content = remaining;
    await chatAI(message);
    return;
  }

  // "설아"로 시작하는 메시지 처리 -> 지시어 "설아"도 포함시켜서 LLM으로 넘김
  if (message.content.startsWith("설아")) {
    await chatAI(message);
    return;
  }
};
