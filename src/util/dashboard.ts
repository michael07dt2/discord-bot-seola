import type { Express, Request, Response } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import { desc, sql } from "drizzle-orm";
import { voiceLogsTable } from "../db/schema.ts";
import "dotenv/config";

const db = drizzle(
  process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:15432/context",
);

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
 * 음성 대화록(STT 인식 결과 및 설아 응답)을 DB 및 메모리에 기록하고
 * 열려 있는 모든 대시보드 화면에 실시간(SSE)으로 브로드캐스트합니다.
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
  const now = new Date();
  const actionType: VoiceActionType = params.actionType ?? "chat";
  const durationStr =
    params.durationSec !== undefined ? params.durationSec.toFixed(1) : null;

  let savedEntry: VoiceLogEntry = {
    id: fallbackIdCounter++,
    guildName: params.guildName,
    channelName: params.channelName,
    userName: params.userName,
    userText: params.userText,
    botReply: params.botReply,
    actionType,
    durationSec: durationStr,
    createdAt: now.toISOString(),
  };

  try {
    await ensureVoiceLogsTable();
    const inserted = await db
      .insert(voiceLogsTable)
      .values({
        guildName: params.guildName,
        channelName: params.channelName,
        userName: params.userName,
        userText: params.userText,
        botReply: params.botReply,
        actionType,
        durationSec: durationStr,
        createdAt: now,
      })
      .returning();

    const row = inserted[0];
    if (row) {
      savedEntry = {
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
      };
    }
  } catch (error) {
    console.error("[Dashboard] 음성 대화록 DB 저장 실패 (메모리 캐시 유지):", error);
  }

  memoryLogs.push(savedEntry);
  if (memoryLogs.length > MAX_MEMORY_LOGS) {
    memoryLogs.splice(0, memoryLogs.length - MAX_MEMORY_LOGS);
  }

  broadcastSseEvent("voice_log", savedEntry);
  return savedEntry;
};

/**
 * 저장된 음성 대화록 목록을 조회합니다.
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

/**
 * 대시보드 단일 페이지 웹앱 HTML 생성
 */
