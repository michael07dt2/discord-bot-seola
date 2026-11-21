import crypto from "crypto";
import fs from "fs";
import path from "path";
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

// 로컬 참조 음원 파일의 base64/SHA-256 해시 캐시 (도커/호스트 간 경로 분리 대응 및 중복 전송 방지)
const refAudioCache = new Map<string, { base64: string; sha256: string }>();
const uploadedRefHashes = new Set<string>();

const resolveLocalAudioPath = (inputPath: string): string => {
  if (fs.existsSync(inputPath)) {
    return inputPath;
  }
  const baseName = path.basename(inputPath);
  const localProjectAsset = path.resolve(process.cwd(), "asset", baseName);
  if (fs.existsSync(localProjectAsset)) {
    return localProjectAsset;
  }
  return inputPath;
};

const loadRefAudioAsset = (
  refAudioPath: string,
): { base64: string; sha256: string } | undefined => {
  if (!refAudioPath) return undefined;
  const resolvedPath = resolveLocalAudioPath(refAudioPath);
  if (refAudioCache.has(resolvedPath)) {
    return refAudioCache.get(resolvedPath);
  }
  if (!fs.existsSync(resolvedPath)) {
    return undefined;
  }
  const rawBuffer = fs.readFileSync(resolvedPath);
  const entry = {
    base64: rawBuffer.toString("base64"),
    sha256: crypto.createHash("sha256").update(rawBuffer).digest("hex"),
  };
  refAudioCache.set(resolvedPath, entry);
  return entry;
};

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
  const refAudioAsset = loadRefAudioAsset(refAudio);
  const refText = options?.refText || "";
  const timeoutMs = options?.timeoutMs ?? CONFIG.QWEN_TTS_TIMEOUT_MS;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const displayExcerpt = text.length > 25 ? `${text.slice(0, 25)}...` : text;
  console.log(
    `[Qwen3-TTS] 🎙️ 음성 합성 시작: "${displayExcerpt}" (서버: ${baseUrl}, 모드: ${mode}, 제한시간: ${timeoutMs / 1000}초)`,
  );

  const postTts = (useHashOnly: boolean) =>
    fetch(`${baseUrl}/v1/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        mode,
        speaker,
        instruct,
        ref_audio: refAudio,
        ...(refAudioAsset
          ? useHashOnly
            ? { ref_audio_hash: refAudioAsset.sha256 }
            : { ref_audio_base64: refAudioAsset.base64 }
          : {}),
        ref_text: refText,
        response_format: "wav",
      }),
      signal: controller.signal,
    });

  try {
    const uploadKey = refAudioAsset
      ? `${baseUrl}|${refAudioAsset.sha256}`
      : null;
    const canUseHash = uploadKey ? uploadedRefHashes.has(uploadKey) : false;

    let res = await postTts(canUseHash);
    // 서버 재시작 등으로 해시 캐시가 유실된 경우(404) base64로 1회 재업로드
    if (res.status === 404 && canUseHash && uploadKey) {
      uploadedRefHashes.delete(uploadKey);
      res = await postTts(false);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Qwen3-TTS API 호출 실패 (${res.status}): ${errText}`);
    }

    if (uploadKey && !uploadedRefHashes.has(uploadKey)) {
      uploadedRefHashes.add(uploadKey);
    }

    const sampleRateHeader = res.headers.get("X-Sample-Rate");
    const sampleRate = sampleRateHeader ? parseInt(sampleRateHeader, 10) || 24000 : 24000;

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const passThrough = new PassThrough();
    passThrough.end(audioBuffer);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[Qwen3-TTS] ✅ 음성 합성 완료 (${elapsedSec}초 소요, 크기: ${audioBuffer.length}바이트)`,
    );

    return {
      stream: passThrough,
      sampleRate,
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
