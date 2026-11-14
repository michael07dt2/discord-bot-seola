import path from "node:path";
import fs from "node:fs";
import type { Readable } from "node:stream";
import {
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  entersState,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import youtubedl, { type Payload } from "youtube-dl-exec";
import ffmpegStatic from "ffmpeg-static";
import { EmbedBuilder } from "discord.js";
import { songMap } from "./songmap.ts";
import { getBotSetting, setBotSetting } from "./settings.ts";

// prism-media 및 @discordjs/voice 가 내부적으로 ffmpeg-static 바이너리를 사용하도록 보장
const staticPath =
  typeof ffmpegStatic === "string" ? ffmpegStatic : (ffmpegStatic as any)?.default;
if (staticPath && !process.env.FFMPEG_PATH) {
  process.env.FFMPEG_PATH = staticPath;
}

export interface YouTubeTrackInfo {
  title: string;
  url: string;
  duration: number;
  formattedDuration: string;
  thumbnail?: string | undefined;
  uploader?: string | undefined;
  query: string;
  isLocal: false;
}

export interface LocalTrackInfo {
  title: string;
  fileName: string;
  filePath: string;
  isLocal: true;
}

export type MusicTrackInfo = YouTubeTrackInfo | LocalTrackInfo;

export interface GuildMusicSession {
  guildId: string;
  track: MusicTrackInfo;
  requesterName?: string | undefined;
  startedAt: Date;
  subprocess?: any;
  resource?: AudioResource<any> | undefined;
}

export interface QueuedMusicItem {
  track: MusicTrackInfo;
  requesterName?: string | undefined;
  addedAt: Date;
}

export interface PlayMusicResult {
  success: boolean;
  track?: MusicTrackInfo;
  queued?: boolean;
  queuePosition?: number;
  errorMessage?: string;
}

// 기본 음악 볼륨 (기존 100%는 너무 크므로 편안한 20%로 기본 조정)
export const DEFAULT_MUSIC_VOLUME_PERCENT = 20;

// 길드별 음악 볼륨 (0 ~ 100 퍼센트)
const guildMusicVolumeMap = new Map<string, number>();

/**
 * 길드 음악 볼륨 조회 (퍼센트 단위: 0 ~ 100)
 */
export const getGuildMusicVolumePercent = (guildId?: string): number => {
  if (!guildId) return DEFAULT_MUSIC_VOLUME_PERCENT;
  return guildMusicVolumeMap.get(guildId) ?? DEFAULT_MUSIC_VOLUME_PERCENT;
};

/**
 * 길드 음악 볼륨 배율 조회 (0.0 ~ 1.0)
 */
export const getGuildMusicVolumeScale = (guildId?: string): number => {
  return getGuildMusicVolumePercent(guildId) / 100;
};

/**
 * 길드 음악 볼륨 변경 및 실시간 오디오 리소스 반영 (0 ~ 100)
 */
export const setGuildMusicVolume = async (
  guildId: string,
  rawPercent: number,
  options?: { persist?: boolean },
): Promise<{ percent: number; scale: number }> => {
  const percent = Math.max(0, Math.min(100, Math.round(rawPercent)));
  const scale = percent / 100;

  guildMusicVolumeMap.set(guildId, percent);

  // 현재 재생 중인 오디오 리소스가 있으면 실시간으로 음량 즉시 조절
  const session = activeGuildMusicSessions.get(guildId);
  if (session?.resource?.volume) {
    session.resource.volume.setVolume(scale);
    console.log(`[Music] 🔊 ${guildId} 길드 실시간 음악 볼륨 조절: ${percent}% (scale: ${scale})`);
  }

  if (options?.persist !== false) {
    try {
      await setBotSetting(`music_volume:${guildId}`, String(percent));
    } catch (err) {
      console.warn(`[Music] 음악 볼륨 DB 저장 실패 (${guildId}):`, err);
    }
  }

  return { percent, scale };
};

/**
 * DB에서 길드 음악 볼륨 복원
 */
export const initGuildMusicVolume = async (guildId: string): Promise<number> => {
  try {
    const saved = await getBotSetting(`music_volume:${guildId}`);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        guildMusicVolumeMap.set(guildId, parsed);
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`[Music] 길드 음악 볼륨 복원 실패 (${guildId}):`, err);
  }
  return DEFAULT_MUSIC_VOLUME_PERCENT;
};

