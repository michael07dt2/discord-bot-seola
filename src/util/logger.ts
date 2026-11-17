/**
 * 컬러 콘솔 로거 및 STT · LLM · TTS 파이프라인 소요 시간 리포터
 */

const useColor =
  process.env.NO_COLOR === undefined ||
  process.env.NO_COLOR === "" ||
  process.env.NO_COLOR === "0";

export const ANSI = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  gray: useColor ? "\x1b[90m" : "",
  white: useColor ? "\x1b[37m" : "",
  brightWhite: useColor ? "\x1b[97m" : "",
  red: useColor ? "\x1b[91m" : "",
  green: useColor ? "\x1b[92m" : "",
  yellow: useColor ? "\x1b[93m" : "",
  blue: useColor ? "\x1b[94m" : "",
  magenta: useColor ? "\x1b[95m" : "",
  cyan: useColor ? "\x1b[96m" : "",
  orange: useColor ? "\x1b[38;5;214m" : "",
  pink: useColor ? "\x1b[38;5;213m" : "",
  sky: useColor ? "\x1b[38;5;117m" : "",
  indigo: useColor ? "\x1b[38;5;105m" : "",
} as const;

export const formatDurationMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const formatTimestamp = (date: Date = new Date()): string => {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
};

const getTagColor = (tag: string): string => {
  const lower = tag.toLowerCase();
  if (lower.startsWith("stt")) return ANSI.orange;
  if (lower.startsWith("llm") || lower.startsWith("ollama")) return ANSI.magenta;
  if (
    lower.startsWith("tts") ||
    lower.startsWith("melotts") ||
    lower.startsWith("cosyvoice") ||
    lower.startsWith("qwen")
  ) {
    return ANSI.pink;
  }
  if (lower.startsWith("voicechat")) return ANSI.cyan;
  if (
    lower.startsWith("discord") ||
    lower.startsWith("interaction") ||
    lower.startsWith("slash") ||
    lower.startsWith("prefix")
  ) {
    return ANSI.blue;
  }
  if (
    lower.startsWith("music") ||
    lower.startsWith("youtube") ||
    lower.startsWith("audioplayer") ||
    lower.startsWith("ttsaudioplayer")
  ) {
    return ANSI.green;
  }
  if (lower.startsWith("web") || lower.startsWith("dashboard")) return ANSI.sky;
  if (
    lower.startsWith("memoryrag") ||
    lower.startsWith("persona") ||
    lower.startsWith("settings") ||
    lower.startsWith("context")
  ) {
    return ANSI.yellow;
  }
  if (lower.startsWith("process") || lower.startsWith("tools")) {
    return ANSI.indigo;
  }
  return ANSI.white;
};

const highlightMetrics = (text: string): string => {
  if (!useColor) return text;
  // 숫자+단위(ms, s, 초, MB, %)를 밝게 강조
  return text.replace(
    /\b(\d+(?:\.\d+)?)(ms|초|s|MB|%)\b/g,
    `${ANSI.bold}${ANSI.yellow}$1$2${ANSI.reset}`,
  );
};

const formatConsoleArgs = (
  level: "info" | "warn" | "error",
  args: unknown[],
): unknown[] => {
  if (args.length === 0) return args;

  const first = args[0];
  if (typeof first !== "string") {
    const ts = `${ANSI.gray}${formatTimestamp()}${ANSI.reset}`;
    const badge =
      level === "error"
        ? `${ANSI.red}${ANSI.bold}ERR ${ANSI.reset}`
        : level === "warn"
          ? `${ANSI.yellow}${ANSI.bold}WARN${ANSI.reset}`
          : `${ANSI.green}INFO${ANSI.reset}`;
    return [`${ts} ${badge}`, ...args];
  }

  // 이미 ANSI 컬러가 적용된 블록(예: 파이프라인 리포트)은 그대로 출력
  if (first.includes("\x1b[")) {
    return args;
  }

  const trimmedStart = first.replace(/^\n+/, "");
  const leadingNewlines = first.slice(0, first.length - trimmedStart.length);
  const tagMatch = trimmedStart.match(/^\[([^\]]+)\]\s*(.*)$/s);

  const ts = `${ANSI.gray}${formatTimestamp()}${ANSI.reset}`;
  const isDebugTag = tagMatch?.[1]?.toLowerCase().includes(":debug") ?? false;

  const badge =
    level === "error"
      ? `${ANSI.red}${ANSI.bold}ERR ${ANSI.reset}`
      : level === "warn"
        ? `${ANSI.yellow}${ANSI.bold}WARN${ANSI.reset}`
        : isDebugTag
          ? `${ANSI.gray}DBG ${ANSI.reset}`
          : `${ANSI.green}INFO${ANSI.reset}`;

  if (tagMatch && tagMatch[1]) {
    const tag = tagMatch[1];
    const body = tagMatch[2] || "";
    const tagColor = getTagColor(tag);
    const coloredTag = `${tagColor}${ANSI.bold}[${tag}]${ANSI.reset}`;
    const coloredBody =
      level === "error"
        ? `${ANSI.red}${body}${ANSI.reset}`
        : level === "warn"
          ? `${ANSI.yellow}${body}${ANSI.reset}`
          : isDebugTag
            ? `${ANSI.gray}${body}${ANSI.reset}`
            : highlightMetrics(body);

    return [`${leadingNewlines}${ts} ${badge} ${coloredTag} ${coloredBody}`, ...args.slice(1)];
  }

  const coloredBody =
    level === "error"
      ? `${ANSI.red}${trimmedStart}${ANSI.reset}`
      : level === "warn"
        ? `${ANSI.yellow}${trimmedStart}${ANSI.reset}`
        : highlightMetrics(trimmedStart);

  return [`${leadingNewlines}${ts} ${badge} ${coloredBody}`, ...args.slice(1)];
};

