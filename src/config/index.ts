import "dotenv/config";

const parseIntEnv = (raw: string | undefined, fallback: number): number => {
  if (!raw || !raw.trim()) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseFloatEnv = (raw: string | undefined, fallback: number): number => {
  if (!raw || !raw.trim()) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolEnv = (raw: string | undefined, fallback: boolean): boolean => {
  if (!raw || !raw.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
};

export type SttProvider = "local" | "deepgram" | "openai" | "groq" | "auto";
export type WhisperDtype = "fp32" | "fp16" | "q8" | "q4" | "int8" | "auto";

/**
 * Seola Bot 중앙 설정 모듈
 * 환경 변수(.env) 파싱 및 기본값 관리의 단일 진실 공급원(Single Source of Truth)
 */
export const CONFIG = {
  // 포트 및 웹 서버 설정
  PORT: parseInt(process.env.PORT || "13000", 10),
  DASHBOARD_URL:
    process.env.DASHBOARD_URL ||
    `http://localhost:${process.env.PORT || "13000"}/dashboard`,

  // 디스코드 인증 정보
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",
  APP_ID: process.env.APP_ID || "",
  PUBLIC_KEY: process.env.PUBLIC_KEY || "",

  // 데이터베이스 설정
  DATABASE_URL:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:15432/context",

  // 로컬 AI 백엔드 (Ollama)
  OLLAMA_BASE_URL: (
    process.env.OLLAMA_BASE_URL || "http://localhost:11434"
  ).replace(/\/$/, ""),

  // 음성 파이프라인 (STT / TTS)
  STT_PROVIDER: (process.env.STT_PROVIDER || "local").toLowerCase() as SttProvider,
  WHISPER_MODEL:
    process.env.WHISPER_MODEL ||
    process.env.STT_MODEL ||
    "onnx-community/whisper-small",
  WHISPER_FALLBACK_MODEL:
    process.env.WHISPER_FALLBACK_MODEL || "onnx-community/whisper-base",
  STT_LANGUAGE: (process.env.STT_LANGUAGE || "ko").trim(),
  STT_ENCODER_DTYPE: (process.env.STT_ENCODER_DTYPE || "fp32").trim() as WhisperDtype,
  STT_DECODER_DTYPE: (process.env.STT_DECODER_DTYPE || "q8").trim() as WhisperDtype,
  STT_NUM_BEAMS: parseIntEnv(process.env.STT_NUM_BEAMS, 1),
  STT_TEMPERATURE: parseFloatEnv(process.env.STT_TEMPERATURE, 0.0),
  STT_INITIAL_PROMPT:
    process.env.STT_INITIAL_PROMPT ||
    "설아야, 안녕! 노래 틀어줘, 목소리 바꿔줘, 검색해줘.",

  // VAD / 민감도(Threshold) / 노이즈 필터링 설정
  STT_SILENCE_DURATION_MS: parseIntEnv(process.env.STT_SILENCE_DURATION_MS, 950),
  STT_MIN_SPEECH_SECONDS: parseFloatEnv(process.env.STT_MIN_SPEECH_SECONDS, 0.3),
  STT_MAX_SPEECH_SECONDS: parseFloatEnv(process.env.STT_MAX_SPEECH_SECONDS, 30.0),
  STT_MIN_RMS_THRESHOLD: parseFloatEnv(process.env.STT_MIN_RMS_THRESHOLD, 0.0035),
  STT_MIN_PEAK_THRESHOLD: parseFloatEnv(process.env.STT_MIN_PEAK_THRESHOLD, 0.015),
  STT_VAD_ENERGY_RATIO: parseFloatEnv(process.env.STT_VAD_ENERGY_RATIO, 0.08),
  STT_VAD_MIN_FRAME_RMS: parseFloatEnv(process.env.STT_VAD_MIN_FRAME_RMS, 0.003),
  STT_NOISE_GATE_ENABLED: parseBoolEnv(process.env.STT_NOISE_GATE_ENABLED, true),
  STT_HIGHPASS_CUTOFF_HZ: parseIntEnv(process.env.STT_HIGHPASS_CUTOFF_HZ, 75),
  STT_LOWPASS_CUTOFF_HZ: parseIntEnv(process.env.STT_LOWPASS_CUTOFF_HZ, 7600),
  STT_PRE_EMPHASIS_COEFF: parseFloatEnv(process.env.STT_PRE_EMPHASIS_COEFF, 0.12),
  STT_AGC_TARGET_PEAK: parseFloatEnv(process.env.STT_AGC_TARGET_PEAK, 0.88),
  STT_AGC_MAX_GAIN: parseFloatEnv(process.env.STT_AGC_MAX_GAIN, 6.0),

  // 외부 고성능 STT API 연동 설정 (Deepgram Nova-2 / OpenAI Whisper-large-v3 / Groq 등)
  DEEPGRAM_API_KEY: (process.env.DEEPGRAM_API_KEY || "").trim(),
  DEEPGRAM_MODEL: (process.env.DEEPGRAM_MODEL || "nova-2").trim(),
  STT_API_URL: (process.env.STT_API_URL || "").replace(/\/+$/, ""),
  STT_API_KEY: (process.env.STT_API_KEY || "").trim(),
  STT_API_MODEL: (process.env.STT_API_MODEL || "whisper-large-v3-turbo").trim(),

  TTS_PRESET: process.env.TTS_PRESET || "seola",

  // CosyVoice TTS 백엔드 설정 (외부 원격 서버 우선, 무응답 시 내부 로컬 서버 폴백)
  COSYVOICE_API_URL: (
    process.env.COSYVOICE_API_URL || "http://192.168.50.100:50000"
  ).replace(/\/+$/, ""),
  COSYVOICE_LOCAL_API_URL: (
    process.env.COSYVOICE_LOCAL_API_URL || "http://127.0.0.1:50000"
  ).replace(/\/+$/, ""),
  COSYVOICE_MODE: (process.env.COSYVOICE_MODE || "3초 고속 복제") as
    | "3초 고속 복제"
    | "3초 음성 복제"
    | "다국어 교차 복제"
    | "교차 언어 복제"
    | "자연어 지시 제어"
    | "사전 학습 음성"
    | "사전 학습 음색",
  COSYVOICE_PROMPT_TEXT:
    process.env.COSYVOICE_PROMPT_TEXT || "希望你以后能够做的比我还好呦。",
  COSYVOICE_PROMPT_WAV:
    process.env.COSYVOICE_PROMPT_WAV || "asset/zero_shot_prompt.wav",
  COSYVOICE_INSTRUCT_TEXT: process.env.COSYVOICE_INSTRUCT_TEXT || "",
  COSYVOICE_STREAM: parseBoolEnv(process.env.COSYVOICE_STREAM, false),
  COSYVOICE_TIMEOUT_MS: parseInt(
    process.env.COSYVOICE_TIMEOUT_MS || "180000",
    10,
  ),

  // Qwen3-TTS MLX 백엔드 설정 (Apple Silicon 포트 7865)
  QWEN_TTS_API_URL: (
    process.env.QWEN_TTS_API_URL || "http://127.0.0.1:7865"
  ).replace(/\/+$/, ""),
  QWEN_TTS_TIMEOUT_MS: parseInt(
    process.env.QWEN_TTS_TIMEOUT_MS || "180000",
    10,
  ),

  // 프로세스 및 에이전트 제어
  AUTO_KILL_EXISTING: process.env.AUTO_KILL_EXISTING === "true",
  HERMES_BIN: process.env.HERMES_BIN,
  AGY_BIN: process.env.AGY_BIN,
} as const;

export default CONFIG;