// 길드별 현재 재생 중인 음악 상태 및 백그라운드 프로세스 관리
const activeGuildMusicSessions = new Map<string, GuildMusicSession>();
// 길드별 재생 대기열(Queue)
const guildMusicQueues = new Map<string, QueuedMusicItem[]>();
// 길드별 플레이어 바인딩 및 자동 다음 곡 전환 중복 방지용 Set
const guildPlayerBindings = new Map<
  string,
  {
    player: AudioPlayer;
    connection?: VoiceConnection | undefined;
    onQueueEnd?: (() => void) | undefined;
  }
>();
const hookedPlayers = new WeakSet<AudioPlayer>();
const transitioningGuilds = new Set<string>();

/**
 * 초 단위 숫자를 "mm:ss" 또는 "hh:mm:ss" 포맷으로 변환
 */
export const formatDuration = (seconds?: number): string => {
  if (!seconds || isNaN(seconds) || seconds <= 0) {
    return "실시간 스트림 / 미상";
  }
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

/**
 * 유튜브 URL 또는 검색어로 트랙 메타데이터 검색
 */
export const searchYouTubeTrack = async (
  query: string,
): Promise<YouTubeTrackInfo | null> => {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed);
  const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

  try {
    const rawResult: any = await (youtubedl as any)(target, {
      dumpSingleJson: true,
      noWarnings: true,
      preferFreeFormats: true,
      defaultSearch: "ytsearch1",
    });

    const entry: Payload =
      rawResult?.entries && rawResult.entries.length > 0
        ? rawResult.entries[0]
        : rawResult;

    if (!entry || !entry.webpage_url) {
      return null;
    }

    const duration = typeof entry.duration === "number" ? entry.duration : 0;
    const thumbnail =
      entry.thumbnail ||
      (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
        ? entry.thumbnails[entry.thumbnails.length - 1]?.url
        : undefined);

    const trackInfo: YouTubeTrackInfo = {
      title: entry.title || trimmed,
      url: entry.webpage_url,
      duration,
      formattedDuration: formatDuration(duration),
      thumbnail,
      uploader: entry.uploader || entry.channel || "YouTube",
      query: trimmed,
      isLocal: false,
    };

    return trackInfo;
  } catch (error: any) {
    console.error("[YouTubeMusic] 검색 실패:", error?.message || error);
    return null;
  }
};

/**
 * 길드의 이전 유튜브 음악 프로세스 종료 및 세션 정리
 * (기본적으로 대기열도 함께 비우며, 스킵/다음곡 전환 시 clearQueue: false 전달)
 */
export const stopGuildMusic = (
  guildId: string,
  options?: { clearQueue?: boolean },
): void => {
  const session = activeGuildMusicSessions.get(guildId);
  if (session?.subprocess) {
    try {
      session.subprocess.kill("SIGTERM");
    } catch {
      // 이미 종료된 프로세스 무시
    }
  }
  activeGuildMusicSessions.delete(guildId);
  if (options?.clearQueue !== false) {
    guildMusicQueues.delete(guildId);
  }
};

/**
 * 길드의 현재 음악 대기열 목록 조회
 */
export const getGuildMusicQueue = (guildId: string): QueuedMusicItem[] => {
  return [...(guildMusicQueues.get(guildId) || [])];
};

/**
 * 길드의 음악 대기열 비우기 (삭제된 곡 수 반환)
 */
export const clearGuildMusicQueue = (guildId: string): number => {
  const queue = guildMusicQueues.get(guildId);
  const count = queue?.length || 0;
  guildMusicQueues.delete(guildId);
  return count;
};

/**
 * 길드의 음악 대기열에서 특정 순번(1부터 시작)의 곡 삭제
 */
export const removeGuildMusicQueueItem = (
  guildId: string,
  index1Based: number,
): QueuedMusicItem | null => {
  const queue = guildMusicQueues.get(guildId);
  if (!queue || index1Based < 1 || index1Based > queue.length) {
    return null;
  }
  const [removed] = queue.splice(index1Based - 1, 1);
  return removed || null;
};

/**
 * 길드에서 현재 재생 중인 트랙 정보 조회
 */
export const getGuildCurrentTrack = (
  guildId: string,
): GuildMusicSession | undefined => {
  return activeGuildMusicSessions.get(guildId);
};

/**
 * 유튜브 트랙의 오디오 스트림을 생성하여 AudioResource 로 반환
 */
