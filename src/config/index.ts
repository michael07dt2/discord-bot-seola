import "dotenv/config";

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
  WHISPER_MODEL:
    process.env.WHISPER_MODEL || "onnx-community/whisper-small",
  TTS_PRESET: process.env.TTS_PRESET || "seola",

  // 프로세스 및 에이전트 제어
  AUTO_KILL_EXISTING: process.env.AUTO_KILL_EXISTING === "true",
  HERMES_BIN: process.env.HERMES_BIN,
  AGY_BIN: process.env.AGY_BIN,
} as const;

export default CONFIG;
