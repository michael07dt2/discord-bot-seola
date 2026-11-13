import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  REST,
  Routes,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from "discord.js";
import {
  AudioPlayer,
  getVoiceConnection,
} from "@discordjs/voice";
import {
  generateAIResponse,
  connectToVoiceChannel,
  getAvailableModels,
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
  removeGuildMusicQueueItem,
} from "./youtubeMusic.ts";
import {
  getBotStatusReport,
  getSelfImproveStatusReport,
  performWebSearch,
  runSelfImprovement,
  scheduleBotRestart,
} from "./tools.ts";
import {
  getActiveVoiceSessions,
  getCurrentVoicePreset,
  removeVoiceChatSession,
  setGuildPlaybackMode,
  setVoiceChatEnabled,
  setVoicePreset,
  setupVoiceChatListener,
  speakInVoiceChannel,
  VOICE_PRESETS,
} from "./voiceChat.ts";
import { eq } from "drizzle-orm";
import { db, contextsTable } from "../db/index.ts";
import {
  listUserMemories,
  saveUserMemory,
  deleteUserMemory,
} from "./memoryRag.ts";
import CONFIG from "../config/index.ts";
import {
  notifyDashboardStatusChanged,
  type DashboardStatusSnapshot,
} from "./dashboard.ts";
import { getGuildAudioPlayer } from "./audioPlayer.ts";

// index.ts로부터 공유받을 런타임 의존성 (대시보드 스냅샷 헬퍼)
let sharedStatusSnapshotGetter: (() => DashboardStatusSnapshot) | null = null;

export const setSlashCommandDependencies = (deps: {
  getDashboardStatusSnapshot: () => DashboardStatusSnapshot;
}) => {
  sharedStatusSnapshotGetter = deps.getDashboardStatusSnapshot;
};