export const createYouTubeAudioResource = (params: {
  guildId: string;
  track: YouTubeTrackInfo;
  requesterName?: string | undefined;
}): AudioResource<YouTubeTrackInfo> => {
  // 1. 기존 진행 중인 이전 음악 스트림 프로세스만 종료 (대기열은 유지)
  stopGuildMusic(params.guildId, { clearQueue: false });

  // 2. yt-dlp 바이너리로 stdout 파이프 오디오 스트림 생성
  const subprocess = (youtubedl as any).exec(
    params.track.url,
    {
      output: "-",
      format: "bestaudio/best",
      limitRate: "2M",
    },
    { stdio: ["ignore", "pipe", "ignore"] },
  );

  // SIGTERM 등으로 강제 종료될 때 tinyspawn Promise rejection 에러가 unhandled 로 번지지 않도록 방어
  subprocess.catch(() => {});

  if (!subprocess.stdout) {
    throw new Error("유튜브 오디오 스트림(stdout)을 생성할 수 없습니다.");
  }

  // 3. discord.js AudioResource 로 래핑 (inlineVolume 활성화)
  const resource = createAudioResource(subprocess.stdout as Readable, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
    metadata: params.track,
  });

  const scale = getGuildMusicVolumeScale(params.guildId);
  resource.volume?.setVolume(scale);

  // 4. 길드 세션 등록
  activeGuildMusicSessions.set(params.guildId, {
    guildId: params.guildId,
    track: params.track,
    requesterName: params.requesterName,
    startedAt: new Date(),
    subprocess,
    resource,
  });

  return resource;
};

/**
 * 입력된 곡명이나 검색어에서 로컬 음원 매칭 시도
 */
export const findLocalSong = (query: string): LocalTrackInfo | null => {
  const normalized = query.trim().toLowerCase();
  // 1. 완전문자열 일치
  const directMatch = songMap[normalized] || songMap[query.trim()];
  if (directMatch) {
    const filePath = path.resolve(process.cwd(), "src", "audio", directMatch);
    if (fs.existsSync(filePath)) {
      return {
        title: query.trim(),
        fileName: directMatch,
        filePath,
        isLocal: true,
      };
    }
  }

  // 2. 공백 제거 후 일치
  const compact = normalized.replace(/\s+/g, "");
  for (const [key, fileName] of Object.entries(songMap)) {
    if (key.replace(/\s+/g, "").toLowerCase() === compact) {
      const filePath = path.resolve(process.cwd(), "src", "audio", fileName);
      if (fs.existsSync(filePath)) {
        return {
          title: key,
          fileName,
          filePath,
          isLocal: true,
        };
      }
    }
  }

  return null;
};

/**
 * 이미 탐색된 트랙(로컬/유튜브)을 길드 플레이어에서 실제 재생 시작
 */
