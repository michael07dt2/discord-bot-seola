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
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { songMap } from "./songmap.ts";
import { getBotSetting, setBotSetting } from "./settings.ts";
import { getGuildAudioPlayer } from "./audioPlayer.ts";

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
  playlistCount?: number;
  errorMessage?: string;
}

export type MusicLoopMode = "off" | "track" | "queue";

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
  refreshGuildMusicControlPanel(guildId);

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
// 길드별 반복 재생 모드 (off: 끔, track: 한 곡 반복, queue: 전체 대기열 반복)
const guildLoopModes = new Map<string, MusicLoopMode>();
// 길드별 최하단 뮤직 컨트롤러 메시지 1개 유지용 캐시
const guildControlMessages = new Map<string, Message>();
// 길드별 뮤직 컨트롤러가 전송된 텍스트 채널 캐시 (다음 곡 자동 전환 시 최하단 재전송용)
const guildControlChannels = new Map<string, SendableChannels>();
// 길드별 뮤직 컨트롤러 재생 시간 주기적 갱신 타이머
const guildControlRefreshTimers = new Map<string, NodeJS.Timeout>();
const MUSIC_CONTROL_REFRESH_INTERVAL_MS = 3_000;

const clearGuildControlRefreshTimer = (guildId: string): void => {
  const timer = guildControlRefreshTimers.get(guildId);
  if (timer) {
    clearInterval(timer);
    guildControlRefreshTimers.delete(guildId);
  }
};

const ensureGuildControlRefreshTimer = (guildId: string): void => {
  clearGuildControlRefreshTimer(guildId);
  const timer = setInterval(() => {
    const session = activeGuildMusicSessions.get(guildId);
    const msg = guildControlMessages.get(guildId);
    if (!session || !msg) {
      clearGuildControlRefreshTimer(guildId);
      return;
    }
    const player = getGuildAudioPlayer(guildId);
    if (player.state.status !== AudioPlayerStatus.Playing) {
      return;
    }
    refreshGuildMusicControlPanel(guildId);
  }, MUSIC_CONTROL_REFRESH_INTERVAL_MS);
  timer.unref();
  guildControlRefreshTimers.set(guildId, timer);
};

export const getGuildLoopMode = (guildId?: string): MusicLoopMode => {
  if (!guildId) return "off";
  return guildLoopModes.get(guildId) ?? "off";
};

export const cycleGuildLoopMode = (guildId: string): MusicLoopMode => {
  const current = getGuildLoopMode(guildId);
  const next: MusicLoopMode =
    current === "off" ? "track" : current === "track" ? "queue" : "off";
  guildLoopModes.set(guildId, next);
  return next;
};
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
 * 현재 재생 경과 시간(초)을 "0:00" 또는 "hh:mm:ss" 포맷으로 변환
 */
