import {
  createAudioPlayer,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  type AudioPlayer,
} from "@discordjs/voice";

const guildPlayers = new Map<string, AudioPlayer>();

/**
 * 길드(서버)별 독립된 AudioPlayer를 조회하거나 생성합니다.
 * 서로 다른 서버에서 노래나 음성을 재생할 때 오디오가 섞이거나 동시 송출되는 문제를 방지합니다.
 */
export const getGuildAudioPlayer = (guildId: string): AudioPlayer => {
  const existing = guildPlayers.get(guildId);
  if (existing) {
    return existing;
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  player.on("error", (error) => {
    console.error(`[AudioPlayer:${guildId}] 오디오 재생 에러:`, error.message, error);
  });

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`[AudioPlayer:${guildId}] 음성 채널 오디오 재생 시작`);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    console.log(`[AudioPlayer:${guildId}] 재생 종료 → 유휴(Idle) 상태 복귀`);
  });

  guildPlayers.set(guildId, player);
  return player;
};

/**
 * 길드 퇴장/세션 종료 시 해당 길드의 AudioPlayer를 정지하고 맵에서 정리합니다.
 */
export const destroyGuildAudioPlayer = (guildId: string): void => {
  const player = guildPlayers.get(guildId);
  if (player) {
    try {
      player.stop(true);
    } catch {}
    guildPlayers.delete(guildId);
  }
};