let isColorConsoleInstalled = false;

/**
 * 전역 console.log / console.warn / console.error 에 타임스탬프 및 컬러 하이라이트 적용
 */
export const installColorConsole = (): void => {
  if (isColorConsoleInstalled) return;
  isColorConsoleInstalled = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...formatConsoleArgs("info", args));
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...formatConsoleArgs("warn", args));
  };
  console.error = (...args: unknown[]) => {
    origError(...formatConsoleArgs("error", args));
  };
};

const colorByLatency = (ms: number, fastLimit: number, slowLimit: number): string => {
  if (!useColor) return "";
  if (ms <= fastLimit) return ANSI.green;
  if (ms <= slowLimit) return ANSI.yellow;
  return ANSI.red;
};

const padMs = (ms: number): string => formatDurationMs(ms).padStart(7, " ");

export interface VoicePipelineTimingReport {
  userName: string;
  audioDurationSec: number;
  transcribedText: string;
  sttMs: number;
  sttLabel: string;
  llmMs: number;
  llmTtfaMs?: number | null;
  llmModel: string;
  ttsTotalMs: number;
  ttsSynthMs: number;
  ttsPlayMs: number;
  ttsSentenceCount: number;
  ttsPreset: string;
  perceivedLatencyMs?: number | null;
  totalTurnMs: number;
}

/**
 * 음성 대화 1턴의 STT · LLM · TTS 소요 시간을 한눈에 보는 컬러 요약 박스 출력
 */
export const logVoicePipelineTiming = (report: VoicePipelineTimingReport): void => {
  const {
    userName,
    audioDurationSec,
    transcribedText,
    sttMs,
    sttLabel,
    llmMs,
    llmTtfaMs,
    llmModel,
    ttsTotalMs,
    ttsSynthMs,
    ttsPlayMs,
    ttsSentenceCount,
    ttsPreset,
    perceivedLatencyMs,
    totalTurnMs,
  } = report;

  const sttColor = colorByLatency(sttMs, 800, 2000);
  const llmColor = colorByLatency(llmMs, 1500, 3500);
  const ttsSynthColor = colorByLatency(ttsSynthMs, 1200, 3500);
  const perceivedColor =
    perceivedLatencyMs != null
      ? colorByLatency(perceivedLatencyMs, 2000, 4500)
      : ANSI.cyan;

  const snippet =
    transcribedText.length > 36
      ? `${transcribedText.slice(0, 36)}...`
      : transcribedText;

  const ttfaPart =
    llmTtfaMs != null
      ? ` ${ANSI.dim}(첫 문장 ${formatDurationMs(llmTtfaMs)})${ANSI.reset}`
      : "";

  const perceivedPart =
    perceivedLatencyMs != null
      ? ` ${ANSI.dim}|${ANSI.reset} ⚡ 첫 음성 체감지연: ${perceivedColor}${ANSI.bold}${formatDurationMs(perceivedLatencyMs)}${ANSI.reset}`
      : "";

  const border = `${ANSI.gray}────────────────────────────────────────────────────────────────────${ANSI.reset}`;
  const header = `${ANSI.cyan}${ANSI.bold}⏱️  Voice Turn Summary${ANSI.reset} ${ANSI.brightWhite}[${userName}]${ANSI.reset} ${ANSI.gray}(${formatTimestamp()}, 발화 ${audioDurationSec.toFixed(1)}s)${ANSI.reset}`;

  const lines = [
    `${ANSI.gray}┌─${ANSI.reset} ${header}`,
    `${ANSI.gray}│${ANSI.reset}  ${ANSI.orange}${ANSI.bold}🎤 STT${ANSI.reset} : ${sttColor}${ANSI.bold}${padMs(sttMs)}${ANSI.reset}  ${ANSI.gray}[${sttLabel}]${ANSI.reset} "${snippet}"`,
    `${ANSI.gray}│${ANSI.reset}  ${ANSI.magenta}${ANSI.bold}🧠 LLM${ANSI.reset} : ${llmColor}${ANSI.bold}${padMs(llmMs)}${ANSI.reset}${ttfaPart}  ${ANSI.gray}[${llmModel}]${ANSI.reset}`,
    `${ANSI.gray}│${ANSI.reset}  ${ANSI.pink}${ANSI.bold}🗣️ TTS${ANSI.reset} : ${ttsSynthColor}${ANSI.bold}${padMs(ttsSynthMs)}${ANSI.reset} ${ANSI.dim}(합성 ${formatDurationMs(ttsSynthMs)} · 재생 ${formatDurationMs(ttsPlayMs)} · 총 ${formatDurationMs(ttsTotalMs)}, ${ttsSentenceCount}문장)${ANSI.reset}  ${ANSI.gray}[${ttsPreset}]${ANSI.reset}`,
    `${ANSI.gray}│${ANSI.reset}  ${ANSI.sky}${ANSI.bold}🏁 합계${ANSI.reset}: ${ANSI.brightWhite}${ANSI.bold}${padMs(totalTurnMs)}${ANSI.reset}${perceivedPart}`,
    `${ANSI.gray}└${border}`,
  ];

  console.log(lines.join("\n"));
};