const formatPlaybackTime = (seconds: number): string => {
  const safeSec = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = Math.floor(safeSec % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

const mapRawEntryToYouTubeTrack = (
  entry: any,
  fallbackQuery: string,
): YouTubeTrackInfo | null => {
  if (!entry) return null;
  const title = typeof entry.title === "string" ? entry.title : fallbackQuery;
  if (title === "[Private video]" || title === "[Deleted video]") {
    return null;
  }

  const rawUrl: string | undefined =
    entry.webpage_url ||
    (typeof entry.url === "string" && entry.url.startsWith("http")
      ? entry.url
      : entry.id
        ? `https://www.youtube.com/watch?v=${entry.id}`
        : undefined);

  if (!rawUrl) return null;

  const duration = typeof entry.duration === "number" ? entry.duration : 0;
  const thumbnail =
    entry.thumbnail ||
    (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
      ? entry.thumbnails[entry.thumbnails.length - 1]?.url
      : undefined);

  return {
    title,
    url: rawUrl,
    duration,
    formattedDuration: formatDuration(duration),
    thumbnail,
    uploader: entry.uploader || entry.channel || "YouTube",
    query: fallbackQuery,
    isLocal: false,
  };
};

/**
 * 유튜브 URL(단일 곡 또는 플레이리스트) 또는 검색어로 트랙 목록 탐색
 */
export const searchYouTubeTracks = async (
  query: string,
): Promise<YouTubeTrackInfo[]> => {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const isUrl = /^https?:\/\/(www\.|music\.)?(youtube\.com|youtu\.be)\//i.test(trimmed);
  const isPlaylistUrl = isUrl && (/[?&]list=/.test(trimmed) || /\/playlist\b/.test(trimmed));
  const target = isUrl ? trimmed : `ytsearch1:${trimmed}`;

  try {
    const rawResult: any = await (youtubedl as any)(
      target,
      isPlaylistUrl
        ? {
            dumpSingleJson: true,
            flatPlaylist: true,
            playlistEnd: 50,
            noWarnings: true,
          }
        : {
            dumpSingleJson: true,
            noWarnings: true,
            preferFreeFormats: true,
            defaultSearch: "ytsearch1",
          },
    );

    if (Array.isArray(rawResult?.entries) && rawResult.entries.length > 0) {
      const tracks = rawResult.entries
        .map((entry: any) => mapRawEntryToYouTubeTrack(entry, trimmed))
        .filter((t: YouTubeTrackInfo | null): t is YouTubeTrackInfo => Boolean(t));
      if (tracks.length > 0) {
        return tracks;
      }
    }

    const single = mapRawEntryToYouTubeTrack(rawResult as Payload, trimmed);
    return single ? [single] : [];
  } catch (error: any) {
    console.error("[YouTubeMusic] 검색 실패:", error?.message || error);
    return [];
  }
};

/**
 * 유튜브 URL 또는 검색어로 단일 트랙 메타데이터 검색
 */
export const searchYouTubeTrack = async (
  query: string,
): Promise<YouTubeTrackInfo | null> => {
  const tracks = await searchYouTubeTracks(query);
  return tracks[0] ?? null;
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
  clearGuildControlRefreshTimer(guildId);
  if (options?.clearQueue !== false) {
    guildMusicQueues.delete(guildId);
    guildLoopModes.delete(guildId);
    refreshGuildMusicControlPanel(guildId, { stopped: true });
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
  if (count > 0) {
    refreshGuildMusicControlPanel(guildId);
  }
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
  if (removed) {
    refreshGuildMusicControlPanel(guildId);
  }
  return removed || null;
};

/**
 * 길드의 음악 대기열에서 특정 순번(1부터 시작)의 곡을 원하는 순번으로 이동
 */
export const moveGuildMusicQueueItem = (
  guildId: string,
  from1Based: number,
  to1Based: number,
): { item: QueuedMusicItem; from: number; to: number } | null => {
  const queue = guildMusicQueues.get(guildId);
  if (
    !queue ||
    from1Based < 1 ||
    from1Based > queue.length ||
    to1Based < 1 ||
    to1Based > queue.length
  ) {
    return null;
  }
  const [moved] = queue.splice(from1Based - 1, 1);
  if (!moved) return null;
  queue.splice(to1Based - 1, 0, moved);
  refreshGuildMusicControlPanel(guildId);
  return { item: moved, from: from1Based, to: to1Based };
};

/**
 * 길드의 음악 대기열에서 두 순번(1부터 시작)의 곡 위치를 서로 교환
 */
export const swapGuildMusicQueueItems = (
  guildId: string,
  first1Based: number,
  second1Based: number,
): { first: QueuedMusicItem; second: QueuedMusicItem } | null => {
  const queue = guildMusicQueues.get(guildId);
  if (
    !queue ||
    first1Based < 1 ||
    first1Based > queue.length ||
    second1Based < 1 ||
    second1Based > queue.length
  ) {
    return null;
  }
  const firstItem = queue[first1Based - 1];
  const secondItem = queue[second1Based - 1];
  if (!firstItem || !secondItem) return null;
  queue[first1Based - 1] = secondItem;
  queue[second1Based - 1] = firstItem;
  refreshGuildMusicControlPanel(guildId);
  return { first: firstItem, second: secondItem };
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
  resendControlPanel?: boolean | undefined;
}): void => {
  const { guildId, track, player, connection, requesterName, resendControlPanel } = params;

  const syncControlPanel = () => {
    if (resendControlPanel) {
      const existingChannel = guildControlMessages.get(guildId)?.channel;
      const targetChannel: SendableChannels | undefined =
        guildControlChannels.get(guildId) ??
        (existingChannel?.isSendable()
          ? (existingChannel as SendableChannels)
          : undefined);
      if (targetChannel) {
        void sendOrUpdateMusicControlPanel(guildId, targetChannel, player, {
          forceResend: true,
        });
        return;
      }
    }
    refreshGuildMusicControlPanel(guildId);
  };

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
    syncControlPanel();
    ensureGuildControlRefreshTimer(guildId);
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
  syncControlPanel();
  ensureGuildControlRefreshTimer(guildId);
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
  const existingBinding = guildPlayerBindings.get(guildId);
  guildPlayerBindings.set(guildId, {
    player,
    connection: connection ?? existingBinding?.connection,
    onQueueEnd: onQueueEnd ?? existingBinding?.onQueueEnd,
  });

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

    const loopMode = getGuildLoopMode(guildId);
    const binding = guildPlayerBindings.get(guildId);
    const targetPlayer = binding?.player || player;
    const targetConnection = binding?.connection || connection;

    // 한 곡 반복 모드면 방금 끝난 곡을 즉시 다시 재생
    if (loopMode === "track") {
      console.log(`[Music:${guildId}] 🔂 한 곡 반복 재생: ${finishedSession.track.title}`);
      try {
        startResolvedTrack({
          guildId,
          track: finishedSession.track,
          player: targetPlayer,
          connection: targetConnection,
          requesterName: finishedSession.requesterName,
          resendControlPanel: true,
        });
      } catch (err) {
        console.error(`[Music:${guildId}] 한 곡 반복 재생 실패:`, err);
      }
      return;
    }

    const queue = guildMusicQueues.get(guildId) || [];
    // 전체 대기열 반복 모드면 방금 끝난 곡을 대기열 맨 뒤에 다시 추가
    if (loopMode === "queue") {
      queue.push({
        track: finishedSession.track,
        requesterName: finishedSession.requesterName,
        addedAt: new Date(),
      });
      guildMusicQueues.set(guildId, queue);
    }

    if (queue.length > 0) {
      const nextItem = queue.shift()!;
      console.log(
        `[Music:${guildId}] ⏭️ 대기열 다음 곡 자동 재생: ${nextItem.track.title} (남은 대기열: ${queue.length}곡)`,
      );
      try {
        startResolvedTrack({
          guildId,
          track: nextItem.track,
          player: targetPlayer,
          connection: targetConnection,
          requesterName: nextItem.requesterName,
          resendControlPanel: true,
        });
      } catch (err) {
        console.error(`[Music:${guildId}] 다음 곡 자동 재생 실패:`, err);
      }
      return;
    }

    console.log(`[Music:${guildId}] ✅ 모든 대기열 음악 재생 완료`);
    clearGuildControlRefreshTimer(guildId);
    refreshGuildMusicControlPanel(guildId, { stopped: true });
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
    const loopMode = getGuildLoopMode(guildId);
    const queue = guildMusicQueues.get(guildId) || [];
    // 전체 반복 모드에서는 스킵한 현재 곡도 대기열 맨 뒤에 다시 추가하여 순환 유지
    if (loopMode === "queue" && currentSession) {
      queue.push({
        track: currentSession.track,
        requesterName: currentSession.requesterName,
        addedAt: new Date(),
      });
      guildMusicQueues.set(guildId, queue);
    }
    const nextItem = queue.length > 0 ? queue.shift() : undefined;
    const remainingQueue = queue.length;

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
        resendControlPanel: true,
      });
      return {
        skipped,
        nextTrack: nextItem.track,
        remainingQueue,
      };
    }

    refreshGuildMusicControlPanel(guildId, { stopped: true });
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
  insertPosition?: number | undefined;
}): Promise<PlayMusicResult> => {
  const {
    guildId,
    query,
    player,
    connection,
    requesterName,
    onQueueEnd,
    forceImmediate,
    insertPosition,
  } = params;
  const trimmed = query.trim();
  if (!trimmed) {
    return { success: false, errorMessage: "재생할 곡명이나 링크를 입력해주세요." };
  }

  ensureGuildMusicIdleHandler(guildId, player, connection, onQueueEnd);

  // 1. 로컬 음원 우선 탐색, 없으면 유튜브(단일 곡 또는 플레이리스트) 검색
  let resolvedTracks: MusicTrackInfo[] = [];
  const localTrack = findLocalSong(trimmed);
  if (localTrack) {
    resolvedTracks = [localTrack];
  } else {
    try {
      resolvedTracks = await searchYouTubeTracks(trimmed);
      if (resolvedTracks.length === 0) {
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

  const firstTrack = resolvedTracks[0]!;
  const extraTracks = resolvedTracks.slice(1);

  const enqueueTracks = (
    tracksToQueue: MusicTrackInfo[],
    atPosition1Based?: number,
  ): number => {
    const queue = guildMusicQueues.get(guildId) || [];
    const items: QueuedMusicItem[] = tracksToQueue.map((t) => ({
      track: t,
      requesterName,
      addedAt: new Date(),
    }));

    if (atPosition1Based !== undefined) {
      const clampedIdx = Math.max(0, Math.min(queue.length, atPosition1Based - 1));
      queue.splice(clampedIdx, 0, ...items);
      guildMusicQueues.set(guildId, queue);
      return clampedIdx + 1;
    }

    queue.push(...items);
    guildMusicQueues.set(guildId, queue);
    return queue.length;
  };

  // 2. 이미 해당 길드에서 노래가 재생 중이면 대기열(Queue)에 추가
  const isAlreadyPlayingMusic =
    activeGuildMusicSessions.has(guildId) &&
    player.state.status !== AudioPlayerStatus.Idle;

  if (isAlreadyPlayingMusic && !forceImmediate) {
    const firstQueuePos = enqueueTracks([firstTrack], insertPosition);
    if (extraTracks.length > 0) {
      enqueueTracks(
        extraTracks,
        insertPosition !== undefined ? firstQueuePos + 1 : undefined,
      );
    }
    refreshGuildMusicControlPanel(guildId);
    console.log(
      `[Music:${guildId}] 📜 대기열 #${firstQueuePos}번 추가: ${firstTrack.title}` +
        (extraTracks.length > 0 ? ` 외 ${extraTracks.length}곡` : ""),
    );
    return {
      success: true,
      track: firstTrack,
      queued: true,
      queuePosition: firstQueuePos,
      ...(resolvedTracks.length > 1 ? { playlistCount: resolvedTracks.length } : {}),
    };
  }

  // 3. 첫 곡 즉시 재생 시작 + 플레이리스트 나머지 곡은 모두 대기열(Queue)에 추가
  try {
    startResolvedTrack({
      guildId,
      track: firstTrack,
      player,
      connection,
      requesterName,
    });
    if (extraTracks.length > 0) {
      enqueueTracks(extraTracks);
      console.log(
        `[Music:${guildId}] 📜 플레이리스트 나머지 ${extraTracks.length}곡 대기열 추가 완료`,
      );
    }
    return {
      success: true,
      track: firstTrack,
      queued: false,
      ...(resolvedTracks.length > 1 ? { playlistCount: resolvedTracks.length } : {}),
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
  options?: { queued?: boolean; queuePosition?: number; playlistCount?: number },
): EmbedBuilder => {
  const volume = getGuildMusicVolumePercent(guildId);
  const isQueued = options?.queued === true;
  const playlistCount = options?.playlistCount;
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
      playlistCount && playlistCount > 1
        ? isQueued
          ? `📜 플레이리스트 **${playlistCount}곡**이 대기열에 순서대로 추가되었습니다!`
          : `📜 플레이리스트 **${playlistCount}곡** 중 첫 곡을 재생하고 나머지 **${playlistCount - 1}곡**을 대기열에 추가했습니다!`
        : isQueued
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

const LOOP_MODE_LABELS: Record<MusicLoopMode, string> = {
  off: "끔",
  track: "한 곡 반복",
  queue: "전체 반복",
};

/**
 * 현재 재생 트랙 일시정지/재개, 스킵, 반복 재생, 정지, 대기열 조회 버튼을 포함한 컨트롤 패널 임베드 생성
 */
export const createMusicControlPanel = (
  guildId: string,
  player?: AudioPlayer,
  options?: { stopped?: boolean },
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} => {
  const targetPlayer = player ?? getGuildAudioPlayer(guildId);
  const session = activeGuildMusicSessions.get(guildId);
  const queue = guildMusicQueues.get(guildId) || [];
  const loopMode = getGuildLoopMode(guildId);
  const volume = getGuildMusicVolumePercent(guildId);

  const isStopped = options?.stopped === true || !session;
  const isPaused =
    targetPlayer.state.status === AudioPlayerStatus.Paused ||
    targetPlayer.state.status === AudioPlayerStatus.AutoPaused;

  const statusText = isStopped
    ? "⏹️ 정지됨"
    : isPaused
      ? "⏸️ 일시정지"
      : "▶️ 재생 중";

  const nextTrackText =
    queue.length > 0 ? `${queue[0]!.track.title} (외 ${Math.max(0, queue.length - 1)}곡)` : "없음";

  const currentSec = session?.resource
    ? Math.floor(session.resource.playbackDuration / 1000)
    : 0;
  const currentTimeText = formatPlaybackTime(currentSec);
  const totalTimeText = !session
    ? "0:00"
    : session.track.isLocal
      ? "로컬 음원"
      : session.track.duration > 0
        ? session.track.formattedDuration
        : "실시간";
  const durationDisplay = session ? `⏱️ ${currentTimeText} / ${totalTimeText}` : "⏱️ 0:00 / 0:00";

  const channelText = !session
    ? "-"
    : session.track.isLocal
      ? "📁 로컬 라이브러리"
      : session.track.uploader || "YouTube";

  const embed = new EmbedBuilder()
    .setColor(isStopped ? 0x64748b : isPaused ? 0xfbbf24 : 0x34d399)
    .setTitle("🎵 Now Playing")
    .setDescription(
      session
        ? session.track.isLocal
          ? `**현재 트랙:** ${session.track.title}`
          : `**현재 트랙:** [${session.track.title}](${session.track.url})`
        : "현재 재생 중인 트랙이 없습니다.",
    )
    .addFields(
      { name: "상태", value: statusText, inline: true },
      { name: "재생 시간", value: durationDisplay, inline: true },
      { name: "채널", value: channelText, inline: true },
      { name: "반복 재생", value: `🔁 ${LOOP_MODE_LABELS[loopMode]}`, inline: true },
      { name: "볼륨", value: `🔊 ${volume}%`, inline: true },
      { name: "다음 곡", value: nextTrackText, inline: false },
    )
    .setFooter({ text: "아래 버튼을 눌러 음악을 실시간으로 제어할 수 있습니다." })
    .setTimestamp();

  const loopLabel =
    loopMode === "off"
      ? "🔁 반복: 끔"
      : loopMode === "track"
        ? "🔂 한곡 반복"
        : "🔁 전체 반복";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("music_toggle_pause")
      .setLabel(isPaused ? "▶️ 재개" : "⏸️ 일시정지")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(isStopped),
    new ButtonBuilder()
      .setCustomId("music_skip")
      .setLabel("⏭️ 스킵")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isStopped),
    new ButtonBuilder()
      .setCustomId("music_loop")
      .setLabel(loopLabel)
      .setStyle(loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(isStopped),
    new ButtonBuilder()
      .setCustomId("music_stop")
      .setLabel("⏹️ 정지")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isStopped),
    new ButtonBuilder()
      .setCustomId("music_queue")
      .setLabel(`📜 대기열 (${queue.length})`)
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [row],
  };
};

/**
 * 기존 뮤직 컨트롤러 메시지가 있으면 제자리에서 최신 상태로 수정 (정보 변경 시 동기화용)
 */
export const refreshGuildMusicControlPanel = (
  guildId: string,
  options?: { stopped?: boolean },
): void => {
  const existingMsg = guildControlMessages.get(guildId);
  if (!existingMsg) return;

  const payload = createMusicControlPanel(guildId, getGuildAudioPlayer(guildId), options);
  existingMsg.edit(payload).catch(() => {
    if (guildControlMessages.get(guildId)?.id === existingMsg.id) {
      guildControlMessages.delete(guildId);
    }
  });
};

/**
 * 채널 최하단에 뮤직 컨트롤러를 항상 1개만 유지하도록 전송/갱신
 * - 채널의 마지막 메시지가 이미 컨트롤러면 제자리 수정, 아니면 기존 컨트롤러를 삭제하고 최하단에 새로 전송
 */
export const sendOrUpdateMusicControlPanel = async (
  guildId: string,
  channel: SendableChannels | null | undefined,
  player?: AudioPlayer,
  options?: { forceResend?: boolean },
): Promise<void> => {
  if (!channel || !channel.isSendable()) return;

  guildControlChannels.set(guildId, channel);
  const payload = createMusicControlPanel(guildId, player);
  const existingMsg = guildControlMessages.get(guildId);

  if (existingMsg && existingMsg.channelId === channel.id) {
    const lastMessageId = (channel as { lastMessageId?: string | null }).lastMessageId;
    if (!options?.forceResend && lastMessageId && lastMessageId === existingMsg.id) {
      try {
        await existingMsg.edit(payload);
        return;
      } catch {
        // 수정 실패 시 삭제 후 새로 전송
      }
    }
    await existingMsg.delete().catch(() => {});
    guildControlMessages.delete(guildId);
  }

  try {
    const sent = await channel.send(payload);
    guildControlMessages.set(guildId, sent);
  } catch (err) {
    console.warn(`[Music:${guildId}] 컨트롤러 임베드 전송 실패:`, err);
  }
};

/**
 * 뮤직 컨트롤러 버튼 인터랙션 처리 핸들러
 */
export const handleMusicControlButton = async (
  interaction: ButtonInteraction,
  onPlaybackEnded?: (guildId: string) => void,
): Promise<void> => {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "서버 채널에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const player = getGuildAudioPlayer(guildId);
  const { customId } = interaction;

  if (customId === "music_queue") {
    const current = getGuildCurrentTrack(guildId);
    const queue = getGuildMusicQueue(guildId);
    const lines: string[] = [];
    if (current) {
      lines.push(`**🎶 현재 재생 중:** ${current.track.title}`);
    }
    if (queue.length > 0) {
      lines.push(
        `\n**📜 대기열 (${queue.length}곡):**\n` +
          queue
            .slice(0, 15)
            .map((item, idx) => `${idx + 1}. ${item.track.title}`)
            .join("\n") +
          (queue.length > 15 ? `\n...외 ${queue.length - 15}곡` : ""),
      );
    } else {
      lines.push("\n대기열이 비어 있습니다.");
    }
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  if (customId === "music_toggle_pause") {
    if (!activeGuildMusicSessions.has(guildId)) {
      await interaction.update(createMusicControlPanel(guildId, player, { stopped: true }));
      return;
    }
    const isPaused =
      player.state.status === AudioPlayerStatus.Paused ||
      player.state.status === AudioPlayerStatus.AutoPaused;
    if (isPaused) {
      player.unpause();
    } else {
      player.pause(true);
    }
    await interaction.update(createMusicControlPanel(guildId, player));
    return;
  }

  if (customId === "music_loop") {
    cycleGuildLoopMode(guildId);
    await interaction.update(createMusicControlPanel(guildId, player));
    return;
  }

  if (customId === "music_skip") {
    await interaction.deferUpdate();
    const skipResult = await skipGuildMusic(guildId, player);
    if (!skipResult.nextTrack) {
      onPlaybackEnded?.(guildId);
      await interaction
        .editReply(createMusicControlPanel(guildId, player, { stopped: true }))
        .catch(() => {});
    }
    return;
  }

  if (customId === "music_stop") {
    stopGuildMusic(guildId);
    player.stop();
    onPlaybackEnded?.(guildId);
    await interaction.update(createMusicControlPanel(guildId, player, { stopped: true }));
  }
};
