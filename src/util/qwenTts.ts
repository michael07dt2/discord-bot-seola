import { PassThrough, type Readable } from "stream";
import CONFIG from "../config/index.ts";

export interface QwenTtsOptions {
  mode?: "clone" | "custom" | undefined;
  speaker?: string | undefined;
  instruct?: string | undefined;
  refAudio?: string | undefined;
  refText?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface QwenTtsResult {
  stream: Readable;
  sampleRate: number;
}

let lastHealthCheckTime = 0;
let lastHealthCheckResult = false;
const HEALTH_CACHE_TTL_MS = 10_000;

/**
 * Qwen3-TTS MLX 서버 가동 여부 빠른 헬스체크 (1.5초 타임아웃)
 */
export const isQwenTtsAvailable = async (forceCheck = false): Promise<boolean> => {
  const now = Date.now();
  if (!forceCheck && now - lastHealthCheckTime < HEALTH_CACHE_TTL_MS) {
    return lastHealthCheckResult;
  }

  const baseUrl = CONFIG.QWEN_TTS_API_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const res = await fetch(`${baseUrl}/v1/health`, {
      signal: controller.signal,
    });
    lastHealthCheckResult = res.ok;
  } catch {
    lastHealthCheckResult = false;
  } finally {
    clearTimeout(timeoutId);
    lastHealthCheckTime = now;
  }

  return lastHealthCheckResult;
};

// 동시 추론 충돌 방지를 위한 순차 큐
let inferenceQueue: Promise<unknown> = Promise.resolve();

const enqueueInference = <T>(fn: () => Promise<T>): Promise<T> => {
  const resultPromise = inferenceQueue.then(fn, fn);
  inferenceQueue = resultPromise.catch(() => {});
  return resultPromise;
};

/**
 * Qwen3-TTS MLX REST API를 통해 텍스트를 고음질 오디오 스트림으로 합성 (순차 큐 적용)
 */
export const synthesizeQwenSentence = async (
  rawText: string,
  options?: QwenTtsOptions,
): Promise<QwenTtsResult | null> => {
  return enqueueInference(() => doSynthesizeQwenSentence(rawText, options));
};

const doSynthesizeQwenSentence = async (
  rawText: string,
  options?: QwenTtsOptions,
): Promise<QwenTtsResult | null> => {
  const text = rawText.normalize("NFC").trim();
  if (!text) return null;

  const baseUrl = CONFIG.QWEN_TTS_API_URL.replace(/\/+$/, "");
  const mode = options?.mode || "clone";
  const speaker = options?.speaker || "Vivian";
  const instruct = options?.instruct || "";
  const refAudio = options?.refAudio || "";
  const refText = options?.refText || "";
  const timeoutMs = options?.timeoutMs ?? CONFIG.QWEN_TTS_TIMEOUT_MS;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const displayExcerpt = text.length > 25 ? `${text.slice(0, 25)}...` : text;
  console.log(
    `[Qwen3-TTS] 🎙️ 음성 합성 시작: "${displayExcerpt}" (모드: ${mode}, 제한시간: ${timeoutMs / 1000}초)`,
  );

  try {
    const res = await fetch(`${baseUrl}/v1/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        mode,
        speaker,
        instruct,
        ref_audio: refAudio,
        ref_text: refText,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Qwen3-TTS API 호출 실패 (${res.status}): ${errText}`);
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const passThrough = new PassThrough();
    passThrough.end(audioBuffer);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Qwen3-TTS] ✅ 음성 합성 완료 (${elapsedSec}초 소요, 크기: ${audioBuffer.length}바이트)`,
    );

    return {
      stream: passThrough,
      sampleRate: 24000,
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error(
        `[Qwen3-TTS] ⏱️ 음성 합성 시간 초과 (${timeoutMs / 1000}초): 로컬 모델 추론 시간이 초과되었습니다.`,
      );
    } else {
      console.error("[Qwen3-TTS] 음성 합성 중 오류 발생:", err);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};
