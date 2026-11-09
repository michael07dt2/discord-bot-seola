import { PassThrough, type Readable } from "stream";
import CONFIG from "../config/index.ts";

export interface CosyVoiceOptions {
  mode?:
    | "3초 음성 복제"
    | "교차 언어 복제"
    | "자연어 지시 제어"
    | "사전 학습 음색"
    | undefined;
  promptText?: string | undefined;
  promptWavPath?: string | undefined;
  instructText?: string | undefined;
  sftSpeaker?: string | undefined;
  speed?: number | undefined;
  seed?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface CosyVoiceResult {
  stream: Readable;
  sampleRate: number;
}

let lastHealthCheckTime = 0;
let lastHealthCheckResult = false;
const HEALTH_CACHE_TTL_MS = 10_000;

/**
 * CosyVoice 서버 가동 여부 빠른 헬스체크 (1.5초 타임아웃)
 */
export const isCosyVoiceAvailable = async (forceCheck = false): Promise<boolean> => {
  const now = Date.now();
  if (!forceCheck && now - lastHealthCheckTime < HEALTH_CACHE_TTL_MS) {
    return lastHealthCheckResult;
  }

  const baseUrl = CONFIG.COSYVOICE_API_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);

  try {
    const res = await fetch(`${baseUrl}/gradio_api/info`, {
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

/**
 * CosyVoice Gradio 5.x API를 통해 텍스트를 고음질 오디오 스트림으로 합성
 */
export const synthesizeCosyVoiceSentence = async (
  rawText: string,
  options?: CosyVoiceOptions,
): Promise<CosyVoiceResult | null> => {
  const text = rawText.trim();
  if (!text) return null;

  const baseUrl = CONFIG.COSYVOICE_API_URL.replace(/\/+$/, "");
  const mode = options?.mode || CONFIG.COSYVOICE_MODE;
  let promptText = options?.promptText || CONFIG.COSYVOICE_PROMPT_TEXT;
  // CosyVoice 3.0(Fun-CosyVoice3-0.5B) 필수 규격:
  // 프롬프트 텍스트 앞에 <|endofprompt|> 특수 토큰이 없으면 모델 AssertionError가 발생하므로 자동 보정
  if (promptText && !promptText.includes("<|endofprompt|>")) {
    promptText = `You are a helpful assistant.<|endofprompt|>${promptText}`;
  }
  const promptWavPath = options?.promptWavPath || CONFIG.COSYVOICE_PROMPT_WAV;
  const instructText =
    options?.instructText || CONFIG.COSYVOICE_INSTRUCT_TEXT || "";
  const sftSpeaker = options?.sftSpeaker || "(사전 학습 음색 없음)";
  const speed = options?.speed ?? 1.0;
  const seed = options?.seed ?? 0;
  const timeoutMs = options?.timeoutMs ?? CONFIG.COSYVOICE_TIMEOUT_MS;
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const displayExcerpt = text.length > 25 ? `${text.slice(0, 25)}...` : text;
  const instructExcerpt = instructText
    ? ` [지시: "${instructText.length > 15 ? instructText.slice(0, 15) + "..." : instructText}"]`
    : "";
  console.log(
    `[CosyVoice] 🎙️ 음성 합성 시작: "${displayExcerpt}" (모드: ${mode}${instructExcerpt}, 제한시간: ${timeoutMs / 1000}초)`,
  );

  try {
    // 1. 추론 요청 (POST /gradio_api/call/generate_audio)
    const callRes = await fetch(`${baseUrl}/gradio_api/call/generate_audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [
          text,
          mode,
          sftSpeaker,
          promptText,
          { path: promptWavPath },
          null, // 마이크 직접 녹음 파일
          instructText,
          seed,
          false, // stream 여부 (비스트리밍 일괄 생성으로 안정성 확보)
          speed,
        ],
      }),
      signal: controller.signal,
    });

    if (!callRes.ok) {
      const errText = await callRes.text().catch(() => "");
      throw new Error(`CosyVoice API 호출 실패 (${callRes.status}): ${errText}`);
    }

    const { event_id: eventId } = (await callRes.json()) as { event_id: string };
    if (!eventId) {
      throw new Error("CosyVoice API 응답에 event_id가 없습니다.");
    }

    // 2. 결과 대기 (SSE GET /gradio_api/call/generate_audio/{eventId})
    const eventRes = await fetch(`${baseUrl}/gradio_api/call/generate_audio/${eventId}`, {
      signal: controller.signal,
    });

    if (!eventRes.ok || !eventRes.body) {
      throw new Error(`CosyVoice 이벤트 스트림 수신 실패 (${eventRes.status})`);
    }

    const reader = eventRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalAudioMeta: { path?: string; url?: string } | null = null;
    let sseErrorMsg: string | null = null;

    try {
      let currentEvent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("event:")) {
            currentEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (currentEvent === "error") {
              sseErrorMsg = jsonStr || "알 수 없는 백엔드 에러";
              console.error("[CosyVoice] Gradio SSE 에러 수신:", sseErrorMsg);
            }
            try {
              const parsed = JSON.parse(jsonStr);
              if (Array.isArray(parsed) && parsed[0]?.path) {
                finalAudioMeta = parsed[0];
              }
            } catch {
              // 불완전한 JSON 청크 무시
            }
          }
        }
      }

      // 스트림 종료 후 버퍼 잔여 줄 파싱
      if (buffer.trim().startsWith("data:")) {
        const jsonStr = buffer.trim().slice(5).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed) && parsed[0]?.path) {
            finalAudioMeta = parsed[0];
          }
        } catch {
          // 무시
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (sseErrorMsg) {
      throw new Error(`CosyVoice 백엔드 모델 에러: ${sseErrorMsg}`);
    }

    if (!finalAudioMeta?.path) {
      throw new Error("CosyVoice로부터 유효한 오디오 메타데이터를 받지 못했습니다.");
    }

    // 3. 오디오 실제 URL 결정 (HLS playlist.m3u8 또는 단일 파일)
    let audioUrl = `${baseUrl}/gradio_api/stream/${finalAudioMeta.path}`;

    if (finalAudioMeta.path.endsWith(".m3u8")) {
      const m3u8Res = await fetch(audioUrl, { signal: controller.signal });
      if (!m3u8Res.ok) {
        throw new Error(`CosyVoice m3u8 플레이리스트 수신 실패: ${m3u8Res.status}`);
      }
      const m3u8Text = await m3u8Res.text();
      // m3u8 내부의 세그먼트 파일 (.aac, .ts, .wav 등) 추출
      const match = m3u8Text.match(/([^\s\r\n]+\.(?:aac|mp3|wav|ts))/);
      if (!match || !match[1]) {
        throw new Error("m3u8 플레이리스트에서 오디오 세그먼트를 찾을 수 없습니다.");
      }
      const segmentFile = match[1];
      audioUrl = new URL(segmentFile, audioUrl).toString();
    }

    // 4. 오디오 바이너리 스트림 수신 및 PassThrough 변환
    const audioRes = await fetch(audioUrl, { signal: controller.signal });
    if (!audioRes.ok || !audioRes.body) {
      throw new Error(`CosyVoice 최종 오디오 다운로드 실패 (${audioRes.status})`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const passThrough = new PassThrough();
    passThrough.end(audioBuffer);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[CosyVoice] ✅ 음성 합성 완료 (${elapsedSec}초 소요, 크기: ${audioBuffer.length}바이트)`,
    );

    return {
      stream: passThrough,
      sampleRate: 24000,
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.error(
        `[CosyVoice] ⏱️ 음성 합성 시간 초과 (${timeoutMs / 1000}초): 로컬 모델 추론 시간이 초과되었습니다.`,
      );
    } else {
      console.error("[CosyVoice] 음성 합성 중 오류 발생:", err);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};