const startResolvedTrack = (params: {
  guildId: string;
  track: MusicTrackInfo;
  player: AudioPlayer;
  connection?: VoiceConnection | undefined;
  requesterName?: string | undefined;
}): void => {
  const { guildId, track, player, connection, requesterName } = params;

  if (track.isLocal) {
    stopGuildMusic(guildId, { clearQueue: false });

    const resource = createAudioResource(track.filePath, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    const scale = getGuildMusicVolumeScale(guildId);
    resource.volume?.setVolume(scale);

    player.play(resource);
    if (connection) {
      connection.subscribe(player);
    }

    activeGuildMusicSessions.set(guildId, {
      guildId,
      track,
      requesterName,
      startedAt: new Date(),
      resource,
    });

    entersState(player, AudioPlayerStatus.Playing, 5_000).catch((err) =>
      console.warn("[Music] 플레이어 재생 상태 진입 지연:", err?.message || err),
    );
    return;
  }

  const resource = createYouTubeAudioResource({
    guildId,
    track,
    requesterName,
  });

  player.play(resource);
  if (connection) {
    connection.subscribe(player);
  }

  entersState(player, AudioPlayerStatus.Playing, 8_000).catch((err) =>
    console.warn("[Music] 유튜브 스트림 재생 상태 진입 지연:", err?.message || err),
  );
};

/**
 * 길드의 AudioPlayer가 Idle(곡 종료) 상태가 되었을 때 대기열의 다음 곡을 자동 재생하는 리스너 등록
 */
const ensureGuildMusicIdleHandler = (
  guildId: string,
  player: AudioPlayer,
  connection?: VoiceConnection,
  onQueueEnd?: () => void,
): void => {
  guildPlayerBindings.set(guildId, { player, connection, onQueueEnd });

  if (hookedPlayers.has(player)) {
    return;
  }
  hookedPlayers.add(player);

  player.on(AudioPlayerStatus.Idle, () => {
    // skipGuildMusic 등에서 수동 전환 중이면 중복 처리 방지
    if (transitioningGuilds.has(guildId)) {
      return;
    }

    // 현재 길드가 음악 세션 중이 아니었다면(TTS 등 일반 발화 종료) 큐 전환하지 않음
    const finishedSession = activeGuildMusicSessions.get(guildId);
    if (!finishedSession) {
      return;
    }

    if (finishedSession.subprocess) {
      try {
        finishedSession.subprocess.kill("SIGTERM");
      } catch {}
    }
    activeGuildMusicSessions.delete(guildId);

    const queue = guildMusicQueues.get(guildId);
    if (queue && queue.length > 0) {
      const nextItem = queue.shift()!;
      const binding = guildPlayerBindings.get(guildId);
      console.log(
        `[Music:${guildId}] ⏭️ 대기열 다음 곡 자동 재생: ${nextItem.track.title} (남은 대기열: ${queue.length}곡)`,
      );
      try {
        startResolvedTrack({
          guildId,
          track: nextItem.track,
          player: binding?.player || player,
          connection: binding?.connection || connection,
          requesterName: nextItem.requesterName,
        });
      } catch (err) {
        console.error(`[Music:${guildId}] 다음 곡 자동 재생 실패:`, err);
      }
      return;
    }

    console.log(`[Music:${guildId}] ✅ 모든 대기열 음악 재생 완료`);
    const binding = guildPlayerBindings.get(guildId);
    binding?.onQueueEnd?.();
  });
};

/**
 * 현재 곡을 건너뛰고 대기열의 다음 곡을 즉시 재생 (다음 곡이 없으면 정지)
 */
export const skipGuildMusic = async (
  guildId: string,
  player?: AudioPlayer,
): Promise<{
  skipped: MusicTrackInfo | null;
  nextTrack: MusicTrackInfo | null;
  remainingQueue: number;
}> => {
  const currentSession = activeGuildMusicSessions.get(guildId);
  const skipped = currentSession?.track || null;
  const binding = guildPlayerBindings.get(guildId);
  const targetPlayer = player || binding?.player;

  transitioningGuilds.add(guildId);
  try {
    const queue = guildMusicQueues.get(guildId);
    const nextItem = queue && queue.length > 0 ? queue.shift() : undefined;
    const remainingQueue = queue ? queue.length : 0;

    stopGuildMusic(guildId, { clearQueue: false });
    if (targetPlayer) {
      targetPlayer.stop(true);
    }

    if (nextItem && targetPlayer) {
      startResolvedTrack({
        guildId,
        track: nextItem.track,
        player: targetPlayer,
        connection: binding?.connection,
        requesterName: nextItem.requesterName,
      });
      return {
        skipped,
        nextTrack: nextItem.track,
        remainingQueue,
      };
    }

    binding?.onQueueEnd?.();
    return {
      skipped,
      nextTrack: null,
      remainingQueue: 0,
    };
  } finally {
    transitioningGuilds.delete(guildId);
  }
};

/**
 * 로컬 음원 또는 유튜브 음원을 통합 탐색하여 길드 플레이어에서 재생하거나 대기열(Queue)에 추가
 */
export const playMusicTrack = async (params: {
  guildId: string;
  query: string;
  player: AudioPlayer;
  connection?: VoiceConnection | undefined;
  requesterName?: string | undefined;
  onQueueEnd?: (() => void) | undefined;
  forceImmediate?: boolean | undefined;
}): Promise<PlayMusicResult> => {
  const {
    guildId,
    query,
    player,
    connection,
    requesterName,
    onQueueEnd,
    forceImmediate,
  } = params;
  const trimmed = query.trim();
  if (!trimmed) {
    return { success: false, errorMessage: "재생할 곡명이나 링크를 입력해주세요." };
  }

  ensureGuildMusicIdleHandler(guildId, player, connection, onQueueEnd);

  // 1. 로컬 음원 우선 탐색, 없으면 유튜브 검색
  let resolvedTrack: MusicTrackInfo | null = findLocalSong(trimmed);
  if (!resolvedTrack) {
    try {
      resolvedTrack = await searchYouTubeTrack(trimmed);
      if (!resolvedTrack) {
        return {
          success: false,
          errorMessage: `\`${trimmed}\`에 해당하는 유튜브 영상을 찾을 수 없습니다.`,
        };
      }
    } catch (err: any) {
      console.error("[Music] 유튜브 검색 실패:", err);
      return {
        success: false,
        errorMessage: `유튜브 음악 검색 중 오류가 발생했습니다: ${err?.message || err}`,
      };
    }
  }

  // 2. 이미 해당 길드에서 노래가 재생 중이면 대기열(Queue)에 추가
  const isAlreadyPlayingMusic =
    activeGuildMusicSessions.has(guildId) &&
    player.state.status !== AudioPlayerStatus.Idle;

  if (isAlreadyPlayingMusic && !forceImmediate) {
    const queue = guildMusicQueues.get(guildId) || [];
    queue.push({
      track: resolvedTrack,
      requesterName,
      addedAt: new Date(),
    });
    guildMusicQueues.set(guildId, queue);
    console.log(
      `[Music:${guildId}] 📜 대기열 #${queue.length}번 추가: ${resolvedTrack.title}`,
    );
    return {
      success: true,
      track: resolvedTrack,
      queued: true,
      queuePosition: queue.length,
    };
  }

  // 3. 즉시 재생 시작
  try {
    startResolvedTrack({
      guildId,
      track: resolvedTrack,
      player,
      connection,
      requesterName,
    });
    return {
      success: true,
      track: resolvedTrack,
      queued: false,
    };
  } catch (err: any) {
    console.error("[Music] 음악 재생 시작 실패:", err);
    return {
      success: false,
      errorMessage: `음악 재생 중 오류가 발생했습니다: ${err?.message || err}`,
    };
  }
};

/**
 * 재생 중이거나 대기열에 추가된 트랙 정보를 미려한 디스코드 임베드로 생성
 */
export const createMusicTrackEmbed = (
  track: MusicTrackInfo,
  requesterName?: string,
  guildId?: string,
  options?: { queued?: boolean; queuePosition?: number },
): EmbedBuilder => {
  const volume = getGuildMusicVolumePercent(guildId);
  const isQueued = options?.queued === true;
  const titlePrefix = isQueued
    ? `📜 대기열 #${options?.queuePosition ?? 1}번 추가: `
    : "🎵 ";

  if (track.isLocal) {
    return new EmbedBuilder()
      .setColor(isQueued ? 0x5865f2 : 0xff85a2)
      .setTitle(`${titlePrefix}${track.title}`)
      .setDescription(
        isQueued
          ? "현재 재생 중인 곡이 끝나면 자동으로 이어서 재생됩니다!"
          : "설아의 내장 고음질 로컬 음원을 재생합니다!",
      )
      .addFields(
        { name: "음원 출처", value: "📁 로컬 라이브러리", inline: true },
        { name: "파일명", value: `\`${track.fileName}\``, inline: true },
        { name: "볼륨", value: `🔊 ${volume}%`, inline: true },
        { name: "신청자", value: requesterName || "설아", inline: true },
      )
      .setFooter({ text: "설아 뮤직 플레이어 • 대기열: /music queue • 스킵: /music skip" })
      .setTimestamp();
  }

  const embed = new EmbedBuilder()
    .setColor(isQueued ? 0x5865f2 : 0xff0000)
    .setTitle(`${titlePrefix}${track.title}`)
    .setURL(track.url)
    .setDescription(
      isQueued
        ? "현재 재생 중인 곡이 끝나면 자동으로 이어서 재생됩니다!"
        : "유튜브에서 음원을 찾아 재생을 시작합니다!",
    )
    .addFields(
      { name: "채널 / 아티스트", value: track.uploader || "YouTube", inline: true },
      { name: "재생 시간", value: track.formattedDuration, inline: true },
      { name: "볼륨", value: `🔊 ${volume}%`, inline: true },
      { name: "신청자", value: requesterName || "설아", inline: true },
    )
    .setFooter({ text: "설아 뮤직 플레이어 • 대기열: /music queue • 스킵: /music skip" })
    .setTimestamp();

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  return embed;
};
