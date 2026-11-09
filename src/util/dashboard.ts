import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express, { type Express, type Request, type Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, contextsTable, voiceLogsTable } from "../db/index.ts";
import {
  getUserPersona,
  PERSONA_DEFINITIONS,
  setUserPersona,
  type PersonaId,
} from "./persona.ts";
import {
  getActiveVoiceSessions,
  getCurrentVoicePreset,
  leaveVoiceChannel,
  setGuildPlaybackMode,
  setVoiceChatEnabled,
  setVoicePreset,
  VOICE_PRESETS,
} from "./voiceChat.ts";
import { songMap } from "./songmap.ts";
import { playMusicTrack, stopGuildMusic } from "./youtubeMusic.ts";
import type { AudioPlayer } from "@discordjs/voice";
import {
  deleteUserMemory,
  listUserMemories,
  saveUserMemory,
} from "./memoryRag.ts";

export type VoiceActionType = "chat" | "music_play" | "music_stop" | "leave";

export interface VoiceLogEntry {
  id: number;
  guildName: string;
  channelName: string;
  userName: string;
  userText: string;
  botReply: string;
  actionType: VoiceActionType;
  durationSec: string | null;
  createdAt: string;
}

export interface ActiveVoiceSessionStatus {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  voiceChatEnabled: boolean;
  playbackMode: "idle" | "tts" | "music";
  activeSpeakerCount: number;
}

export interface DashboardStatusSnapshot {
  botTag: string;
  uptimeSec: number;
  memoryMb: number;
  voicePreset: {
    id: string;
    label: string;
  };
  sessions: ActiveVoiceSessionStatus[];
}

const MAX_MEMORY_LOGS = 500;
const memoryLogs: VoiceLogEntry[] = [];
let fallbackIdCounter = 1;
let isVoiceLogsTableInitialized = false;
let isMemoryHydratedFromDb = false;

// SSE(Server-Sent Events) 연결 클라이언트 목록
const sseClients = new Set<Response>();

const ensureVoiceLogsTable = async (): Promise<void> => {
  if (isVoiceLogsTableInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "voice_logs" (
        "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        "guild_name" varchar(255) NOT NULL,
        "channel_name" varchar(255) NOT NULL,
        "user_name" varchar(255) NOT NULL,
        "user_text" text NOT NULL,
        "bot_reply" text NOT NULL,
        "action_type" varchar(50) NOT NULL DEFAULT 'chat',
        "duration_sec" varchar(32),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    isVoiceLogsTableInitialized = true;
  } catch (error) {
    console.error("[Dashboard] voice_logs 테이블 생성/확인 중 오류:", error);
  }
};

const broadcastSseEvent = (event: string, payload: unknown): void => {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
};

/**
 * 음성 대화록을 DB 및 메모리에 기록하고 SSE로 브로드캐스트
 */
export const recordVoiceTranscript = async (params: {
  guildName: string;
  channelName: string;
  userName: string;
  userText: string;
  botReply: string;
  actionType?: VoiceActionType;
  durationSec?: number;
}): Promise<VoiceLogEntry> => {
  const {
    guildName,
    channelName,
    userName,
    userText,
    botReply,
    actionType = "chat",
    durationSec,
  } = params;

  const durationStr =
    typeof durationSec === "number" && durationSec > 0
      ? `${durationSec.toFixed(1)}s`
      : null;

  let savedEntry: VoiceLogEntry;

  try {
    await ensureVoiceLogsTable();
    const rows = await db
      .insert(voiceLogsTable)
      .values({
        guildName,
        channelName,
        userName,
        userText,
        botReply,
        actionType,
        durationSec: durationStr,
      })
      .returning({
        id: voiceLogsTable.id,
        createdAt: voiceLogsTable.createdAt,
      });

    const inserted = rows[0];
    savedEntry = {
      id: inserted ? inserted.id : fallbackIdCounter++,
      guildName,
      channelName,
      userName,
      userText,
      botReply,
      actionType,
      durationSec: durationStr,
      createdAt: inserted ? inserted.createdAt.toISOString() : new Date().toISOString(),
    };
  } catch (error) {
    console.warn("[Dashboard] 음성 대화록 DB 저장 실패, 메모리 폴백 사용:", error);
    savedEntry = {
      id: fallbackIdCounter++,
      guildName,
      channelName,
      userName,
      userText,
      botReply,
      actionType,
      durationSec: durationStr,
      createdAt: new Date().toISOString(),
    };
  }

  memoryLogs.push(savedEntry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.shift();
  }

  broadcastSseEvent("voice_log", savedEntry);
  return savedEntry;
};

/**
 * 저장된 음성 대화록 목록 조회
 */
export const getVoiceTranscripts = async (
  limit = 200,
): Promise<VoiceLogEntry[]> => {
  try {
    await ensureVoiceLogsTable();
    const rows = await db
      .select()
      .from(voiceLogsTable)
      .orderBy(desc(voiceLogsTable.id))
      .limit(limit);

    const formatted = rows
      .map(
        (row): VoiceLogEntry => ({
          id: row.id,
          guildName: row.guildName,
          channelName: row.channelName,
          userName: row.userName,
          userText: row.userText,
          botReply: row.botReply,
          actionType: (row.actionType as VoiceActionType) || "chat",
          durationSec: row.durationSec,
          createdAt:
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : new Date(row.createdAt).toISOString(),
        }),
      )
      .reverse();

    if (!isMemoryHydratedFromDb && formatted.length > 0) {
      memoryLogs.splice(0, memoryLogs.length, ...formatted);
      const maxId = formatted.reduce((m, item) => Math.max(m, item.id), 0);
      fallbackIdCounter = maxId + 1;
      isMemoryHydratedFromDb = true;
    }

    return formatted;
  } catch (error) {
    console.error("[Dashboard] 음성 대화록 DB 조회 실패 (메모리 폴백 반환):", error);
    return memoryLogs.slice(-limit);
  }
};

/**
 * 단일 음성 대화록 삭제
 */
export const deleteVoiceTranscript = async (id: number): Promise<boolean> => {
  try {
    await ensureVoiceLogsTable();
    await db.delete(voiceLogsTable).where(eq(voiceLogsTable.id, id));
  } catch (error) {
    console.warn("[Dashboard] 음성 대화록 DB 단일 삭제 실패:", error);
  }

  const idx = memoryLogs.findIndex((m) => m.id === id);
  if (idx !== -1) {
    memoryLogs.splice(idx, 1);
  }

  broadcastSseEvent("delete_log", { id });
  return true;
};

/**
 * 음성 대화록 전체 삭제
 */
export const clearVoiceTranscripts = async (): Promise<void> => {
  memoryLogs.length = 0;
  try {
    await ensureVoiceLogsTable();
    await db.delete(voiceLogsTable);
  } catch (error) {
    console.error("[Dashboard] 음성 대화록 DB 삭제 중 오류:", error);
  }
  broadcastSseEvent("clear_logs", {});
};

/**
 * 음성 세션 상태 변경 시 대시보드에 실시간 알림
 */
export const notifyDashboardStatusChanged = (
  status: DashboardStatusSnapshot,
): void => {
  broadcastSseEvent("status_update", status);
};

const DASHBOARD_HTML_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dashboard/index.html",
);
let cachedDashboardHtml: string | null = null;