const renderDashboardHtml = (): string => `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>설아(Seola) 실시간 음성 대화록 대시보드</title>
  <style>
    :root {
      --bg-primary: #0f1117;
      --bg-secondary: #171a24;
      --bg-card: #1e2230;
      --bg-user: #252b3d;
      --bg-bot: #2b1d28;
      --border: #2e3448;
      --accent: #ff7597;
      --accent-soft: rgba(255, 117, 151, 0.14);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --green: #34d399;
      --amber: #fbbf24;
      --blue: #60a5fa;
      --danger: #f87171;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: rgba(23, 26, 36, 0.9);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, #ff7597, #ff4d79);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: 0 4px 14px rgba(255, 117, 151, 0.3);
    }
    .brand-title h1 {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-title p {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
    .status-pills {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
    }
    .dot.live {
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
    }
    .dot.warn {
      background: var(--amber);
    }
    main {
      max-width: 1120px;
      width: 100%;
      margin: 0 auto;
      padding: 20px 24px 40px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .session-banner {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 18px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .session-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .session-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 10px;
      background: var(--accent-soft);
      border: 1px solid rgba(255, 117, 151, 0.35);
      font-size: 13px;
      color: #ffdce5;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      flex: 1;
    }
    input[type="search"], select {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 9px 13px;
      border-radius: 10px;
      font-size: 13px;
      outline: none;
    }
    input[type="search"] {
      min-width: 240px;
      flex: 1;
      max-width: 380px;
    }
    input[type="search"]:focus, select:focus {
      border-color: var(--accent);
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    button {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 8px 13px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    button:hover {
      border-color: var(--accent);
      background: var(--bg-user);
    }
    button.danger:hover {
      border-color: var(--danger);
      color: var(--danger);
    }
    .log-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 18px;
      min-height: 480px;
      max-height: calc(100vh - 260px);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .empty-state {
      margin: auto;
      text-align: center;
      color: var(--text-muted);
      padding: 60px 20px;
    }
    .empty-state .icon {
      font-size: 38px;
      margin-bottom: 10px;
    }
    .log-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      animation: fadeIn 0.2s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .log-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .meta-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .user-badge {
      font-weight: 700;
      color: var(--blue);
      background: rgba(96, 165, 250, 0.12);
      padding: 3px 9px;
      border-radius: 6px;
    }
    .channel-badge {
      color: var(--text-secondary);
      background: rgba(148, 163, 184, 0.12);
      padding: 3px 8px;
      border-radius: 6px;
    }
    .type-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 600;
    }
    .type-chat { background: rgba(52, 211, 153, 0.14); color: var(--green); }
    .type-music_play { background: rgba(251, 191, 36, 0.15); color: var(--amber); }
    .type-music_stop { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
    .type-leave { background: rgba(148, 163, 184, 0.2); color: var(--text-secondary); }
    .turn-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      line-height: 1.5;
      font-size: 14px;
      padding: 9px 12px;
      border-radius: 10px;
    }
    .turn-user {
      background: var(--bg-user);
    }
    .turn-bot {
      background: var(--bg-bot);
      border: 1px solid rgba(255, 117, 151, 0.2);
    }
    .turn-label {
      font-weight: 700;
      white-space: nowrap;
      font-size: 13px;
    }
    .turn-user .turn-label { color: #93c5fd; }
    .turn-bot .turn-label { color: var(--accent); }
    .turn-text {
      word-break: break-word;
      white-space: pre-wrap;
      flex: 1;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">🌸</div>
      <div class="brand-title">
        <h1>설아(Seola) 실시간 음성 대화록 대시보드</h1>
        <p>디스코드 채팅 채널에 전송되지 않는 음성(STT/TTS) 전용 실시간 대화 기록</p>
      </div>
    </div>
    <div class="status-pills">
      <div class="pill">
        <span id="sseDot" class="dot"></span>
        <span id="sseStatusText">실시간 연결 중...</span>
      </div>
      <div class="pill" id="voicePresetPill">🗣️ 목소리: -</div>
      <div class="pill" id="countPill">기록 0건</div>
    </div>
  </header>

  <main>
    <section class="session-banner">
      <div class="session-list" id="sessionList">
        <span style="color: var(--text-secondary); font-size: 13px;">현재 활성화된 음성 채널 세션이 없습니다. (디스코드에서 <code>설아야 이리온</code> 입력 시 연결)</span>
      </div>
    </section>

    <section class="toolbar">
      <div class="filters">
        <input type="search" id="searchInput" placeholder="대화 내용 또는 사용자 이름 검색..." />
        <select id="userFilter">
          <option value="">전체 사용자</option>
        </select>
      </div>
      <div class="actions">
        <label style="font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 5px; cursor: pointer;">
          <input type="checkbox" id="autoScrollToggle" checked /> 자동 스크롤
        </label>
        <button id="refreshBtn" type="button">새로고침</button>
        <button id="clearBtn" class="danger" type="button">대화록 비우기</button>
      </div>
    </section>

    <section class="log-container" id="logContainer">
      <div class="empty-state" id="emptyState">
        <div class="icon">🎙️</div>
        <p>아직 기록된 음성 대화가 없습니다.</p>
        <p style="font-size: 12px; margin-top: 6px;">음성 채널에서 설아와 대화하면 이곳에 실시간으로 표시됩니다.</p>
      </div>
    </section>
  </main>

  <script>
    let allLogs = [];
    const logContainer = document.getElementById("logContainer");
    const searchInput = document.getElementById("searchInput");
    const userFilter = document.getElementById("userFilter");
    const countPill = document.getElementById("countPill");
    const voicePresetPill = document.getElementById("voicePresetPill");
    const sessionList = document.getElementById("sessionList");
    const sseDot = document.getElementById("sseDot");
    const sseStatusText = document.getElementById("sseStatusText");
    const autoScrollToggle = document.getElementById("autoScrollToggle");

    const ACTION_LABELS = {
      chat: "💬 일반 대화",
      music_play: "🎵 음악 재생",
      music_stop: "⏹️ 음악 정지",
      leave: "👋 채널 퇴장"
    };

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatKstTime(iso) {
      try {
        const d = new Date(iso);
        return d.toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        });
      } catch {
        return iso;
      }
    }

    function updateUserDropdown() {
      const currentVal = userFilter.value;
      const users = Array.from(new Set(allLogs.map((l) => l.userName))).sort();
      userFilter.innerHTML = '<option value="">전체 사용자</option>' +
        users.map((u) => '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + '</option>').join("");
      if (users.includes(currentVal)) {
        userFilter.value = currentVal;
      }
    }

    function renderStatus(status) {
      if (!status) return;
      if (status.voicePreset) {
        voicePresetPill.textContent = "🗣️ 목소리: " + status.voicePreset.label;
      }
      const sessions = status.sessions || [];
      if (sessions.length === 0) {
        sessionList.innerHTML = '<span style="color: var(--text-secondary); font-size: 13px;">현재 활성화된 음성 채널 세션이 없습니다. (디스코드에서 <code>설아야 이리온</code> 입력 시 연결)</span>';
      } else {
        sessionList.innerHTML = sessions.map((s) => {
          const modeLabel = s.playbackMode === "music" ? "🎵 음악 재생 중" : s.playbackMode === "tts" ? "🗣️ 설아 발화 중" : (s.voiceChatEnabled ? "🎙️ 실시간 듣기 활성" : "🔇 듣기 일시중지");
          return '<div class="session-chip"><strong>' + escapeHtml(s.guildName) + ' · #' + escapeHtml(s.channelName) + '</strong><span>(' + modeLabel + ')</span></div>';
        }).join("");
      }
    }

    function renderLogs() {
      const q = searchInput.value.trim().toLowerCase();
      const selectedUser = userFilter.value;

      const filtered = allLogs.filter((item) => {
        if (selectedUser && item.userName !== selectedUser) return false;
        if (!q) return true;
        return (
          item.userName.toLowerCase().includes(q) ||
          item.userText.toLowerCase().includes(q) ||
          item.botReply.toLowerCase().includes(q) ||
          item.channelName.toLowerCase().includes(q)
        );
      });

      countPill.textContent = "기록 " + filtered.length + "건";

      if (filtered.length === 0) {
        logContainer.innerHTML =
          '<div class="empty-state"><div class="icon">🎙️</div><p>표시할 음성 대화록이 없습니다.</p></div>';
        return;
      }

      logContainer.innerHTML = filtered.map((item) => {
        const badgeLabel = ACTION_LABELS[item.actionType] || ACTION_LABELS.chat;
        const durationBadge = item.durationSec ? ' · ' + escapeHtml(item.durationSec) + '초' : '';
        return (
          '<article class="log-item">' +
            '<div class="log-meta">' +
              '<div class="meta-left">' +
                '<span class="user-badge">🎙️ ' + escapeHtml(item.userName) + '</span>' +
                '<span class="channel-badge">' + escapeHtml(item.guildName) + ' / #' + escapeHtml(item.channelName) + durationBadge + '</span>' +
                '<span class="type-badge type-' + escapeHtml(item.actionType) + '">' + badgeLabel + '</span>' +
              '</div>' +
              '<time>' + escapeHtml(formatKstTime(item.createdAt)) + '</time>' +
            '</div>' +
            '<div class="turn-row turn-user">' +
              '<span class="turn-label">' + escapeHtml(item.userName) + '</span>' +
              '<div class="turn-text">' + escapeHtml(item.userText) + '</div>' +
            '</div>' +
            '<div class="turn-row turn-bot">' +
              '<span class="turn-label">설아</span>' +
              '<div class="turn-text">' + escapeHtml(item.botReply) + '</div>' +
            '</div>' +
          '</article>'
        );
      }).join("");

      if (autoScrollToggle.checked) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }

    async function fetchInitialData() {
      try {
        const res = await fetch("/api/voice-logs");
        if (!res.ok) return;
        const data = await res.json();
        allLogs = data.logs || [];
        updateUserDropdown();
        renderStatus(data.status);
        renderLogs();
      } catch (err) {
        console.error("대화록 로드 실패:", err);
      }
    }

    function connectSse() {
      const es = new EventSource("/api/voice-logs/stream");
      es.onopen = () => {
        sseDot.className = "dot live";
        sseStatusText.textContent = "실시간 수신 중";
      };
      es.onerror = () => {
        sseDot.className = "dot warn";
        sseStatusText.textContent = "재연결 대기 중...";
      };
      es.addEventListener("voice_log", (e) => {
        try {
          const entry = JSON.parse(e.data);
          allLogs.push(entry);
          updateUserDropdown();
          renderLogs();
        } catch {}
      });
      es.addEventListener("status_update", (e) => {
        try {
          renderStatus(JSON.parse(e.data));
        } catch {}
      });
      es.addEventListener("clear_logs", () => {
        allLogs = [];
        updateUserDropdown();
        renderLogs();
      });
    }

    searchInput.addEventListener("input", renderLogs);
    userFilter.addEventListener("change", renderLogs);
    document.getElementById("refreshBtn").addEventListener("click", fetchInitialData);
    document.getElementById("clearBtn").addEventListener("click", async () => {
      if (!confirm("저장된 음성 대화록을 모두 삭제할까요?")) return;
      await fetch("/api/voice-logs", { method: "DELETE" });
    });

    fetchInitialData();
    connectSse();
  </script>
</body>
</html>`;

/**
 * Express 앱에 대시보드 페이지 및 실시간 API/SSE 라우트를 등록합니다.
 */
export const registerDashboardRoutes = (
  app: Express,
  getStatusSnapshot: () => DashboardStatusSnapshot,
): void => {
  // 대시보드 메인 웹 UI ('/' 및 '/dashboard' 모두 지원)
  const serveDashboardPage = (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDashboardHtml());
  };

  app.get("/", serveDashboardPage);
  app.get("/dashboard", serveDashboardPage);

  // 헬스체크 엔드포인트
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", message: "Bot is running!" });
  });

  // 음성 대화록 및 현재 상태 조회 REST API
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

  // 음성 대화록 비우기 REST API
  app.delete("/api/voice-logs", async (_req: Request, res: Response) => {
    await clearVoiceTranscripts();
    res.json({ success: true });
  });

  // 실시간 음성 대화록 스트리밍 SSE 엔드포인트
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
