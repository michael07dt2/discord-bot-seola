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
import { songMap } from "./songmap.ts";

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
}

export interface PlayMusicResult {
  success: boolean;
  track?: MusicTrackInfo;
  errorMessage?: string;
}

// 길드별 현재 재생 중인 음악 상태 및 백그라운드 프로세스 관리
const activeGuildMusicSessions = new Map<string, GuildMusicSession>();

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
 */
export const stopGuildMusic = (guildId: string): void => {
  const session = activeGuildMusicSessions.get(guildId);
  if (session?.subprocess) {
    try {
      session.subprocess.kill("SIGTERM");
    } catch {
      // 이미 종료된 프로세스 무시
    }
  }
  activeGuildMusicSessions.delete(guildId);
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
  // 1. 기존 진행 중인 이전 음악 스트림 프로세스 종료
  stopGuildMusic(params.guildId);

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

  // 3. discord.js AudioResource 로 래핑 (FFmpeg 가 자동으로 파이프 스트림 트랜스코딩)
  const resource = createAudioResource(subprocess.stdout as Readable, {
    inputType: StreamType.Arbitrary,
    metadata: params.track,
  });

  // 4. 길드 세션 등록
  activeGuildMusicSessions.set(params.guildId, {
    guildId: params.guildId,
    track: params.track,
    requesterName: params.requesterName,
    startedAt: new Date(),
    subprocess,
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
 * 로컬 음원 또는 유튜브 음원을 통합 탐색하여 길드 플레이어에서 재생 시작
 */
export const playMusicTrack = async (params: {
  guildId: string;
  query: string;
  player: AudioPlayer;
  connection?: VoiceConnection | undefined;
  requesterName?: string | undefined;
}): Promise<PlayMusicResult> => {
  const { guildId, query, player, connection, requesterName } = params;
  const trimmed = query.trim();
  if (!trimmed) {
    return { success: false, errorMessage: "재생할 곡명이나 링크를 입력해주세요." };
  }

  // 1. 로컬 음원 파일 우선 탐색 (초고속 즉시 재생)
  const localSong = findLocalSong(trimmed);
  if (localSong) {
    try {
      stopGuildMusic(guildId);

      const resource = createAudioResource(localSong.filePath, {
        inputType: StreamType.Arbitrary,
      });

      player.play(resource);
      if (connection) {
        connection.subscribe(player);
      }

      activeGuildMusicSessions.set(guildId, {
        guildId,
        track: localSong,
        requesterName,
        startedAt: new Date(),
      });

      // 5초 이내 재생 상태 진입 모니터링
      entersState(player, AudioPlayerStatus.Playing, 5_000).catch((err) =>
        console.warn("[Music] 플레이어 재생 상태 진입 지연:", err?.message || err),
      );

      return { success: true, track: localSong };
    } catch (err: any) {
      console.error("[Music] 로컬 오디오 리소스 생성 실패:", err);
      return { success: false, errorMessage: "로컬 음원을 읽어오는 중 오류가 발생했습니다." };
    }
  }

  // 2. 로컬에 없는 경우 유튜브에서 검색 및 스트리밍 재생
  try {
    const ytTrack = await searchYouTubeTrack(trimmed);
    if (!ytTrack) {
      return {
        success: false,
        errorMessage: `\`${trimmed}\`에 해당하는 유튜브 영상을 찾을 수 없습니다.`,
      };
    }

    const resource = createYouTubeAudioResource({
      guildId,
      track: ytTrack,
      requesterName,
    });

    player.play(resource);
    if (connection) {
      connection.subscribe(player);
    }

    entersState(player, AudioPlayerStatus.Playing, 8_000).catch((err) =>
      console.warn("[Music] 유튜브 스트림 재생 상태 진입 지연:", err?.message || err),
    );

    return { success: true, track: ytTrack };
  } catch (err: any) {
    console.error("[Music] 유튜브 스트리밍 재생 실패:", err);
    return {
      success: false,
      errorMessage: `유튜브 음악 재생 중 오류가 발생했습니다: ${err?.message || err}`,
    };
  }
};