/**
 * 대시보드 단일 페이지 웹앱 HTML 로드 (src/dashboard/index.html)
 */
const renderDashboardHtml = (): string => {
  if (!cachedDashboardHtml) {
    try {
      cachedDashboardHtml = fs.readFileSync(DASHBOARD_HTML_PATH, "utf-8");
    } catch (err) {
      console.error("[Dashboard] index.html 로드 실패:", err);
      return "<h1>대시보드 페이지를 불러올 수 없습니다.</h1>";
    }
  }
  return cachedDashboardHtml;
};

/**
 * Express 앱에 대시보드 페이지 및 실시간 API/SSE/제어 라우트를 등록합니다.
 */
export const registerDashboardRoutes = (
  app: Express,
  getStatusSnapshot: () => DashboardStatusSnapshot,
  deps?: { player?: AudioPlayer },
): void => {
  // JSON body parser 미들웨어 등록
  app.use(express.json());

  // 1. 대시보드 메인 웹 UI
  const serveDashboardPage = (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboardHtml());
  };

  app.get("/", serveDashboardPage);
  app.get("/dashboard", serveDashboardPage);

  // 2. 헬스체크 엔드포인트
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", message: "Bot is running!" });
  });

  // 3. 음성 대화록 및 현재 상태 조회 REST API
  app.get("/api/voice-logs", async (req: Request, res: Response) => {
    const rawLimit = Number(req.query["limit"] || 200);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 500)
      : 200;
    const logs = await getVoiceTranscripts(limit);
    res.json({
      logs,
      status: getStatusSnapshot(),
    });
  });

  // 4. 단일 음성 대화록 삭제 REST API
  app.delete("/api/voice-logs/:id", async (req: Request, res: Response) => {
    const rawId = req.params["id"];
    const id = parseInt(Array.isArray(rawId) ? rawId[0] || "" : rawId || "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "유효하지 않은 ID입니다." });
      return;
    }
    await deleteVoiceTranscript(id);
    res.json({ success: true, id });
  });

  // 5. 음성 대화록 전체 비우기 REST API
  app.delete("/api/voice-logs", async (_req: Request, res: Response) => {
    await clearVoiceTranscripts();
    res.json({ success: true });
  });

  // 6. 실시간 제어 API: 페르소나 변경
  app.post("/api/control/persona", async (req: Request, res: Response) => {
    const { userName = "micha", personaId } = req.body || {};
    if (!personaId || !(personaId in PERSONA_DEFINITIONS)) {
      res.status(400).json({ error: "유효하지 않은 페르소나 ID입니다." });
      return;
    }

    try {
      const result = await setUserPersona(userName, personaId as PersonaId);
      res.json({
        success: true,
        message: `${userName}님의 페르소나가 ${result.persona.name}(으)로 변경되었습니다.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. 실시간 제어 API: 목소리 프리셋 변경
  app.post("/api/control/voice-preset", async (req: Request, res: Response) => {
    const { presetId } = req.body || {};
    if (!presetId) {
      res.status(400).json({ error: "presetId가 필요합니다." });
      return;
    }

    const updated = await setVoicePreset(presetId);
    if (!updated) {
      res.status(400).json({ error: "유효하지 않은 목소리 프리셋입니다." });
      return;
    }

    notifyDashboardStatusChanged(getStatusSnapshot());
    res.json({
      success: true,
      message: `목소리가 ${updated.label}(으)로 변경되었습니다.`,
    });
  });

  // 8. 실시간 제어 API: 음성 채널 세션 제어 (pause, resume, leave)
  app.post("/api/control/voice-session", (req: Request, res: Response) => {
    const { guildId, action } = req.body || {};
    if (!guildId || !action) {
      res.status(400).json({ error: "guildId와 action이 필요합니다." });
      return;
    }

    if (action === "pause") {
      setVoiceChatEnabled(guildId, false);
    } else if (action === "resume") {
      setVoiceChatEnabled(guildId, true);
    } else if (action === "leave") {
      leaveVoiceChannel(guildId);
    }

    notifyDashboardStatusChanged(getStatusSnapshot());
    res.json({ success: true, action, guildId });
  });

  // 9. 실시간 제어 API: 음악 제어 (play, stop)
  app.post("/api/control/music", async (req: Request, res: Response) => {
    const { guildId, action, songTitle } = req.body || {};
    if (!guildId || !action) {
      res.status(400).json({ error: "guildId와 action이 필요합니다." });
      return;
    }

    if (action === "stop") {
      stopGuildMusic(guildId);
      if (deps?.player) {
        deps.player.stop();
      }
      setGuildPlaybackMode(guildId, "idle");
      notifyDashboardStatusChanged(getStatusSnapshot());
      res.json({ success: true, action: "stop" });
      return;
    }

    if (action === "play") {
      if (!songTitle || !String(songTitle).trim()) {
        res.status(400).json({ error: "재생할 곡명 또는 유튜브 검색어를 입력해주세요." });
        return;
      }

      setGuildPlaybackMode(guildId, "music");
      notifyDashboardStatusChanged(getStatusSnapshot());

      if (deps?.player) {
        const playResult = await playMusicTrack({
          guildId,
          query: String(songTitle).trim(),
          player: deps.player,
          requesterName: "대시보드",
        });

        if (!playResult.success || !playResult.track) {
          setGuildPlaybackMode(guildId, "idle");
          notifyDashboardStatusChanged(getStatusSnapshot());
          res.status(500).json({
            error: playResult.errorMessage || "음악을 재생할 수 없습니다.",
          });
          return;
        }

        res.json({
          success: true,
          action: "play",
          songTitle,
          track: playResult.track,
        });
        return;
      }

      res.json({ success: true, action: "play", songTitle });
      return;
    }

    res.status(400).json({ error: "지원하지 않는 action입니다." });
  });

  // 10. 개인화 장기 기억(RAG) REST API
  app.get("/api/memories", async (req: Request, res: Response) => {
    const userName = String(req.query["user"] || "micha");
    const memories = await listUserMemories(userName);
    res.json({ memories });
  });

  app.post("/api/memories", async (req: Request, res: Response) => {
    const { userName, memory, category, importance } = req.body || {};
    if (!userName || !memory) {
      res.status(400).json({ error: "userName과 memory가 필요합니다." });
      return;
    }
    const item = await saveUserMemory({
      userName,
      memory,
      category,
      importance,
    });
    res.json({ success: true, item });
  });

  app.delete("/api/memories/:id", async (req: Request, res: Response) => {
    const rawId = req.params["id"];
    const id = parseInt(Array.isArray(rawId) ? rawId[0] || "" : rawId || "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "유효하지 않은 ID입니다." });
      return;
    }
    await deleteUserMemory(id);
    res.json({ success: true, id });
  });

  // 11. 특정 유저 대화 문맥(Context) 삭제 REST API
  app.delete("/api/contexts/:userName", async (req: Request, res: Response) => {
    const rawUser = req.params["userName"];
    const userName = Array.isArray(rawUser) ? rawUser[0] || "" : rawUser || "";
    if (!userName) {
      res.status(400).json({ error: "userName이 필요합니다." });
      return;
    }
    try {
      await db.delete(contextsTable).where(eq(contextsTable.name, userName));
      res.json({ success: true, message: `${userName}님의 대화 문맥이 초기화되었습니다.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. 실시간 음성 대화록 스트리밍 SSE 엔드포인트
  app.get("/api/voice-logs/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // 초기 연결 즉시 현재 상태 전송
    res.write(
      `event: status_update\ndata: ${JSON.stringify(getStatusSnapshot())}\n\n`,
    );

    sseClients.add(res);

    const keepAliveTimer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepAliveTimer);
        sseClients.delete(res);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    });
  });
};
