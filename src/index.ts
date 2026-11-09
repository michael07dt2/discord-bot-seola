import express from "express";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  createAudioPlayer,
  NoSubscriberBehavior,
  AudioPlayerStatus,
} from "@discordjs/voice";

import CONFIG from "./config/index.ts";
import {
  handleSlashCommand,
  registerSlashCommands,
  setSlashCommandDependencies,
} from "./util/slashCommands.ts";
import { handlePrefixCommand } from "./util/prefixCommands.ts";
import {
  getActiveVoiceSessions,
  getCurrentVoicePreset,
  initVoicePresetFromDb,
  leaveAllVoiceChannels,
  preloadWhisperModel,
  restoreVoiceSessionsIfRecent,
} from "./util/voiceChat.ts";
import { initPersonaFromDb } from "./util/persona.ts";
import {
  registerDashboardRoutes,
  type DashboardStatusSnapshot,
} from "./util/dashboard.ts";
import {
  checkAndAcquireProcessLock,
  releaseProcessLock,
} from "./util/processLock.ts";

// 0. 단일 인스턴스 PID 락 확인 (중복 실행 방지 및 안전한 인계)
const lock = checkAndAcquireProcessLock({ killExisting: true });
if (!lock.success) {
  process.exit(1);
}

// 1. Express 앱 및 전역 오디오 플레이어 초기화
const app = express();
const player = createAudioPlayer({
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

player.on("error", (error) => {
  console.error("[AudioPlayer] 오디오 재생 에러:", error.message, error);
});

player.on(AudioPlayerStatus.Playing, () => {
  console.log("[AudioPlayer] 음성 채널 오디오 재생 시작");
});

player.on(AudioPlayerStatus.Idle, () => {
  console.log("[AudioPlayer] 재생 종료 → 유휴(Idle) 상태 복귀");
});

// 2. 디스코드 봇 클라이언트 초기화
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

// 대시보드 및 실시간 상태 동기화를 위한 스냅샷 생성자
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

// 슬래시 명령어 핸들러에 의존성 주입
setSlashCommandDependencies({
  player,
  getDashboardStatusSnapshot,
});

// 봇 준비 완료 이벤트
discordClient.once(Events.ClientReady, async (readyClient) => {
  console.log(`[Discord] Logged in as ${readyClient.user.tag}`);
  // 재부팅 이전 영구 저장된 목소리 프리셋 및 페르소나 복원
  await Promise.all([
    initVoicePresetFromDb().catch(() => {}),
    initPersonaFromDb().catch(() => {}),
  ]);
  // Whisper STT 로컬 가중치 사전 로드 (최초 음성 인식 지연 방지)
  preloadWhisperModel().catch(() => {});
  // 디스코드 슬래시(/) 명령어 자동 동기화 등록
  await registerSlashCommands(readyClient);
  // 재부팅/업데이트 이전 음성 채널 자동 재입장 복원 (최근 10분 이내 활성 세션)
  await restoreVoiceSessionsIfRecent(readyClient, player).catch((err) => {
    console.error("[VoiceChat] 음성 채널 자동 복원 실패:", err);
  });
});

// 슬래시(/) 명령어 인터랙션 디스패치
discordClient.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  console.log(
    `[Interaction] ⚡ 슬래시 명령어 수신: /${interaction.commandName} (유저: ${interaction.user.tag})`,
  );
  try {
    await handleSlashCommand(interaction);
  } catch (err) {
    console.error("[Interaction] 슬래시 명령어 처리 실패:", err);
  }
});

// 프리픽스(! 및 "설아야") 메시지 디스패치
discordClient.on("messageCreate", async (message) => {
  try {
    await handlePrefixCommand(message, {
      player,
      getDashboardStatusSnapshot,
    });
  } catch (err) {
    console.error("[PrefixCommand] 메시지 처리 실패:", err);
  }
});

// 3. 웹 대시보드 및 REST API 라우트 등록
registerDashboardRoutes(app, getDashboardStatusSnapshot, { player });

const server = app.listen(CONFIG.PORT, () => {
  console.log(`[Web] Voice Dashboard running on ${CONFIG.DASHBOARD_URL}`);
});

// 4. 안전한 Graceful Shutdown (음성 채널 자동 퇴장, 게이트웨이 정리, 락 해제)
let isShuttingDown = false;
const handleGracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(
    `\n[Process] ${signal} 시그널 수신. 모든 음성 채널 퇴장 및 안전한 종료 절차 시작...`,
  );

  const forceExitTimer = setTimeout(() => {
    console.log("[Process] 타임아웃 도달: 프로세스를 강제 종료합니다.");
    releaseProcessLock();
    process.exit(0);
  }, 1200);
  forceExitTimer.unref();

  try {
    // 1) 활성 음성 채널 모두 퇴장 (최대 600ms 대기)
    await Promise.race([
      leaveAllVoiceChannels(),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);

    // 2) 디스코드 게이트웨이 세션 정리
    try {
      await discordClient.destroy();
      console.log("[Process] 디스코드 봇 클라이언트 정상 종료");
    } catch {}

    // 3) Express 서버 종료
    try {
      server.close();
      console.log("[Process] Express 대시보드 서버 정상 종료");
    } catch {}

    // 4) PID 락 파일 해제
    releaseProcessLock();

    console.log("[Process] ✅ 모든 리소스가 안전하게 정리되었습니다. 종료 완료.");
    process.exit(0);
  } catch (err) {
    console.error("[Process] 종료 처리 중 예외 발생:", err);
    releaseProcessLock();
    process.exit(1);
  }
};

process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGHUP", () => handleGracefulShutdown("SIGHUP"));

// 5. 디스코드 로그인
discordClient.login(CONFIG.DISCORD_TOKEN);