// 슬래시 명령어 정의
export const slashCommands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setNameLocalization("ko", "대화")
    .setDescription("설아와 텍스트로 대화를 나눕니다.")
    .addStringOption((opt) =>
      opt
        .setName("message")
        .setNameLocalization("ko", "메시지")
        .setDescription("설아에게 보낼 메시지")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("persona")
    .setNameLocalization("ko", "페르소나")
    .setDescription("설아의 성격과 시스템 프롬프트를 확인하거나 변경합니다.")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalization("ko", "목록")
        .setDescription("사용 가능한 모든 페르소나 목록을 조회합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setNameLocalization("ko", "현재상태")
        .setDescription("현재 내게 적용된 페르소나 정보를 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setNameLocalization("ko", "설정")
        .setDescription("지정한 페르소나로 변경합니다.")
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setNameLocalization("ko", "종류")
            .setDescription("변경할 페르소나를 선택하세요.")
            .setRequired(true)
            .addChoices(
              { name: "설아 (다정한 동갑내기 여자친구)", value: "girlfriend" },
              { name: "설아 비서 (스마트한 AI 비서)", value: "assistant" },
              { name: "츤데레 설아 (소꿉친구)", value: "tsundere" },
              { name: "설아 선배 (듬직한 멘토)", value: "senior" },
              { name: "발랄한 설아 (귀여운 마스코트)", value: "cute" },
              { name: "사용자 정의 (Custom)", value: "custom" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("custom")
        .setNameLocalization("ko", "커스텀프롬프트")
        .setDescription("원하는 시스템 프롬프트를 직접 입력하여 설정합니다.")
        .addStringOption((opt) =>
          opt
            .setName("prompt")
            .setNameLocalization("ko", "프롬프트")
            .setDescription("설아에게 적용할 상세 시스템 프롬프트 내용")
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("voice")
    .setNameLocalization("ko", "음성통화")
    .setDescription("음성 채널 연결 및 실시간 통화를 제어합니다.")
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setNameLocalization("ko", "입장")
        .setDescription("내가 접속한 음성 채널에 설아를 부릅니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("leave")
        .setNameLocalization("ko", "퇴장")
        .setDescription("설아를 음성 채널에서 퇴장시킵니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("pause")
        .setNameLocalization("ko", "음성중지")
        .setDescription("음성 채널에서 듣기/답변을 일시 정지합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("resume")
        .setNameLocalization("ko", "음성재개")
        .setDescription("일시 정지된 음성 듣기/답변을 다시 재개합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setNameLocalization("ko", "상태")
        .setDescription("현재 음성 통화 세션 상태를 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("speak")
        .setNameLocalization("ko", "발화")
        .setDescription("음성 채널에 있는 설아가 지정한 문장을 TTS로 말하게 합니다.")
        .addStringOption((opt) =>
          opt
            .setName("text")
            .setNameLocalization("ko", "말할내용")
            .setDescription("설아가 소리 내어 읽을 문장")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setNameLocalization("ko", "설정")
        .setDescription("설아의 음성(목소리) 프리셋을 변경합니다.")
        .addStringOption((opt) =>
          opt
            .setName("preset")
            .setNameLocalization("ko", "목소리프리셋")
            .setDescription("변경할 음성 프리셋")
            .setRequired(true)
            .addChoices(
              { name: "🤖 케이 (블루아카이브 KEY Qwen3-TTS 복제)", value: "kei" },
              { name: "⚡ 큐웬 (Qwen3-TTS MLX 신경망 음성)", value: "qwen" },
              { name: "🔮 코지 (CosyVoice 3 신경망 음성)", value: "cosy" },
              { name: "🎨 레바 (유튜브 스트리머 레바 CosyVoice)", value: "reva" },
              { name: "🍊 감규리 (유튜브 감규리 CosyVoice)", value: "gamgyuri" },
              { name: "🐱 다시는 만날 수 없는 (Qwen3-TTS)", value: "myoya" },
              { name: "🎨 다시는 만날 수 없는 (CosyVoice)", value: "myoya_cosy" },
              { name: "🌸 설아 (기본 20대 여성톤, MeloTTS)", value: "seola" },
              { name: "✨ 발랄 (톤 업, 귀엽고 밝은 어투)", value: "lively" },
              { name: "☕ 차분 (성숙하고 차분한 어투)", value: "calm" },
              { name: "🌙 속삭임 (나직하고 부드러운 톤)", value: "whisper" },
              { name: "🎙️ 멜로 (중립 원음 기준)", value: "melo" },
              { name: "💎 아바 (Edge 다국어 음성 Ava)", value: "ava" },
              { name: "🎀 선희 (Edge 한국어 음성 SunHi)", value: "sunhi" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalization("ko", "목록")
        .setDescription("사용 가능한 목소리(TTS) 프리셋 목록을 확인합니다."),
    ),

  new SlashCommandBuilder()
    .setName("preset")
    .setNameLocalization("ko", "목소리")
    .setDescription("MeloTTS-Korean 음성 프리셋을 변경하거나 조회합니다.")
    .addStringOption((opt) =>
      opt
        .setName("voice")
        .setNameLocalization("ko", "목소리선택")
        .setDescription("변경할 음성 프리셋")
        .setRequired(false)
        .addChoices(
          { name: "🤖 케이 (블루아카이브 KEY 복제 음성)", value: "kei" },
          { name: "⚡ 큐웬 (Qwen3-TTS MLX 신경망 음성)", value: "qwen" },
          { name: "🔮 코지 (CosyVoice 3 신경망 음성)", value: "cosy" },
          { name: "🎨 레바 (유튜브 스트리머 레바 CosyVoice)", value: "reva" },
          { name: "🍊 감규리 (유튜브 감규리 CosyVoice)", value: "gamgyuri" },
          { name: "🐱 다시는 만날 수 없는 (Qwen3-TTS)", value: "myoya" },
          { name: "🎨 다시는 만날 수 없는 (CosyVoice)", value: "myoya_cosy" },
          { name: "🌸 설아 (기본 20대 여성톤, MeloTTS)", value: "seola" },
          { name: "✨ 발랄 (톤 업, 귀엽고 밝은 어투)", value: "lively" },
          { name: "☕ 차분 (성숙하고 차분한 어투)", value: "calm" },
          { name: "🌙 속삭임 (나직하고 부드러운 톤)", value: "whisper" },
          { name: "🎙️ 멜로 (중립 원음 기준)", value: "melo" },
          { name: "💎 아바 (Edge 다국어 음성 Ava)", value: "ava" },
          { name: "🎀 선희 (Edge 한국어 음성 SunHi)", value: "sunhi" },
        ),
    ),

  new SlashCommandBuilder()
    .setName("model")
    .setNameLocalization("ko", "모델")
    .setDescription("Ollama 대화 모델을 확인하거나 변경합니다.")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalization("ko", "목록")
        .setDescription("사용 가능한 로컬 Ollama 모델 목록을 조회합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setNameLocalization("ko", "현재상태")
        .setDescription("현재 내게 설정된 대화 모델을 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setNameLocalization("ko", "변경")
        .setDescription("대화 모델을 변경합니다.")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setNameLocalization("ko", "모델명")
            .setDescription("변경할 모델명 (예: gemma4:12b, gemma4)")
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("music")
    .setNameLocalization("ko", "음악")
    .setDescription("음성 채널에서 로컬 음악 또는 유튜브 노래를 재생하거나 멈춥니다.")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setNameLocalization("ko", "재생")
        .setDescription("로컬 음원 또는 유튜브 노래를 검색하여 재생합니다.")
        .addStringOption((opt) =>
          opt
            .setName("query")
            .setNameLocalization("ko", "곡명_또는_링크")
            .setDescription("곡명, 아티스트, 또는 유튜브 URL (예: 아이유 밤편지, 뉴진스 Ditto)")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setNameLocalization("ko", "중지")
        .setDescription("현재 재생 중인 음악을 중지합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("now")
        .setNameLocalization("ko", "현재곡")
        .setDescription("현재 재생 중인 음악 정보를 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalization("ko", "목록")
        .setDescription("재생 가능한 로컬 음악 목록을 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("skip")
        .setNameLocalization("ko", "건너뛰기")
        .setDescription("현재 재생 중인 곡을 건너뛰고 대기열의 다음 곡을 재생합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("queue")
        .setNameLocalization("ko", "대기열")
        .setDescription("현재 재생 중인 곡과 대기열(큐) 목록을 확인합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setNameLocalization("ko", "대기열비우기")
        .setDescription("음악 대기열(큐)에 예약된 곡을 모두 비웁니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setNameLocalization("ko", "대기열삭제")
        .setDescription("대기열에서 지정한 번호의 곡을 삭제합니다.")
        .addIntegerOption((opt) =>
          opt
            .setName("index")
            .setNameLocalization("ko", "번호")
            .setDescription("삭제할 대기열 순번 (1부터 시작)")
            .setMinValue(1)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("volume")
        .setNameLocalization("ko", "음량")
        .setDescription("음악 재생 볼륨을 확인하거나 조절합니다 (0~100%).")
        .addIntegerOption((opt) =>
          opt
            .setName("percent")
            .setNameLocalization("ko", "퍼센트")
            .setDescription("설정할 볼륨 (0~100, 기본 20%)")
            .setMinValue(0)
            .setMaxValue(100)
            .setRequired(false),
        ),
    ),

  new SlashCommandBuilder()
    .setName("volume")
    .setNameLocalization("ko", "볼륨")
    .setDescription("음악 재생 볼륨을 확인하거나 조절합니다 (0~100%).")
    .addIntegerOption((opt) =>
      opt
        .setName("percent")
        .setNameLocalization("ko", "퍼센트")
        .setDescription("설정할 볼륨 (0~100, 기본 20%)")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("search")
    .setNameLocalization("ko", "검색")
    .setDescription("실시간 웹, 뉴스, 위키 정보를 검색합니다.")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setNameLocalization("ko", "검색어")
        .setDescription("검색할 키워드나 질문")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("improve")
    .setNameLocalization("ko", "자기개선")
    .setDescription("Antigravity CLI(agy) 또는 Hermes를 호출해 봇을 개선합니다.")
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setNameLocalization("ko", "진행상태")
        .setDescription("현재 자기개선 에이전트(agy)의 작업 상태를 조회합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("run")
        .setNameLocalization("ko", "지시실행")
        .setDescription("자기개선 작업을 지시합니다.")
        .addStringOption((opt) =>
          opt
            .setName("instruction")
            .setNameLocalization("ko", "지시내용")
            .setDescription("개선하거나 추가할 기능 설명")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("engine")
            .setNameLocalization("ko", "엔진")
            .setDescription("사용할 에이전트 엔진 (기본값: agy)")
            .setRequired(false)
            .addChoices(
              { name: "Antigravity CLI (agy)", value: "agy" },
              { name: "Hermes CLI (hermes)", value: "hermes" },
            ),
        ),
    ),

  new SlashCommandBuilder()
    .setName("restart")
    .setNameLocalization("ko", "재시작")
    .setDescription("설아 봇 프로세스를 안전하게 재시작합니다.")
    .addStringOption((opt) =>
      opt
        .setName("reason")
        .setNameLocalization("ko", "사유")
        .setDescription("재시작 사유")
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setNameLocalization("ko", "상태")
    .setDescription("봇 시스템 상태, 리소스, 음성 통화 상태를 확인합니다."),

  new SlashCommandBuilder()
    .setName("dashboard")
    .setNameLocalization("ko", "대시보드")
    .setDescription("실시간 음성 대화록 및 봇 상태 웹 대시보드 URL을 확인합니다."),

  new SlashCommandBuilder()
    .setName("clear")
    .setNameLocalization("ko", "대화초기화")
    .setDescription("설아와의 이전 대화 기록을 모두 비우고 새로운 대화를 시작합니다."),

  new SlashCommandBuilder()
    .setName("memory")
    .setNameLocalization("ko", "기억")
    .setDescription("설아가 기억하고 있는 사용자의 개인화 장기 기억(RAG)을 관리합니다.")
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setNameLocalization("ko", "목록")
        .setDescription("설아가 기억하고 있는 내 선호/취향/정보 목록을 조회합니다."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setNameLocalization("ko", "추가")
        .setDescription("설아에게 기억시킬 새로운 정보를 직접 추가합니다.")
        .addStringOption((opt) =>
          opt
            .setName("content")
            .setNameLocalization("ko", "내용")
            .setDescription("기억할 정보 (예: 내 생일은 5월 12일이야, 초콜릿을 좋아해)")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("category")
            .setNameLocalization("ko", "분류")
            .setDescription("기억 카테고리")
            .setRequired(false)
            .addChoices(
              { name: "일반/취향", value: "preference" },
              { name: "신상/기념일", value: "profile" },
              { name: "취미/여가", value: "hobby" },
              { name: "음식/식습관", value: "food" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setNameLocalization("ko", "삭제")
        .setDescription("저장된 기억을 ID로 삭제합니다.")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setNameLocalization("ko", "기억번호")
            .setDescription("삭제할 기억의 고유 번호 (ID)")
            .setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setNameLocalization("ko", "도움말")
    .setDescription("설아 봇의 전체 기능과 슬래시 명령어 안내를 확인합니다."),
];

// 디스코드 API에 슬래시 명령어 등록
export const registerSlashCommands = async (client: Client): Promise<void> => {
  const token = CONFIG.DISCORD_TOKEN;
  const appId = CONFIG.APP_ID || client.user?.id;

  if (!token || !appId) {
    console.warn(
      "슬래시 명령어 등록 건너뜀: DISCORD_TOKEN 또는 APP_ID가 설정되지 않았습니다.",
    );
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    const commandsJson = slashCommands.map((cmd) => cmd.toJSON());

    console.log(`[SlashCommands] 총 ${commandsJson.length}개의 슬래시 명령어 등록을 시작합니다...`);

    // 글로벌 명령어 등록 (전체 길드 적용)
    await rest.put(Routes.applicationCommands(appId), {
      body: commandsJson,
    });

    console.log(`[SlashCommands] 총 ${commandsJson.length}개의 슬래시 명령어가 성공적으로 등록되었습니다!`);
  } catch (error) {
    console.error("[SlashCommands] 슬래시 명령어 등록 중 오류 발생:", error);
  }
};

// 슬래시 인터랙션 이벤트 처리 핸들러
export const handleSlashCommand = async (
  interaction: ChatInputCommandInteraction,
): Promise<void> => {
  const { commandName } = interaction;
  const userName =
    (interaction.member as GuildMember)?.displayName ||
    interaction.user.username;

  console.log(`[SlashCommands] 📥 슬래시 명령어 수신: /${commandName} (유저: ${userName})`);

  // 1. 디스코드 3초 타임아웃("The application didn't respond in time")을 원천 방지하기 위해 진입 즉시 지연 응답 등록
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }
  } catch (deferErr) {
    console.warn(`[SlashCommands] deferReply 호출 실패 (이미 응답되었거나 만료됨):`, deferErr);
    return;
  }

  try {
    // 1. /chat (대화)
    if (commandName === "chat") {
      const message = interaction.options.getString("message", true);

      // AI 응답 생성
      const reply = await generateAIResponse(userName, message, {
        channel: interaction.channel?.isSendable() ? interaction.channel : null,
      });

      if (reply) {
        await interaction.editReply(reply.slice(0, 2000));
      } else {
        await interaction.editReply("미안해, 지금은 대답하기가 조금 어려워.");
      }
      return;
    }

    // 2. /persona (페르소나)
    if (commandName === "persona") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const embed = new EmbedBuilder()
          .setColor(0xff85a2)
          .setTitle("🎭 설아 페르소나(시스템 프롬프트) 목록")
          .setDescription("사용자별로 각기 다른 성격과 대화 스타일을 적용할 수 있습니다.")
          .addFields(
            Object.values(PERSONA_DEFINITIONS).map((p) => ({
              name: `${p.name} (\`${p.id}\`)`,
              value: `${p.tagline}\n*${p.description}* (추천 목소리: \`${p.recommendedVoice}\`)`,
            })),
          )
          .setFooter({ text: "설정 방법: /persona set [종류] 또는 !persona <이름>" });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === "status") {
        const current = await getUserPersona(userName);
        const def = PERSONA_DEFINITIONS[current.personaId] || PERSONA_DEFINITIONS.girlfriend;
        let desc = `**${userName}**님의 현재 페르소나는 **${def.name}** 입니다.\n\n*특징:* ${def.tagline}`;
        if (current.customPrompt) {
          desc += `\n\n*지정된 커스텀 프롬프트:*\n\`\`\`${current.customPrompt.slice(0, 800)}\`\`\``;
        }

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle("🎭 현재 페르소나 설정")
              .setDescription(desc),
          ],
        });
        return;
      }

      if (sub === "set") {
        const type = interaction.options.getString("type", true) as PersonaId;
        const result = await setUserPersona(userName, type);
        await appendConversationContext(
          userName,
          `/persona set type:${type}`,
          `페르소나가 ${result.persona.name}(으)로 변경되었습니다.`,
        );
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle("🎭 페르소나 변경 완료!")
              .setDescription(
                `**${userName}**님의 페르소나가 **${result.persona.name}**(으)로 변경되었습니다.\n\n*특징:* ${result.persona.tagline}\n*추천 목소리:* \`${result.persona.recommendedVoice}\` (원하시면 \`/preset voice:${result.persona.recommendedVoice}\` 로 변경 가능)`,
              ),
          ],
        });
        return;
      }

      if (sub === "custom") {
        const prompt = interaction.options.getString("prompt", true);
        await setUserPersona(userName, "custom", prompt);
        await appendConversationContext(
          userName,
          `/persona custom prompt:${prompt}`,
          "사용자 정의(Custom) 시스템 프롬프트가 설정되었습니다.",
        );
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle("🎭 사용자 정의(Custom) 페르소나 등록 완료!")
              .setDescription(
                `**${userName}**님만의 커스텀 시스템 프롬프트가 설정되었습니다.\n\n*설정된 프롬프트:*\n\`\`\`${prompt.slice(0, 1000)}\`\`\``,
              ),
          ],
        });
        return;
      }
    }

    // 3. /voice (음성통화)
    if (commandName === "voice") {
      const sub = interaction.options.getSubcommand();
      const member = interaction.member as GuildMember;
      const voiceChannel = member?.voice?.channel as VoiceBasedChannel | null;

      if (sub === "join") {
        if (!voiceChannel) {
          await interaction.editReply("❌ 먼저 음성 채널에 입장한 후 명령어를 실행해주세요!");
          return;
        }

        try {
          const guildPlayer = getGuildAudioPlayer(voiceChannel.guild.id);
          const connection = await connectToVoiceChannel(voiceChannel);
          setupVoiceChatListener({
            client: interaction.client,
            connection,
            voiceChannel,
            textChannel: interaction.channel?.isSendable() ? interaction.channel : null,
            player: guildPlayer,
          });
          if (sharedStatusSnapshotGetter) {
            notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
          }
          await appendConversationContext(
            userName,
            "/voice join",
            `${voiceChannel.name} 음성 채널에 입장했습니다.`,
          );
          await interaction.editReply(
            `🌸 **${voiceChannel.name}** 음성 채널에 설아가 입장했습니다! 이제 자유롭게 말씀해 보세요. (1:1 통화 시 즉시 대화, 다수일 땐 '설아야' 호출)`,
          );
        } catch (err: any) {
          await interaction.editReply(`❌ 음성 채널 입장 실패: ${err.message}`);
        }
        return;
      }

      if (sub === "leave") {
        if (!interaction.guildId) {
          await interaction.editReply("서버에서만 실행 가능합니다.");
          return;
        }
        removeVoiceChatSession(interaction.guildId);
        if (sharedStatusSnapshotGetter) {
          notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
        }
        await appendConversationContext(
          userName,
          "/voice leave",
          "음성 채널에서 퇴장했습니다.",
        );
        await interaction.editReply("👋 음성 채널에서 퇴장했습니다. 다음에 또 불러줘!");
        return;
      }

      if (sub === "pause") {
        if (!interaction.guildId) return;
        setVoiceChatEnabled(interaction.guildId, false);
        if (sharedStatusSnapshotGetter) {
          notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
        }
        await interaction.editReply("🤫 음성 통화 듣기를 일시 중지했습니다. 재개하려면 `/voice resume`을 입력하세요.");
        return;
      }

      if (sub === "resume") {
        if (!interaction.guildId) return;
        setVoiceChatEnabled(interaction.guildId, true);
        if (sharedStatusSnapshotGetter) {
          notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
        }
        await interaction.editReply("🎙️ 음성 통화를 재개했습니다! 다시 말씀해 보세요.");
        return;
      }

      if (sub === "status") {
        const sessions = getActiveVoiceSessions();
        const currentSession = interaction.guildId
          ? sessions.find((s) => s.guildId === interaction.guildId)
          : null;

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("🎙️ 음성 통화 상태")
          .setDescription(
            currentSession
              ? `• 접속 채널: **${currentSession.channelName}**\n• 현재 상태: **${currentSession.voiceChatEnabled ? "🟢 활성 (경청 중)" : "⏸️ 일시 정지"}**\n• 재생 모드: \`${currentSession.playbackMode}\`\n• 활성 화자 수: ${currentSession.activeSpeakerCount}명`
              : "현재 이 서버의 음성 채널에 접속해 있지 않습니다. `/voice join`으로 불러보세요!",
          );
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === "speak") {
        const text = interaction.options.getString("text", true);
        if (!interaction.guildId) return;

        const connection = getVoiceConnection(interaction.guildId);
        if (!connection) {
          await interaction.editReply(
            "❌ 설아가 현재 이 서버의 음성 채널에 연결되어 있지 않습니다. 먼저 `/voice join`으로 불러주세요!",
          );
          return;
        }

        try {
          await speakInVoiceChannel(
            connection,
            getGuildAudioPlayer(interaction.guildId),
            interaction.guildId,
            text,
          );
          await appendConversationContext(
            userName,
            `/voice speak text:${text}`,
            text,
          );
          await interaction.editReply(`🗣️ **${userName}**님의 요청으로 발화했습니다: "${text}"`);
        } catch (err: any) {
          console.error("[SlashCommands] voice speak 실패:", err);
          await interaction.editReply("❌ 음성 발화 중 오류가 발생했습니다.");
        }
        return;
      }

      if (sub === "list") {
        const current = getCurrentVoicePreset();
        const listText = Object.values(VOICE_PRESETS)
          .map((p) => `• **${p.label}** (\`${p.id}\`) — ${p.description}`)
          .join("\n");

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff85a2)
              .setTitle("🗣️ 설아 목소리(TTS) 프리셋 목록")
              .setDescription(
                `현재 적용된 목소리: **${current.label}** (\`${current.id}\`)\n\n${listText}`,
              )
              .setFooter({ text: "변경: /voice set preset:<프리셋명> 또는 /preset voice:<프리셋명>" }),
          ],
        });
        return;
      }

      if (sub === "set") {
        const targetVoice = interaction.options.getString("preset", true);
        const updated = await setVoicePreset(targetVoice);
        if (!updated) {
          await interaction.editReply(`❌ \`${targetVoice}\` 목소리 프리셋을 찾을 수 없습니다.`);
          return;
        }

        if (sharedStatusSnapshotGetter) {
          notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
        }
        await appendConversationContext(
          userName,
          `/voice set preset:${targetVoice}`,
          `목소리가 ${updated.label}(${updated.id})로 변경되었습니다.`,
        );

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x57f287)
              .setTitle("🗣️ 목소리 프리셋 변경 완료")
              .setDescription(
                `설아의 목소리가 **${updated.label}** (\`${updated.id}\`)(으)로 변경되었습니다!\n*설명:* ${updated.description}`,
              ),
          ],
        });

        // 음성 채널에 연결되어 있다면 샘플 인사 발화
        if (interaction.guildId) {
          const connection = getVoiceConnection(interaction.guildId);
          if (connection) {
            await speakInVoiceChannel(
              connection,
              getGuildAudioPlayer(interaction.guildId),
              interaction.guildId,
              "목소리를 바꿔봤는데 어때? 마음에 들어?",
            ).catch(() => {});
          }
        }
        return;
      }
    }

    // 4. /preset (목소리)
    if (commandName === "preset") {
      const selected = interaction.options.getString("voice");
      if (!selected) {
        const current = getCurrentVoicePreset();
        const listText = Object.values(VOICE_PRESETS)
          .map((p) => `• **${p.label}** (\`${p.id}\`) — ${p.description}`)
          .join("\n");

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff85a2)
              .setTitle("🗣️ 설아 목소리(TTS) 프리셋 목록")
              .setDescription(
                `현재 적용된 목소리: **${current.label}** (\`${current.id}\`)\n\n${listText}`,
              )
              .setFooter({ text: "변경: /preset voice:<프리셋명>" }),
          ],
        });
        return;
      }

      const updated = await setVoicePreset(selected);
      if (!updated) {
        await interaction.editReply(`❌ \`${selected}\` 목소리 프리셋을 찾을 수 없습니다.`);
        return;
      }

      if (sharedStatusSnapshotGetter) {
        notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
      }
      await appendConversationContext(
        userName,
        `/preset voice:${selected}`,
        `목소리가 ${updated.label}(${updated.id})로 변경되었습니다.`,
      );
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle("🗣️ 목소리 프리셋 변경 완료")
            .setDescription(
              `설아의 목소리가 **${updated.label}** (\`${updated.id}\`)(으)로 변경되었습니다!\n*설명:* ${updated.description}`,
            ),
        ],
      });
      return;
    }

    // 5. /model (모델)
    if (commandName === "model") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const [available, current] = await Promise.all([
          getAvailableModels(),
          getUserModel(userName),
        ]);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle("🤖 로컬 Ollama 모델 목록")
              .setDescription(
                `**${userName}**님의 현재 모델: \`${current}\`\n\n**사용 가능한 모델:**\n${available.map((m) => `• \`${m}\``).join("\n")}`,
              ),
          ],
        });
        return;
      }

      if (sub === "status") {
        const current = await getUserModel(userName);
        await interaction.editReply(`🤖 **${userName}**님의 현재 대화 모델은 \`${current}\` 입니다.`);
        return;
      }

      if (sub === "set") {
        const target = interaction.options.getString("name", true);
        const result = await setUserModel(userName, target);
        if (result.success && result.model) {
          await appendConversationContext(
            userName,
            `/model set name:${target}`,
            `대화 모델이 ${result.model}(으)로 변경되었습니다.`,
          );
          await interaction.editReply(
            `🤖 **${userName}**님의 대화 모델이 \`${result.model}\`(으)로 변경되었습니다.`,
          );
        } else {
          await interaction.editReply(
            `❌ \`${target}\` 모델을 찾을 수 없습니다.\n사용 가능한 모델: ${result.availableModels.map((m) => `\`${m}\``).join(", ")}`,
          );
        }
        return;
      }
    }

    // 6. /music (음악)
    if (commandName === "music") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const listText = Object.keys(songMap)
          .map((title) => `• \`${title}\``)
          .join(", ");
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xff85a2)
              .setTitle("🎵 재생 가능한 로컬 노래 목록")
              .setDescription(`${listText}\n\n*유튜브 곡은 \`/music play query:<곡명 또는 유튜브 링크>\`로 바로 재생할 수 있어요!*`)
              .setFooter({ text: "재생: /music play query:<곡명/링크>" }),
          ],
        });
        return;
      }

      if (sub === "stop") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        stopGuildMusic(interaction.guildId);
        getGuildAudioPlayer(interaction.guildId).stop();
        setGuildPlaybackMode(interaction.guildId, "idle");
        await appendConversationContext(
          userName,
          "/music stop",
          "음악 재생을 중지했습니다.",
        );
        await interaction.editReply("⏹️ 음악 재생 및 대기열을 모두 중지했습니다.");
        return;
      }

      if (sub === "skip") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        const guildPlayer = getGuildAudioPlayer(interaction.guildId);
        const skipResult = await skipGuildMusic(interaction.guildId, guildPlayer);
        if (!skipResult.skipped && !skipResult.nextTrack) {
          await interaction.editReply("⏭️ 현재 재생 중인 음악이 없습니다.");
          return;
        }
        if (skipResult.nextTrack) {
          setGuildPlaybackMode(interaction.guildId, "music");
          const embed = createMusicTrackEmbed(
            skipResult.nextTrack,
            userName,
            interaction.guildId,
          );
          await interaction.editReply({
            content: `⏭️ **${skipResult.skipped?.title || "이전 곡"}**을(를) 건너뛰고 다음 곡을 재생합니다! (남은 대기열: ${skipResult.remainingQueue}곡)`,
            embeds: [embed],
          });
        } else {
          setGuildPlaybackMode(interaction.guildId, "idle");
          await interaction.editReply(
            `⏭️ **${skipResult.skipped?.title || "현재 곡"}**을(를) 건너뛰었습니다. 대기열에 남은 곡이 없어 재생을 마칩니다.`,
          );
        }
        return;
      }

      if (sub === "queue") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        const currentSession = getGuildCurrentTrack(interaction.guildId);
        const queue = getGuildMusicQueue(interaction.guildId);

        if (!currentSession && queue.length === 0) {
          await interaction.editReply("📜 현재 재생 중인 곡과 대기열이 모두 비어 있습니다.");
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

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`📜 음악 대기열 (${queue.length}곡 대기 중)`)
              .setDescription(`${nowText}\n\n**다음 대기 곡**\n${queueLines}`)
              .setFooter({ text: "건너뛰기: /music skip • 삭제: /music remove • 비우기: /music clear" }),
          ],
        });
        return;
      }

      if (sub === "clear") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        const removedCount = clearGuildMusicQueue(interaction.guildId);
        await interaction.editReply(
          removedCount > 0
            ? `🗑️ 음악 대기열에서 **${removedCount}곡**을 모두 비웠습니다.`
            : "📜 이미 음악 대기열이 비어 있습니다.",
        );
        return;
      }

      if (sub === "remove") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        const index = interaction.options.getInteger("index", true);
        const removed = removeGuildMusicQueueItem(interaction.guildId, index);
        if (!removed) {
          await interaction.editReply(`❌ 대기열 ${index}번에 해당하는 곡을 찾을 수 없습니다.`);
          return;
        }
        await interaction.editReply(
          `🗑️ 대기열 **#${index}번** 곡(**${removed.track.title}**)을 삭제했습니다.`,
        );
        return;
      }

      if (sub === "now") {
        if (!interaction.guildId) {
          await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
          return;
        }
        const currentSession = getGuildCurrentTrack(interaction.guildId);
        if (!currentSession) {
          await interaction.editReply("현재 재생 중인 음악이 없습니다.");
          return;
        }

        const track = currentSession.track;
        if (track.isLocal) {
          await interaction.editReply(`🎶 현재 **${track.title}** (로컬 음원) 재생 중입니다.`);
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle(`🎶 현재 재생 중: ${track.title}`)
          .setURL(track.url)
          .addFields(
            { name: "채널", value: track.uploader || "YouTube", inline: true },
            { name: "재생 시간", value: track.formattedDuration, inline: true },
            { name: "신청자", value: currentSession.requesterName || "알 수 없음", inline: true },
          );
        if (track.thumbnail) {
          embed.setThumbnail(track.thumbnail);
        }
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === "volume") {
        if (!interaction.guildId) return;
        const inputPercent = interaction.options.getInteger("percent");
        const current = getGuildMusicVolumePercent(interaction.guildId);

        if (inputPercent === null || inputPercent === undefined) {
          await interaction.editReply(
            `🔊 현재 음악 재생 볼륨은 **${current}%**입니다.\n조절하려면 \`/music volume percent:<0~100>\` 또는 \`/volume percent:<0~100>\`을 사용하세요.`,
          );
          return;
        }

        const { percent } = await setGuildMusicVolume(interaction.guildId, inputPercent);
        if (sharedStatusSnapshotGetter) {
          notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
        }

        await appendConversationContext(
          userName,
          `/music volume percent:${percent}`,
          `음악 볼륨을 ${percent}%로 변경했습니다.`,
        );
        await interaction.editReply(
          `🔊 음악 볼륨을 **${percent}%**로 설정했습니다! ${percent === 0 ? "🔇 (음소거)" : percent > 70 ? "📢 (매우 큼 주의)" : "✨"}`,
        );
        return;
      }

      if (sub === "play") {
        const query =
          interaction.options.getString("query") ||
          interaction.options.getString("title") ||
          "";

        if (!query.trim()) {
          await interaction.editReply("❌ 재생할 곡명이나 유튜브 링크를 입력해주세요.");
          return;
        }

        const member = interaction.member as GuildMember;
        const voiceChannel = member?.voice?.channel as VoiceBasedChannel | null;
        if (!voiceChannel) {
          await interaction.editReply("❌ 먼저 음성 채널에 입장한 후 음악을 재생해주세요!");
          return;
        }

        try {
          const guildPlayer = getGuildAudioPlayer(voiceChannel.guild.id);
          const connection = await connectToVoiceChannel(voiceChannel);
          setupVoiceChatListener({
            client: interaction.client,
            connection,
            voiceChannel,
            textChannel: interaction.channel?.isSendable() ? interaction.channel : null,
            player: guildPlayer,
          });

          // 음악 모드로 전환 및 탐색/재생 시작
          setGuildPlaybackMode(voiceChannel.guild.id, "music");

          const playResult = await playMusicTrack({
            guildId: voiceChannel.guild.id,
            query,
            player: guildPlayer,
            connection,
            requesterName: userName,
            onQueueEnd: () => {
              setGuildPlaybackMode(voiceChannel.guild.id, "idle");
              if (sharedStatusSnapshotGetter) {
                notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
              }
            },
          });

          if (!playResult.success || !playResult.track) {
            if (!getGuildCurrentTrack(voiceChannel.guild.id)) {
              setGuildPlaybackMode(voiceChannel.guild.id, "idle");
            }
            await interaction.editReply(
              `❌ ${playResult.errorMessage || "음악을 재생할 수 없습니다."}`,
            );
            return;
          }

          const track = playResult.track;
          const embed = createMusicTrackEmbed(
            track,
            userName,
            voiceChannel.guild.id,
            playResult.queued
              ? {
                  queued: true,
                  ...(playResult.queuePosition !== undefined
                    ? { queuePosition: playResult.queuePosition }
                    : {}),
                }
              : undefined,
          );
          await appendConversationContext(
            userName,
            `/music play query:${query}`,
            playResult.queued
              ? `📜 대기열 #${playResult.queuePosition}번에 ${track.title} 곡을 추가했습니다.`
              : `🎶 ${track.title} 음악 재생을 시작했습니다.`,
          );
          await interaction.editReply({ embeds: [embed] });
        } catch (e: any) {
          console.error("음악 재생 연결 실패:", e);
          setGuildPlaybackMode(voiceChannel.guild.id, "idle");
          await interaction.editReply("❌ 음악 재생 중 예기치 못한 오류가 발생했습니다.");
        }
        return;
      }
    }

    // 7. /volume (음악 볼륨 조절)
    if (commandName === "volume") {
      if (!interaction.guildId) {
        await interaction.editReply("❌ 서버(길드) 채널에서만 사용할 수 있습니다.");
        return;
      }
      const inputPercent = interaction.options.getInteger("percent");
      const current = getGuildMusicVolumePercent(interaction.guildId);

      if (inputPercent === null || inputPercent === undefined) {
        await interaction.editReply(
          `🔊 현재 음악 볼륨은 **${current}%**입니다.\n(변경: \`/volume percent:<0~100>\`)`,
        );
        return;
      }

      const { percent } = await setGuildMusicVolume(interaction.guildId, inputPercent);
      if (sharedStatusSnapshotGetter) {
        notifyDashboardStatusChanged(sharedStatusSnapshotGetter());
      }

      await appendConversationContext(
        userName,
        `/volume percent:${percent}`,
        `음악 볼륨을 ${percent}%로 변경했습니다.`,
      );
      await interaction.editReply(
        `🔊 음악 볼륨을 **${percent}%**로 설정했습니다! ${percent === 0 ? "🔇 (음소거)" : percent > 70 ? "📢 (매우 큼 주의)" : "✨"}`,
      );
      return;
    }

    // 8. /search (검색)
    if (commandName === "search") {
      const query = interaction.options.getString("query", true);
      const result = await performWebSearch(query);
      await appendConversationContext(
        userName,
        `/search query:${query}`,
        `검색 결과: ${result.slice(0, 300)}`,
      );
      await interaction.editReply(`🔍 **검색 결과: "${query}"**\n\n${result.slice(0, 1900)}`);
      return;
    }

    // 8. /improve (자기개선)
    if (commandName === "improve") {
      const sub = interaction.options.getSubcommand();

      if (sub === "status") {
        const report = await getSelfImproveStatusReport();
        await interaction.editReply(`🛠️ **자기개선 에이전트(agy) 상태**\n${report}`);
        return;
      }

      if (sub === "run") {
        const instruction = interaction.options.getString("instruction", true);
        const engine = (interaction.options.getString("engine") || "agy") as "agy" | "hermes";

        try {
          const statusMsg = await runSelfImprovement({
            instruction,
            engine,
            channel: interaction.channel?.isSendable() ? interaction.channel : null,
          });
          await interaction.editReply(statusMsg);
        } catch (err: any) {
          await interaction.editReply(`❌ 자기개선 실행 오류: ${err.message}`);
        }
        return;
      }
    }

    // 9. /restart (재시작)
    if (commandName === "restart") {
      const reason =
        interaction.options.getString("reason") ||
        `${userName}님의 슬래시 명령어 요청`;
      const msg = scheduleBotRestart(reason);
      await interaction.editReply(`🔄 ${msg}`);
      return;
    }

    // 10. /status (상태)
    if (commandName === "status") {
      const report = await getBotStatusReport();
      await interaction.editReply(`📊 **설아 봇 상태 보고서**\n${report}`);
      return;
    }

    // 11. /dashboard (실시간 웹 대시보드)
    if (commandName === "dashboard") {
      const dashboardUrl = CONFIG.DASHBOARD_URL;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📊 설아 실시간 웹 대시보드")
        .setDescription(
          `음성 채널 실시간 대화록과 봇의 상태를 웹 브라우저에서 편리하게 확인하고 제어할 수 있습니다.\n\n👉 **[대시보드 바로가기](${dashboardUrl})**\n\`${dashboardUrl}\``,
        )
        .addFields(
          {
            name: "음성 통화 세션",
            value: `${getActiveVoiceSessions().length}개 활성 중`,
            inline: true,
          },
          {
            name: "현재 목소리",
            value: getCurrentVoicePreset().label,
            inline: true,
          },
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // 12. /clear (대화 기록 초기화)
    if (commandName === "clear") {
      try {
        await db.delete(contextsTable).where(eq(contextsTable.name, userName));
        await interaction.editReply(
          `🧹 **${userName}**님과의 이전 대화 기록을 모두 깨끗이 비웠어요! 이제 새로운 기분으로 대화해요.`,
        );
      } catch (err: any) {
        console.error("[SlashCommands] 대화 초기화 실패:", err);
        await interaction.editReply("❌ 대화 기록을 초기화하는 중 오류가 발생했습니다.");
      }
      return;
    }

    // 13. /memory (개인화 장기 기억 RAG 관리)
    if (commandName === "memory") {
      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const memories = await listUserMemories(userName);
        if (memories.length === 0) {
          await interaction.editReply(
            `📝 아직 **${userName}**님에 대해 기억하고 있는 내용이 없어요.\n\`/memory add content:<내용>\`으로 설아에게 알려주시거나, 평소처럼 대화하시면 설아가 자동으로 기억해요!`,
          );
          return;
        }

        const lines = memories
          .map(
            (m) =>
              `• **[#${m.id}]** \`${m.category}\` ${m.memory} *(중요도: ${m.importance})*`,
          )
          .join("\n");

        const embed = new EmbedBuilder()
          .setColor(0xff85a2)
          .setTitle(`🧠 ${userName}님의 개인화 장기 기억 (${memories.length}개)`)
          .setDescription(lines)
          .setFooter({
            text: "기억 삭제: /memory delete id:<기억번호> | 추가: /memory add",
          });

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (sub === "add") {
        const content = interaction.options.getString("content", true);
        const category = interaction.options.getString("category") || "preference";
        await saveUserMemory({
          userName,
          memory: content,
          category,
          importance: 3,
        });
        await interaction.editReply(
          `✨ **${userName}**님의 소중한 정보를 기억했어요!\n\n> \`${category}\` ${content}\n\n앞으로 대화할 때 잊지 않고 참고할게요!`,
        );
        return;
      }

      if (sub === "delete") {
        const id = interaction.options.getInteger("id", true);
        const deleted = await deleteUserMemory(id);
        if (deleted) {
          await interaction.editReply(`🗑️ 기억 **#${id}**번을 성공적으로 삭제했습니다.`);
        } else {
          await interaction.editReply(`❌ 기억 **#${id}**번을 찾을 수 없거나 삭제에 실패했습니다.`);
        }
        return;
      }
    }

    // 14. /help (도움말)
    if (commandName === "help") {
      const currentPreset = getCurrentVoicePreset();
      const userPersona = await getUserPersona(userName);
      const personaDef =
        PERSONA_DEFINITIONS[userPersona.personaId] || PERSONA_DEFINITIONS.girlfriend;

      const embed = new EmbedBuilder()
        .setColor(0xff85a2)
        .setTitle("🌸 설아 봇 (Seola Bot) 슬래시 & 프리픽스 도움말")
        .setDescription(
          "로컬 AI(Ollama Gemma4) 기반 텍스트 채팅, 음성 대화, 페르소나 교체, 자율 개선을 지원합니다.",
        )
        .addFields(
          {
            name: "💬 대화 및 페르소나 설정",
            value: [
              `\`/persona set\` 또는 \`!persona <이름>\` — 페르소나 변경 (현재: **${personaDef.name}**)`,
              "페르소나 종류: `girlfriend`(여자친구), `assistant`(비서), `tsundere`(츤데레), `senior`(선배), `cute`(발랄), `custom`(사용자 정의)",
              "`/persona custom [prompt]` — 나만의 시스템 프롬프트 직접 지정",
              "`/clear` — 이전 대화 내역 초기화",
            ].join("\n"),
          },
          {
            name: "🧠 개인화 장기 기억 (RAG)",
            value: [
              "`/memory list` — 설아가 기억하고 있는 내 정보/취향 목록",
              "`/memory add content:<내용>` — 설아에게 새로운 정보 직접 기억시키기",
              "`/memory delete id:<번호>` — 저장된 기억 삭제",
            ].join("\n"),
          },
          {
            name: "🎙️ 실시간 음성 통화 및 목소리",
            value: [
              "`/voice join` 또는 `설아야 이리온` — 음성 채널 입장 및 실시간 통화",
              "`/voice leave` 또는 `설아야 꺼져` — 음성 채널 퇴장",
              "`/voice speak text:<내용>` — 음성 채널에서 텍스트 TTS 발화",
              `\`/preset [voice]\` 또는 \`!voice <이름>\` — 목소리 변경 (현재: **${currentPreset.label}**)`,
              "지원 프리셋: `kei`, `qwen`, `cosy`, `reva`, `gamgyuri`, `myoya`, `myoya_cosy`, `seola`, `lively`, `calm`, `whisper`, `melo`, `ava`, `sunhi`",
            ].join("\n"),
          },
          {
            name: "🎵 음악 및 유튜브 재생 (대기열/볼륨)",
            value: [
              "`/music play <query>` 또는 `설아야 <곡명> 틀어줘` — 음악 재생 (재생 중이면 대기열 추가)",
              "`/music queue` 또는 `!queue` — 현재 재생 곡 및 대기열 목록 확인",
              "`/music skip` 또는 `!skip` — 다음 곡으로 건너뛰기",
              "`/music remove <index>` / `/music clear` — 대기열 곡 삭제 및 비우기",
              "`/music now` — 현재 재생 중인 음악 정보 확인",
              "`/volume [0~100]` 또는 `!volume <수치>` — 볼륨 조절 *(기본 20%)*",
              "`/music stop` 또는 `설아야 노래 꺼줘` — 음악 및 대기열 중지",
            ].join("\n"),
          },
          {
            name: "🛠️ AI 모델 & 에이전트 도구",
            value: [
              "`/model set [name]` 또는 `!model <이름>` — 개인 대화 LLM 모델 변경",
              "`/search [query]` 또는 `!검색 <검색어>` — 실시간 웹/뉴스 검색",
              "`/improve run [instruction]` 또는 `!자기개선 <내용>` — Antigravity CLI(`agy`) 자율 코드 개선",
              "`/improve status` 또는 `!작업상태` — 자기개선 진행 상태 확인",
              "`/dashboard` — 실시간 웹 대시보드 URL",
              "`/restart` / `/status` — 봇 재시작 및 상태 확인",
            ].join("\n"),
          },
        )
        .setFooter({ text: "슬래시 명령어(/) 또는 일반 채팅 프리픽스(!) 모두 지원합니다." });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // 처리되지 않은 알 수 없는 명령어 폴백
    console.warn(`[SlashCommands] ⚠️ 정의되지 않았거나 처리되지 않은 명령어: /${commandName}`);
    await interaction.editReply({
      content: `알 수 없는 명령어입니다: \`/${commandName}\`. \`/help\`를 확인해주세요.`,
    });
  } catch (error: any) {
    console.error(`[SlashCommands] /${commandName} 처리 중 오류:`, error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: `❌ 명령어 처리 중 오류가 발생했습니다: ${error.message}`,
        });
      } else {
        await interaction.reply({
          content: `❌ 명령어 처리 중 오류가 발생했습니다: ${error.message}`,
          ephemeral: true,
        });
      }
    } catch {
      // 이미 타임아웃된 인터랙션 무시
    }
  }
};
