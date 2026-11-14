import {
  createAudioPlayer,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  type AudioPlayer,
} from "@discordjs/voice";

const guildPlayers = new Map<string, AudioPlayer>();
const guildTtsPlayers = new Map<string, AudioPlayer>();

/**
 * 공통 설정이 적용된 길드용 AudioPlayer 인스턴스 생성
 */
const createManagedAudioPlayer = (
  guildId: string,
  logPrefix: string,
): AudioPlayer => {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  player.on("error", (error) => {
    console.error(`[${logPrefix}:${guildId}] 오디오 재생 에러:`, error.message, error);
  });

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[${logPrefix}:${guildId}] 음성 채널 오디오 재생 시작`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[${logPrefix}:${guildId}] 재생 종료 → 유휴(Idle) 상태 복귀`);
  });

  return player;
};

/**
 * 길드(서버)별 독립된 메인(음악/공용) AudioPlayer를 조회하거나 생성합니다.
 * 서로 다른 서버에서 노래나 음성을 재생할 때 오디오가 섞이거나 동시 송출되는 문제를 방지합니다.
 */
export const getGuildAudioPlayer = (guildId: string): AudioPlayer => {
  const existing = guildPlayers.get(guildId);
  if (existing) {
    return existing;
  }

  const player = createManagedAudioPlayer(guildId, "AudioPlayer");
  guildPlayers.set(guildId, player);
  return player;
};

/**
 * 길드(서버)별 TTS 발화 전용 AudioPlayer를 조회하거나 생성합니다.
 * 음악 재생용 AudioPlayer와 분리하여, TTS 발화 중 음악 리소스를 파괴하지 않고 일시정지/재개할 수 있게 합니다.
 */
export const getGuildTtsAudioPlayer = (guildId: string): AudioPlayer => {
  const existing = guildTtsPlayers.get(guildId);
  if (existing) {
    return existing;
  }

  const player = createManagedAudioPlayer(guildId, "TtsAudioPlayer");
  guildTtsPlayers.set(guildId, player);
  return player;
};

/**
 * 길드 퇴장/세션 종료 시 해당 길드의 메인/TTS AudioPlayer를 모두 정지하고 맵에서 정리합니다.
 */
export const destroyGuildAudioPlayer = (guildId: string): void => {
  for (const playerMap of [guildPlayers, guildTtsPlayers]) {
    const player = playerMap.get(guildId);
    if (player) {
      try {
        player.stop(true);
      } catch {}
      playerMap.delete(guildId);
    }
  }
};
