import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import type { Readable } from "stream";
import opus from "@discordjs/opus";
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioResource,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type DataType,
} from "@huggingface/transformers";
import CONFIG from "../config/index.ts";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { Client, SendableChannels, VoiceBasedChannel } from "discord.js";
import {
  generateAIResponse,
  appendConversationContext,
  connectToVoiceChannel,
  getUserModel,
} from "./helper.ts";
import { formatDurationMs, logVoicePipelineTiming } from "./logger.ts";
import { songMap } from "./songmap.ts";
import {
  playMusicTrack,
  stopGuildMusic,
  createMusicTrackEmbed,
  sendOrUpdateMusicControlPanel,
  getGuildMusicVolumePercent,
  setGuildMusicVolume,
  initGuildMusicVolume,
  skipGuildMusic,
  getGuildCurrentTrack,
  getGuildMusicQueue,
} from "./youtubeMusic.ts";
import {
  getGuildAudioPlayer,
  getGuildTtsAudioPlayer,
  destroyGuildAudioPlayer,
} from "./audioPlayer.ts";
import {
  getBotSetting,
  setBotSetting,
  getBotSettingsByPrefix,
  deleteBotSetting,
} from "./settings.ts";
import {
  notifyDashboardStatusChanged,
  recordVoiceTranscript,
  type ActiveVoiceSessionStatus,
  type DashboardStatusSnapshot,
} from "./dashboard.ts";
import {
  preloadMeloTTSModel,
  splitTextIntoSentences,
  synthesizeMeloSentence,
} from "./meloTts.ts";
import {
  synthesizeCosyVoiceSentence,
  isCosyVoiceAvailable,
} from "./cosyVoiceTts.ts";
import { synthesizeQwenSentence, isQwenTtsAvailable } from "./qwenTts.ts";

const { OpusEncoder } = opus;

// Whisper 입력 샘플링 레이트 (16kHz Mono)
const SAMPLE_RATE = 16000;

/**
 * ============================================================================
 * 🎙️ STT(음성 인식) & VAD(음성 감지) 핵심 튜닝 파라미터 (코드 상단 또는 .env에서 직접 제어)
 * ============================================================================
 */
export const STT_CONFIG = {
  /** STT 엔진 제공자 ("local" | "deepgram" | "openai" | "groq" | "auto") */
  provider: CONFIG.STT_PROVIDER,
  /** 로컬 Whisper ONNX 모델 ID (권장: onnx-community/whisper-large-v3-turbo) */
  whisperModel: CONFIG.WHISPER_MODEL,
  /** 기본 모델 로드 실패 시 폴백 모델 */
  whisperFallbackModel: CONFIG.WHISPER_FALLBACK_MODEL,
  /** 음성 인식 언어 코드 ("ko", "en", "ja", "zh", "auto" 등) */
  language: CONFIG.STT_LANGUAGE,
  /** 인코더 정밀도 ("fp32" 권장: 멜-스펙트로그램 음향 특징 손실 최소화) */
  encoderDtype: CONFIG.STT_ENCODER_DTYPE,
  /** 디코더 정밀도 ("q8" 권장: 고속 추론) */
  decoderDtype: CONFIG.STT_DECODER_DTYPE,
  /** 빔 서치 너비 (1=Greedy 고속, 2~3=정확도 우선) */
  numBeams: CONFIG.STT_NUM_BEAMS,
  /** 샘플링 온도 (0.0=결정론적) */
  temperature: CONFIG.STT_TEMPERATURE,
  /** 초기 문맥 힌트 프롬프트 (OpenAI/Groq Whisper API 등 지원 백엔드에서 활용) */
  initialPrompt: CONFIG.STT_INITIAL_PROMPT,

  // ─── VAD (음성 감지) 및 감도(Threshold) ───
  /** 발화 종료로 간주할 침묵 대기 시간 (ms) */
  silenceDurationMs: CONFIG.STT_SILENCE_DURATION_MS,
  /** 최소 발화 길이 (초) — 이보다 짧은 클릭/잡음 무시 */
  minSpeechSeconds: CONFIG.STT_MIN_SPEECH_SECONDS,
  /** 최대 발화 버퍼 길이 (초) */
  maxSpeechSeconds: CONFIG.STT_MAX_SPEECH_SECONDS,
  /** 발화 전체 최소 평균 음량(RMS) 임계치 (낮출수록 작은 목소리에 민감) */
  minRmsThreshold: CONFIG.STT_MIN_RMS_THRESHOLD,
  /** 발화 전체 최소 최대 진폭(Peak) 임계치 (낮출수록 작은 목소리에 민감) */
  minPeakThreshold: CONFIG.STT_MIN_PEAK_THRESHOLD,
  /** 프레임 VAD 동적 에너지 비율 (대표 음성 에너지 * 비율) */
  vadEnergyRatio: CONFIG.STT_VAD_ENERGY_RATIO,
  /** 프레임 VAD 최소 RMS 하한선 */
  vadMinFrameRms: CONFIG.STT_VAD_MIN_FRAME_RMS,

  // ─── 노이즈 필터링 & 음질 보정(AGC) ───
  /** 적응형 소프트 노이즈 게이트 활성화 여부 */
  noiseGateEnabled: CONFIG.STT_NOISE_GATE_ENABLED,
  /** 저주파 험/팝 노이즈 차단 하이패스 필터 차단 주파수 (Hz) */
  highpassCutoffHz: CONFIG.STT_HIGHPASS_CUTOFF_HZ,
  /** 고주파 히스 노이즈 차단 로우패스 필터 차단 주파수 (Hz) */
  lowpassCutoffHz: CONFIG.STT_LOWPASS_CUTOFF_HZ,
  /** 한국어 초성/자음 선명도 향상을 위한 프리엠퍼시스 계수 (0.0 ~ 0.5) */
  preEmphasisCoeff: CONFIG.STT_PRE_EMPHASIS_COEFF,
  /** 자동 이득 제어(AGC) 목표 정규화 피크 */
  agcTargetPeak: CONFIG.STT_AGC_TARGET_PEAK,
  /** 자동 이득 제어(AGC) 최대 증폭 배수 */
  agcMaxGain: CONFIG.STT_AGC_MAX_GAIN,

  // ─── 외부 고성능 STT API 옵션 ───
  deepgramApiKey: CONFIG.DEEPGRAM_API_KEY,
  deepgramModel: CONFIG.DEEPGRAM_MODEL,
  apiUrl: CONFIG.STT_API_URL,
  apiKey: CONFIG.STT_API_KEY,
  apiModel: CONFIG.STT_API_MODEL,
} as const;

// TTS 목소리 프리셋 정의 (기본 엔진: 로컬 한국어 전용 신경망 모델 MeloTTS-Korean 및 CosyVoice/Qwen3-TTS)
export interface VoicePreset {
  id: string;
  label: string;
  description: string;
  engine: "melotts" | "edge" | "cosyvoice" | "qwen";
  meloSpeed?: number;
  meloFilter?: string;
  meloNoiseScale?: number;
  meloNoiseScaleW?: number;
  meloSdpRatio?: number;
  cosySpeed?: number;
  cosyMode?:
    | "3초 고속 복제"
    | "3초 음성 복제"
    | "다국어 교차 복제"
    | "교차 언어 복제"
    | "자연어 지시 제어"
    | "사전 학습 음성"
    | "사전 학습 음색";
  cosyPromptWav?: string;
  cosyPromptText?: string;
  cosyInstructText?: string;
  qwenMode?: "clone" | "custom";
  qwenSpeaker?: string;
  qwenInstruct?: string;
  qwenRefAudio?: string;
  qwenRefText?: string;
  voiceName: string;
  voiceLocale: string;
  pitch: string;
  rate: string;
}

// 음원 파일 경로를 로컬 asset 디렉터리 기준으로 자동 해석 (도커 컨테이너 및 호스트 호환)
const resolveAssetPath = (targetPath: string): string => {
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  const fileName = path.basename(targetPath);
  const candidate = path.resolve(process.cwd(), "asset", fileName);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return targetPath;
};

export const VOICE_PRESETS: Record<string, VoicePreset> = {
  kei: {
    id: "kei",
    label: "케이 (블루아카이브 KEY 음성 복제)",
    description:
      "차분하고 쿨하면서도 앙칼진 블루아카이브 케이의 신경망 복제 보이스 (Qwen3-TTS / CosyVoice)",
    engine: "qwen",
    qwenMode: "clone",
    qwenRefAudio: resolveAssetPath("asset/youtube_kei.wav"),
    qwenRefText:
      "에이! 진짜 그렇게 착한 애 취급하지 말라구요! 그쵸! 그렇게까지 애 아니니까요! 무섭겠다... 선생님 지금 웃었죠? 똑똑히 봤어요! 두고 봐요! 언젠간 그 몸에 뼈저리게 새겨줄테니까!",
    qwenInstruct:
      "차갑고 감정이 절제된 어린 소녀의 목소리. 아리스보다 반 옥타브 낮고 차분한 톤으로, 억양의 높낮이 변화가 적고 기계처럼 또박또박 일정한 속도로 말한다.",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("asset/youtube_kei.wav"),
    cosyInstructText:
      "차갑고 감정이 절제된 어린 소녀의 목소리. 아리스보다 반 옥타브 낮고 차분한 톤으로, 억양의 높낮이 변화가 적고 기계처럼 또박또박 일정한 속도로 말한다.",
    voiceName: "kei-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  qwen: {
    id: "qwen",
    label: "큐웬 (Qwen3-TTS MLX 프리셋)",
    description:
      "Apple Silicon 최적화 Qwen3-TTS 0.6B CustomVoice 모델 (Vivian 성우)",
    engine: "qwen",
    qwenMode: "custom",
    qwenSpeaker: "Vivian",
    qwenInstruct: "밝고 친절한 상냥한 톤으로 말해줘.",
    voiceName: "qwen-vivian",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  cosy: {
    id: "cosy",
    label: "코지 (CosyVoice 음성 복제)",
    description: "환경 변수(.env)에 지정된 프롬프트 음성 기반 고음질 보이스",
    engine: "cosyvoice",
    cosySpeed: 1.0,
    cosyMode: CONFIG.COSYVOICE_MODE,
    cosyPromptWav: resolveAssetPath(CONFIG.COSYVOICE_PROMPT_WAV),
    voiceName: "cosy-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  reva: {
    id: "reva",
    label: "레바 (유튜브 스트리머 레바 음성 복제)",
    description: "재치있고 시니컬한 드로잉 스트리머 레바의 보이스 (CosyVoice)",
    engine: "cosyvoice",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("asset/youtube_prompt.wav"),
    cosyPromptText:
      "확실히 요새 좀 옛날보단 그림에 대한 상상력이 줄어든 것 같아요.".normalize(
        "NFC",
      ),
    voiceName: "reva-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  gamgyuri: {
    id: "gamgyuri",
    label: "감규리 (유튜브 감규리 음성 복제)",
    description: "발랄하고 귀여운 게이머 감규리의 보이스 (CosyVoice)",
    engine: "cosyvoice",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("asset/youtube_prompt_307_318.wav"),
    cosyPromptText:
      "자 이렇게 오늘의 게임 마무리해보도록 하겠습니다. 어쩐지 뭐 얼마 안 한 거 같은데 여기 다 온 거 같지?".normalize(
        "NFC",
      ),
    voiceName: "gamgyuri-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  myoya: {
    id: "myoya",
    label: "다시는 만날 수 없는 (Qwen3-TTS 신경망 복제)",
    description:
      "다시는 만날 수 없는 그 사람의 다정하고 나긋나긋한 신경망 복제 보이스 (Qwen3-TTS)",
    engine: "qwen",
    qwenMode: "clone",
    qwenRefAudio: resolveAssetPath("asset/youtube_myoya.wav"),
    qwenRefText:
      "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize(
        "NFC",
      ),
    qwenInstruct:
      "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("asset/youtube_myoya.wav"),
    cosyPromptText:
      "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize(
        "NFC",
      ),
    cosyInstructText:
      "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    voiceName: "myoya-qwen",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  myoya_cosy: {
    id: "myoya_cosy",
    label: "다시는 만날 수 없는 (CosyVoice 음성 복제)",
    description:
      "다시는 만날 수 없는 그 사람의 다정하고 나긋나긋한 음성 복제 보이스 (CosyVoice)",
    engine: "cosyvoice",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("asset/youtube_myoya.wav"),
    cosyPromptText:
      "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize(
        "NFC",
      ),
    cosyInstructText:
      "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    voiceName: "myoya-cosy",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  seola: {
    id: "seola",
    label: "설아 (MeloTTS 자연스러운 기본)",
    description: "설아의 시그니처 톤 - 밝고 또렷한 20대 여성 목소리 (기본값)",
    engine: "melotts",
    meloSpeed: 1.04,
    meloFilter:
      "asetrate=44100*1.04,atempo=1/1.04,equalizer=f=3500:t=q:w=1:g=2",
    meloNoiseScale: 0.5,
    meloNoiseScaleW: 0.6,
    meloSdpRatio: 0.2,
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  lively: {
    id: "lively",
    label: "발랄 (MeloTTS 통통 튀는 고음 톤)",
    description:
      "피치가 높고 경쾌한 통통 튀는 발랄한 여동생/친구 톤 (+14% 피치 상승)",
    engine: "melotts",
    meloSpeed: 1.08,
    meloFilter:
      "asetrate=44100*1.14,atempo=1/1.14,equalizer=f=4000:t=q:w=1:g=3",
    meloNoiseScale: 0.55,
    meloNoiseScaleW: 0.65,
    meloSdpRatio: 0.25,
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+10Hz",
    rate: "+5%",
  },
  calm: {
    id: "calm",
    label: "차분 (MeloTTS 부드러운 저음 톤)",
    description:
      "낮고 부드러운 음색의 차분하고 나긋나긋한 성숙한 대화 톤 (-12% 피치 하강)",
    engine: "melotts",
    meloSpeed: 0.95,
    meloFilter: "asetrate=44100*0.88,atempo=1/0.88,equalizer=f=250:t=q:w=1:g=3",
    meloNoiseScale: 0.45,
    meloNoiseScaleW: 0.5,
    meloSdpRatio: 0.15,
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  whisper: {
    id: "whisper",
    label: "속삭임 (MeloTTS 조용하고 포근한 톤)",
    description: "조용히 속삭이듯 포근하고 부드러운 저자극 나긋나긋 톤",
    engine: "melotts",
    meloSpeed: 0.92,
    meloFilter: "asetrate=44100*0.96,atempo=1/0.96,lowpass=f=7500",
    meloNoiseScale: 0.42,
    meloNoiseScaleW: 0.48,
    meloSdpRatio: 0.1,
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  melo: {
    id: "melo",
    label: "멜로 (MeloTTS 표준 원본 톤)",
    description: "MeloTTS-Korean 오리지널 표준 화자 음색 (필터 미적용 원음)",
    engine: "melotts",
    meloSpeed: 1.0,
    meloNoiseScale: 0.48,
    meloNoiseScaleW: 0.55,
    meloSdpRatio: 0.2,
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  ava: {
    id: "ava",
    label: "아바 (Edge 다국어 음성)",
    description: "Microsoft Edge 신경망 다국어 여성 대화 톤 (Ava Multilingual)",
    engine: "edge",
    voiceName: "en-US-AvaMultilingualNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  sunhi: {
    id: "sunhi",
    label: "선희 (Edge 한국어 음성)",
    description: "Microsoft Edge 한국어 전용 여성 음성 (SunHi Neural)",
    engine: "edge",
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
};

// 목소리 프리셋 로컬 캐시 파일 (DB 장애 또는 초기 기동 시 이중 보존용)
const VOICE_CACHE_FILE = path.resolve(process.cwd(), ".voice_preset");

// 로컬 캐시 파일에서 저장된 프리셋 키 안전하게 읽기
const readCachedVoicePreset = (): string | null => {
  try {
    if (fs.existsSync(VOICE_CACHE_FILE)) {
      const cached = fs.readFileSync(VOICE_CACHE_FILE, "utf-8").trim();
      if (cached && VOICE_PRESETS[cached]) {
        return cached;
      }
    }
  } catch (err) {
    console.warn("[VoiceChat] 로컬 목소리 캐시 읽기 실패:", err);
  }
  return null;
};

// 로컬 캐시 파일에 프리셋 키 안전하게 저장
const writeCachedVoicePreset = (key: string): void => {
  try {
    fs.writeFileSync(VOICE_CACHE_FILE, key, "utf-8");
  } catch (err) {
    console.warn("[VoiceChat] 로컬 목소리 캐시 쓰기 실패:", err);
  }
};

// 현재 선택된 목소리 프리셋 (기본 우선순위: 1. 로컬 캐시 파일 -> 2. .env TTS_PRESET -> 3. 'seola')
let currentVoicePresetKey: string =
  readCachedVoicePreset() ||
  (CONFIG.TTS_PRESET && VOICE_PRESETS[CONFIG.TTS_PRESET]
    ? CONFIG.TTS_PRESET
    : "seola");

export const getCurrentVoicePreset = (): VoicePreset => {
  return VOICE_PRESETS[currentVoicePresetKey] ?? VOICE_PRESETS["seola"]!;
};

/**
 * DB 또는 로컬 캐시에서 마지막으로 저장된 목소리 프리셋을 로드하여 복원 (재부팅 유지)
 */
export const initVoicePresetFromDb = async (): Promise<VoicePreset> => {
  try {
    // 1차: DB(bot_settings) 조회
    const saved = await getBotSetting("voice_preset");
    if (saved && VOICE_PRESETS[saved]) {
      currentVoicePresetKey = saved;
      writeCachedVoicePreset(saved);
      console.log(
        `[VoiceChat] 💾 재부팅 이전 DB 저장된 목소리 복원 완료: ${VOICE_PRESETS[saved].label} (${saved})`,
      );
      return getCurrentVoicePreset();
    }
  } catch (err) {
    console.warn(
      "[VoiceChat] DB 목소리 설정 복원 실패 (로컬 캐시 확인 중):",
      err,
    );
  }

  // 2차: 로컬 캐시 파일 확인
  const cached = readCachedVoicePreset();
  if (cached && VOICE_PRESETS[cached]) {
    currentVoicePresetKey = cached;
    console.log(
      `[VoiceChat] 💾 로컬 캐시에서 목소리 복원 완료: ${VOICE_PRESETS[cached].label} (${cached})`,
    );
    return getCurrentVoicePreset();
  }

  // 3차: 환경 변수(.env) TTS_PRESET 또는 기본값 유지
  if (CONFIG.TTS_PRESET && VOICE_PRESETS[CONFIG.TTS_PRESET]) {
    currentVoicePresetKey = CONFIG.TTS_PRESET;
    writeCachedVoicePreset(CONFIG.TTS_PRESET);
  }

  return getCurrentVoicePreset();
};

const VOICE_PRESET_ALIAS_MAP: Record<string, string> = {
  설아: "seola",
  서라: "seola",
  seola: "seola",
  기본: "seola",
  멜로: "melo",
  melo: "melo",
  melotts: "melo",
  발랄: "lively",
  경쾌: "lively",
  lively: "lively",
  차분: "calm",
  나긋: "calm",
  calm: "calm",
  속삭임: "whisper",
  속사김: "whisper",
  포근: "whisper",
  whisper: "whisper",
  아바: "ava",
  ava: "ava",
  선희: "sunhi",
  sunhi: "sunhi",
  cosy: "cosy",
  cosyvoice: "cosy",
  코지: "cosy",
  코지보이스: "cosy",
  kei: "kei",
  케이: "kei",
  캐이: "kei",
  key: "kei",
  qwen: "qwen",
  큐웬: "qwen",
  큐엔: "qwen",
  qwen3: "qwen",
  reva: "reva",
  레바: "reva",
  래바: "reva",
  gamgyuri: "gamgyuri",
  감규리: "gamgyuri",
  감귤이: "gamgyuri",
  규리: "gamgyuri",
  gyuri: "gamgyuri",
  myoya: "myoya",
  묘야: "myoya",
  묘야큐웬: "myoya",
  "다시는 만날 수 없는": "myoya",
  다시는만날수없는: "myoya",
  다만없: "myoya",
  myoya_cosy: "myoya_cosy",
  myoyacosy: "myoya_cosy",
  묘야코지: "myoya_cosy",
  "다시는 만날 수 없는 코지": "myoya_cosy",
  다시는만날수없는코지: "myoya_cosy",
  다만없코지: "myoya_cosy",
};

export const resolveVoicePresetKey = (input: string): string | undefined => {
  const key = input.trim().toLowerCase();
  if (!key) return undefined;
  const compactKey = key.replace(/\s+/g, "");
  const resolved =
    VOICE_PRESET_ALIAS_MAP[key] ||
    VOICE_PRESET_ALIAS_MAP[compactKey] ||
    (VOICE_PRESETS[key] ? key : undefined);
  return resolved && VOICE_PRESETS[resolved] ? resolved : undefined;
};

export const setVoicePreset = async (
  input: string,
  options?: { persist?: boolean },
): Promise<VoicePreset | null> => {
  const resolvedKey = resolveVoicePresetKey(input);
  if (!resolvedKey || !VOICE_PRESETS[resolvedKey]) {
    return null;
  }

  currentVoicePresetKey = resolvedKey;

  // DB 및 로컬 캐시 파일에 영구 저장 (재부팅 후에도 100% 유지되도록 이중 보장)
  if (options?.persist !== false) {
    writeCachedVoicePreset(resolvedKey);
    try {
      await setBotSetting("voice_preset", resolvedKey);
    } catch (err) {
      console.warn(
        "[VoiceChat] 목소리 설정 DB 저장 실패 (로컬 캐시에는 보존됨):",
        err,
      );
    }
  }

  return VOICE_PRESETS[resolvedKey]!;
};

/**
 * 자연어 대화/음성 발화에서 목소리(TTS) 프리셋 조회·변경 의도를 파싱
 */
export const extractVoicePresetCommand = (
  text: string,
):
  | { type: "list" }
  | { type: "current" }
  | { type: "change"; presetId: string }
  | null => {
  const normalized = text
    .replace(/\/no_think/gi, "")
    .replace(/^[.,!?~…"''"\s]+|[.,!?~…"''"\s]+$/g, "")
    .replace(
      /^(?:설아야|서라야|설하야|소라야|사라야|서로야|저라야|바라야|바로야|올아야|수라야|솔아야|설아)\s*[,.!?~\s]*/,
      "",
    )
    .trim();

  if (!normalized) {
    return null;
  }

  if (
    /^(?:사용\s*가능한?\s*)?(?:목소리|보이스|음성|tts|프리셋)\s*(?:목록|종류|리스트)\s*[?!.]*$/i.test(
      normalized,
    ) ||
    /^(?:어떤|무슨)\s*(?:목소리|보이스|음성|프리셋)\s*(?:이|가)?\s*있어\s*[?!.]*$/i.test(
      normalized,
    ) ||
    /^(?:목소리|보이스|음성|프리셋)\s*뭐\s*있어\s*[?!.]*$/i.test(normalized)
  ) {
    return { type: "list" };
  }

  if (
    /^(?:현재|지금)\s*(?:내\s*)?(?:무슨|어떤)?\s*(?:목소리|보이스|음성\s*프리셋|프리셋|tts)(?:\s*(?:뭐야|뭔데|알려\s*줘|보여\s*줘|야|이야|인가요|예요|에요))?\s*[?!.]*$/i.test(
      normalized,
    ) ||
    /^(?:목소리|보이스|프리셋)\s*(?:확인|상태|알려\s*줘)\s*[?!.]*$/i.test(normalized)
  ) {
    return { type: "current" };
  }

  const cleanCandidate = (raw: string): string =>
    raw
      .trim()
      .replace(/\s*(?:으로|로)$/i, "")
      .trim();

  const prefixMatch = normalized.match(
    /^(?:목소리|보이스|음성|tts|프리셋)(?:를|을|는|은)?\s*(?:(?:변경|바꿔|설정|교체)(?:해\s*줘|줘)?\s+)?(.+?)(?:\s*(?:으로|로)?\s*(?:바꿔\s*줘|바꿔\s*줄래|변경해\s*줘|변경해\s*줄래|설정해\s*줘|교체해\s*줘|해\s*줘|해\s*줄래|바꿔|변경|설정|교체))?$/i,
  );
  if (prefixMatch?.[1]) {
    const resolved = resolveVoicePresetKey(cleanCandidate(prefixMatch[1]));
    if (resolved) {
      return { type: "change", presetId: resolved };
    }
  }

  const suffixMatch = normalized.match(
    /^(.+?)\s*(?:으로|로)?\s*(?:목소리|보이스|음성|tts|프리셋)(?:를|을|로|으로)?\s*(?:바꿔\s*줘|바꿔\s*줄래|변경해\s*줘|변경해\s*줄래|설정해\s*줘|교체해\s*줘|해\s*줘|해\s*줄래|바꿔|변경|설정|교체)$/i,
  );
  if (suffixMatch?.[1]) {
    const resolved = resolveVoicePresetKey(cleanCandidate(suffixMatch[1]));
    if (resolved) {
      return { type: "change", presetId: resolved };
    }
  }

  return null;
};

// 무음/잡음 구간에서 Whisper가 흔히 생성하는 환각(Hallucination) 문구 필터
const WHISPER_HALLUCINATIONS = new Set([
  "자막 제공",
  "자막제공",
  "한글자막",
  "한국어자막",
  "자막",
  "시청해주셔서 감사합니다",
  "시청해 주셔서 감사합니다",
  "구독과 좋아요",
  "좋아요와 구독",
  "감사합니다",
  "고맙습니다",
  "mbc뉴스",
  "kbs뉴스",
  "sbs뉴스",
  "ytn뉴스",
  "jtbc뉴스",
  "뉴스",
  "딩동댕",
  "다음영상에서만나요",
  "다음시간에만나요",
  "이영상은",
  "음",
  "아",
  "어",
  "으",
  "네",
  "예",
  "응",
]);

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null =
  null;

// 길드별 활성 음성 대화 세션 관리
interface GuildVoiceSession {
  guildId: string;
  voiceChannel: VoiceBasedChannel;
  textChannel: SendableChannels | null;
  activeUsers: Set<string>;
  processingChain: Promise<void>;
  pendingSttCount: number;
  voiceChatEnabled: boolean;
  playbackMode: "idle" | "tts" | "music";
  cleanup: () => void;
}

const guildSessions = new Map<string, GuildVoiceSession>();

let sharedDashboardSnapshotGetter: (() => DashboardStatusSnapshot) | null = null;

export const setVoiceChatDependencies = (deps: {
  getDashboardStatusSnapshot: () => DashboardStatusSnapshot;
}): void => {
  sharedDashboardSnapshotGetter = deps.getDashboardStatusSnapshot;
};

export const notifyVoiceDashboardStatusChanged = (): void => {
  if (sharedDashboardSnapshotGetter) {
    notifyDashboardStatusChanged(sharedDashboardSnapshotGetter());
  }
};

const resolveWhisperLanguage = (code: string): string | undefined => {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  const map: Record<string, string> = {
    ko: "korean",
    kr: "korean",
    korean: "korean",
    en: "english",
    us: "english",
    english: "english",
    ja: "japanese",
    jp: "japanese",
    japanese: "japanese",
    zh: "chinese",
    cn: "chinese",
    chinese: "chinese",
  };
  return map[normalized] || normalized;
};

const resolveIsoLanguage = (code: string): string | undefined => {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  const map: Record<string, string> = {
    korean: "ko",
    ko: "ko",
    kr: "ko",
    english: "en",
    en: "en",
    us: "en",
    japanese: "ja",
    ja: "ja",
    jp: "ja",
    chinese: "zh",
    zh: "zh",
    cn: "zh",
  };
  return map[normalized] || normalized.slice(0, 2);
};

const resolveActiveSttProvider = (): "local" | "deepgram" | "openai" => {
  if (STT_CONFIG.provider === "deepgram" && STT_CONFIG.deepgramApiKey) {
    return "deepgram";
  }
  if (
    (STT_CONFIG.provider === "openai" || STT_CONFIG.provider === "groq") &&
    STT_CONFIG.apiKey
  ) {
    return "openai";
  }
  if (STT_CONFIG.provider === "auto") {
    if (STT_CONFIG.deepgramApiKey) return "deepgram";
    if (STT_CONFIG.apiKey) return "openai";
  }
  return "local";
};

export const getSttConfigSummary = (): {
  provider: "local" | "deepgram" | "openai";
  model: string;
  language: string;
  silenceDurationMs: number;
  minRmsThreshold: number;
  minPeakThreshold: number;
  vadEnergyRatio: number;
} => {
  const activeProvider = resolveActiveSttProvider();
  const model =
    activeProvider === "deepgram"
      ? `deepgram/${STT_CONFIG.deepgramModel}`
      : activeProvider === "openai"
        ? STT_CONFIG.apiModel
        : `${STT_CONFIG.whisperModel} (enc:${STT_CONFIG.encoderDtype}/dec:${STT_CONFIG.decoderDtype})`;
  return {
    provider: activeProvider,
    model,
    language: STT_CONFIG.language,
    silenceDurationMs: STT_CONFIG.silenceDurationMs,
    minRmsThreshold: STT_CONFIG.minRmsThreshold,
    minPeakThreshold: STT_CONFIG.minPeakThreshold,
    vadEnergyRatio: STT_CONFIG.vadEnergyRatio,
  };
};

type AsrPipelineLoader = (
  task: "automatic-speech-recognition",
  model: string,
  options: {
    dtype?: DataType | Record<string, DataType>;
    session_options?: {
      intraOpNumThreads?: number;
      interOpNumThreads?: number;
    };
  },
) => Promise<AutomaticSpeechRecognitionPipeline>;

const loadWhisperModelWithRetry = async (
  loadAsr: AsrPipelineLoader,
  modelId: string,
): Promise<AutomaticSpeechRecognitionPipeline> => {
  // Discord WebSocket 및 SlashCommand(3초 deferReply) 이벤트 루프 블로킹을 막기 위해 ONNX 스레드 수 제한
  const sessionOptions = {
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  };
  const hybridDtype: Record<string, DataType> = {
    encoder_model: STT_CONFIG.encoderDtype as DataType,
    decoder_model_merged: STT_CONFIG.decoderDtype as DataType,
  };
  try {
    return await loadAsr("automatic-speech-recognition", modelId, {
      dtype: hybridDtype,
      session_options: sessionOptions,
    });
  } catch (hybridErr) {
    console.warn(
      `[VoiceChat] ${modelId} 하이브리드 정밀도(enc:${STT_CONFIG.encoderDtype}/dec:${STT_CONFIG.decoderDtype}) 로드 실패, 단일 dtype(${STT_CONFIG.decoderDtype})으로 재시도:`,
      hybridErr instanceof Error ? hybridErr.message : hybridErr,
    );
    return await loadAsr("automatic-speech-recognition", modelId, {
      dtype: STT_CONFIG.decoderDtype as DataType,
      session_options: sessionOptions,
    });
  }
};

/**
 * 로컬 Whisper STT 및 MeloTTS-Korean 파이프라인 싱글톤 사전 로드
 * - 기본 모델(`onnx-community/whisper-large-v3-turbo`) 로드 실패 시 폴백 모델로 자동 전환
 */
export const preloadWhisperModel = async (): Promise<AutomaticSpeechRecognitionPipeline> => {
  // MeloTTS-Korean 로컬 모델도 함께 워밍업
  preloadMeloTTSModel().catch(() => {});

  if (!transcriberPromise) {
    const loadAsr = pipeline as unknown as AsrPipelineLoader;
    const candidates = Array.from(
      new Set([
        STT_CONFIG.whisperModel,
        STT_CONFIG.whisperFallbackModel,
        "onnx-community/whisper-base",
      ]),
    ).filter(Boolean);

    transcriberPromise = (async () => {
      let lastError: unknown;
      for (let i = 0; i < candidates.length; i++) {
        const modelId = candidates[i]!;
        try {
          console.log(
            `[VoiceChat] 로컬 Whisper STT 모델 로드 중... (${modelId}, enc=${STT_CONFIG.encoderDtype}, dec=${STT_CONFIG.decoderDtype})`,
          );
          const instance = await loadWhisperModelWithRetry(loadAsr, modelId);
          console.log(`[VoiceChat] Whisper STT 모델 준비 완료 (${modelId})`);
          return instance;
        } catch (err) {
          lastError = err;
          if (i < candidates.length - 1) {
            console.warn(
              `[VoiceChat] ${modelId} 로드 실패, 다음 폴백 모델(${candidates[i + 1]})로 재시도합니다:`,
              err,
            );
          }
        }
      }
      transcriberPromise = null;
      console.error("[VoiceChat] 모든 Whisper STT 모델 로드 실패:", lastError);
      throw lastError;
    })();
  }
  return transcriberPromise;
};

/**
 * 현재 플레이어 상태를 외부(음원 재생 등)에서 동기화하기 위한 헬퍼
 */
export const setGuildPlaybackMode = (
  guildId: string,
  mode: "idle" | "tts" | "music",
): void => {
  const session = guildSessions.get(guildId);
  if (session) {
    session.playbackMode = mode;
  }
  if (mode === "idle") {
    stopGuildMusic(guildId);
  }
};

/**
 * 음성 대화용 텍스트 채널 업데이트 및 활성화 상태 제어
 */
export const setVoiceChatEnabled = (
  guildId: string,
  enabled: boolean,
): boolean => {
  const session = guildSessions.get(guildId);
  if (!session) return false;
  session.voiceChatEnabled = enabled;
  return true;
};

/**
 * 현재 활성화된 모든 길드 음성 세션 상태 목록 반환 (대시보드 표시용)
 */
export const getActiveVoiceSessions = (): ActiveVoiceSessionStatus[] => {
  const result: ActiveVoiceSessionStatus[] = [];
  for (const session of guildSessions.values()) {
    result.push({
      guildId: session.guildId,
      guildName: session.voiceChannel.guild.name,
      channelId: session.voiceChannel.id,
      channelName: session.voiceChannel.name,
      voiceChatEnabled: session.voiceChatEnabled,
      playbackMode: session.playbackMode,
      activeSpeakerCount: session.activeUsers.size,
    });
  }
  return result;
};

/**
 * 특정 길드의 음성 채널 퇴장 및 세션 리소스 완전히 해제
 */
export const leaveVoiceChannel = (guildId: string): boolean => {
  stopGuildMusic(guildId);
  destroyGuildAudioPlayer(guildId);
  ttsPausedMusicGuilds.delete(guildId);
  const session = guildSessions.get(guildId);
  if (session) {
    try {
      session.cleanup();
    } catch (err) {
      console.warn(`[VoiceChat] 세션 cleanup 중 오류 (길드: ${guildId}):`, err);
    }
    guildSessions.delete(guildId);
  }

  const connection = getVoiceConnection(guildId);
  if (connection) {
    try {
      connection.destroy();
      console.log(
        `[VoiceChat] 길드(${guildId}) 음성 채널 연결을 성공적으로 해제(퇴장)했습니다.`,
      );
      return true;
    } catch (err) {
      console.error(
        `[VoiceChat] 길드(${guildId}) connection.destroy 실패:`,
        err,
      );
    }
  }

  return session !== undefined;
};

export interface PersistedVoiceSessionData {
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  textChannelId: string | null;
  savedAt: number;
}

/**
 * 음성 채널 접속 세션을 DB에 영구 저장 (재부팅/업데이트 시 복원용)
 */
export const saveVoiceSessionToDb = async (session: {
  guildId: string;
  guildName: string;
  voiceChannelId: string;
  voiceChannelName: string;
  textChannelId: string | null;
}): Promise<void> => {
  try {
    const key = `voice_session:${session.guildId}`;
    const data: PersistedVoiceSessionData = {
      ...session,
      savedAt: Date.now(),
    };
    await setBotSetting(key, JSON.stringify(data));
  } catch (err) {
    console.warn("[VoiceChat] 음성 세션 상태 저장 실패:", err);
  }
};

/**
 * 정상 퇴장 시 DB에서 음성 세션 삭제
 */
export const clearVoiceSessionFromDb = async (
  guildId: string,
): Promise<void> => {
  try {
    await deleteBotSetting(`voice_session:${guildId}`);
  } catch (err) {
    console.warn(
      `[VoiceChat] 음성 세션 상태 삭제 실패 (길드: ${guildId}):`,
      err,
    );
  }
};

/**
 * 봇 재시작/업데이트 시, 최근에 접속해 있던 음성 채널 자동 복원
 * - 최근 10분 이내에 활성화되어 있었고,
 * - 채널에 다른 유저(사람)가 아직 남아있을 경우에만 자동 재입장
 */
export const restoreVoiceSessionsIfRecent = async (
  client: Client,
  maxAgeMs = 10 * 60 * 1000, // 기본 10분 이내
): Promise<void> => {
  try {
    const rows = await getBotSettingsByPrefix("voice_session:");
    if (rows.length === 0) return;

    const now = Date.now();
    for (const row of rows) {
      let data: PersistedVoiceSessionData | null = null;
      try {
        data = JSON.parse(row.value) as PersistedVoiceSessionData;
      } catch {
        await deleteBotSetting(row.key);
        continue;
      }

      if (!data || !data.guildId || !data.voiceChannelId) {
        await deleteBotSetting(row.key);
        continue;
      }

      // 1. 오래된 세션인지 확인 (지정 시간 초과 시 만료 처리)
      const elapsedMs = now - (data.savedAt || 0);
      if (elapsedMs > maxAgeMs) {
        console.log(
          `[VoiceChat] ⏳ 길드(${data.guildName || data.guildId}) 이전 음성 세션 만료(${Math.round(elapsedMs / 1000 / 60)}분 전)로 자동 복원을 건너뜁니다.`,
        );
        await deleteBotSetting(row.key);
        continue;
      }

      // 2. 길드 및 음성 채널 존재 확인
      const guild = await client.guilds.fetch(data.guildId).catch(() => null);
      if (!guild) {
        await deleteBotSetting(row.key);
        continue;
      }

      const voiceChannel = (await guild.channels
        .fetch(data.voiceChannelId)
        .catch(() => null)) as VoiceBasedChannel | null;
      if (!voiceChannel || !voiceChannel.isVoiceBased()) {
        await deleteBotSetting(row.key);
        continue;
      }

      // 3. 음성 채널에 봇이 아닌 실제 사람 멤버가 남아있는지 확인
      const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);
      if (humanMembers.size === 0) {
        console.log(
          `[VoiceChat] 👥 길드(${guild.name})의 음성 채널(${voiceChannel.name})에 사용자가 아무도 없어 자동 재입장을 건너뜁니다.`,
        );
        await deleteBotSetting(row.key);
        continue;
      }

      // 4. 텍스트 채널 해석
      let textChannel: SendableChannels | null = null;
      if (data.textChannelId) {
        const resolvedText = await guild.channels
          .fetch(data.textChannelId)
          .catch(() => null);
        if (resolvedText && resolvedText.isSendable()) {
          textChannel = resolvedText as SendableChannels;
        }
      }

      // 5. 음성 채널 자동 재입장 및 리스너 등록
      try {
        console.log(
          `[VoiceChat] 🔄 재부팅 이전 음성 세션 복원 시작: ${guild.name} / ${voiceChannel.name} (대기 인원: ${humanMembers.size}명)`,
        );
        const player = getGuildAudioPlayer(guild.id);
        const connection = await connectToVoiceChannel(voiceChannel);
        setupVoiceChatListener({
          client,
          connection,
          voiceChannel,
          textChannel,
          player,
        });

        // 텍스트 안내 메시지
        if (textChannel && textChannel.isSendable()) {
          await textChannel
            .send(
              `🌸 **설아가 돌아왔어요!** 봇 재시작/업데이트가 완료되어 음성 채널(**${voiceChannel.name}**)에 자동으로 다시 연결되었습니다.`,
            )
            .catch(() => {});
        }

        // 음성 안내 TTS 발화
        await speakInVoiceChannel(
          connection,
          player,
          guild.id,
          "업데이트가 끝나서 다시 돌아왔어!",
        );

        console.log(
          `[VoiceChat] ✅ 음성 세션 자동 복원 완료: ${guild.name} / ${voiceChannel.name}`,
        );
      } catch (connErr) {
        console.error(
          `[VoiceChat] 음성 세션 자동 복원 실패 (${guild.name} / ${voiceChannel.name}):`,
          connErr,
        );
        await deleteBotSetting(row.key);
      }
    }
  } catch (err) {
    console.error("[VoiceChat] 음성 세션 복원 중 예외 발생:", err);
  }
};

/**
 * 프로세스 종료 또는 봇 재시작 시 활성화된 모든 음성 채널에서 완전히 퇴장 처리
 */
export const leaveAllVoiceChannels = async (): Promise<void> => {
  const activeGuildIds = Array.from(guildSessions.keys());
  if (activeGuildIds.length === 0) {
    return;
  }

  console.log(
    `[VoiceChat] 🚪 프로세스 종료/정리에 따라 ${activeGuildIds.length}개 음성 채널 퇴장을 진행합니다...`,
  );

  for (const guildId of activeGuildIds) {
    leaveVoiceChannel(guildId);
  }

  guildSessions.clear();
};

/**
 * 길드 음성 대화 세션 해제 (사용자 요청에 의한 명시적 퇴장)
 */
export const removeVoiceChatSession = (guildId: string): void => {
  leaveVoiceChannel(guildId);
  // 사용자의 명시적 퇴장이므로 DB에서 세션 삭제 (재부팅 시 자동 재입장 방지)
  clearVoiceSessionFromDb(guildId).catch(() => {});
};

/**
 * 16-bit Signed Little-Endian PCM 버퍼를 Whisper/STT 입력에 최적화된 Float32Array(-1.0 ~ 1.0)로 전처리
 * - 1) DC 오프셋 제거 + Band-Pass 필터(HPF & LPF)로 마이크 험/팝/고주파 히스 노이즈 차단
 * - 2) 20ms 프레임별 RMS & 영교차율(ZCR) 분석으로 배경 노이즈 플로어를 추정하고 초성 자음('ㅅ', 'ㅎ' 등) 손실 없는 VAD 트리밍
 * - 3) 적응형 소프트 노이즈 게이트 + 한국어 자음 변별력 보강 프리엠퍼시스 적용
 * - 4) 백분위수 기반 AGC + Soft-Knee 리미터로 클리핑 없이 음량을 최적화하고 앞/뒤 무음 패딩 추가
 */
const pcm16ToFloat32 = (
  pcmBuffer: Buffer,
): {
  samples: Float32Array;
  rms: number;
  peak: number;
  durationSec: number;
} => {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0) {
    return {
      samples: new Float32Array(0),
      rms: 0,
      peak: 0,
      durationSec: 0,
    };
  }

  // 1. Int16 -> Float32 변환 및 DC 오프셋 제거
  const dcRemoved = new Float32Array(sampleCount);
  let dcSum = 0;
  for (let i = 0; i < sampleCount; i++) {
    const v = pcmBuffer.readInt16LE(i * 2) / 32768.0;
    dcRemoved[i] = v;
    dcSum += v;
  }
  const dcOffset = dcSum / sampleCount;

  // 1차 하이패스 필터(HPF) 및 1차 로우패스 필터(LPF) 계수 계산
  const hpCutoff = STT_CONFIG.highpassCutoffHz;
  const hpfAlpha =
    hpCutoff > 0
      ? 1.0 / (1.0 + (2.0 * Math.PI * hpCutoff) / SAMPLE_RATE)
      : 1.0;

  const lpCutoff = STT_CONFIG.lowpassCutoffHz;
  const useLpf = lpCutoff > 0 && lpCutoff < SAMPLE_RATE / 2;
  const lpfAlpha = useLpf
    ? (2.0 * Math.PI * lpCutoff) /
      SAMPLE_RATE /
      (1.0 + (2.0 * Math.PI * lpCutoff) / SAMPLE_RATE)
    : 1.0;

  const rawSamples = new Float32Array(sampleCount);
  let prevHpX = 0;
  let prevHpY = 0;
  let prevLpY = 0;

  for (let i = 0; i < sampleCount; i++) {
    const x = dcRemoved[i]! - dcOffset;
    const hpY =
      hpCutoff > 0 ? hpfAlpha * (prevHpY + x - prevHpX) : x;
    prevHpX = x;
    prevHpY = hpY;

    const lpY = useLpf ? prevLpY + lpfAlpha * (hpY - prevLpY) : hpY;
    prevLpY = lpY;
    rawSamples[i] = Math.max(-1.0, Math.min(1.0, lpY));
  }

  // 2. 20ms(320샘플) 프레임 단위 에너지(RMS) + 영교차율(ZCR) 분석
  const frameSize = 320;
  const numFrames = Math.ceil(sampleCount / frameSize);
  const frameRms = new Float32Array(numFrames);
  const frameZcr = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    const end = Math.min(sampleCount, start + frameSize);
    const len = Math.max(1, end - start);
    let sumSq = 0;
    let zeroCrossings = 0;
    let prevSample = rawSamples[start]!;

    for (let i = start; i < end; i++) {
      const v = rawSamples[i]!;
      sumSq += v * v;
      if (i > start && ((prevSample >= 0 && v < 0) || (prevSample < 0 && v >= 0))) {
        zeroCrossings++;
      }
      prevSample = v;
    }

    frameRms[f] = Math.sqrt(sumSq / len);
    frameZcr[f] = len > 1 ? zeroCrossings / (len - 1) : 0;
  }

  // 하위 15% 백분위수로 배경 노이즈 플로어, 상위 90% 백분위수로 대표 음성 에너지 추정
  const sortedRms = Array.from(frameRms).sort((a, b) => a - b);
  const noiseFloorRms =
    sortedRms[Math.floor((numFrames - 1) * 0.15)] ?? 0;
  const speechRefRms =
    sortedRms[Math.floor((numFrames - 1) * 0.9)] ?? 0;

  const activeFrameThreshold = Math.max(
    STT_CONFIG.vadMinFrameRms,
    noiseFloorRms * 1.8,
    Math.min(0.02, speechRefRms * STT_CONFIG.vadEnergyRatio),
  );

  const isSpeechFrame = (f: number): boolean => {
    const r = frameRms[f]!;
    const zcr = frameZcr[f]!;
    return (
      r >= activeFrameThreshold ||
      (r >= activeFrameThreshold * 0.55 && zcr >= 0.14)
    );
  };

  let firstActiveFrame = 0;
  let lastActiveFrame = numFrames - 1;

  while (firstActiveFrame < numFrames && !isSpeechFrame(firstActiveFrame)) {
    firstActiveFrame++;
  }
  while (
    lastActiveFrame > firstActiveFrame &&
    !isSpeechFrame(lastActiveFrame)
  ) {
    lastActiveFrame--;
  }

  // 전체가 무음에 가까우면 즉시 반환
  if (firstActiveFrame >= numFrames) {
    return {
      samples: new Float32Array(0),
      rms: 0,
      peak: 0,
      durationSec: 0,
    };
  }

  // 앞쪽 8프레임(160ms), 뒤쪽 12프레임(240ms) 여유분 포함하여 초성/받침 보호
  const startFrame = Math.max(0, firstActiveFrame - 8);
  const endFrame = Math.min(numFrames - 1, lastActiveFrame + 12);
  const startSample = startFrame * frameSize;
  const endSample = Math.min(sampleCount, (endFrame + 1) * frameSize);
  const activeLength = Math.max(0, endSample - startSample);

  // 3. 적응형 소프트 노이즈 게이트 + 프리엠퍼시스 + RMS/Peak 측정
  const processed = new Float32Array(activeLength);
  const preCoeff = Math.max(0, Math.min(0.5, STT_CONFIG.preEmphasisCoeff));
  let smoothedGateGain = 1.0;
  let prevGated = 0;
  let sumSquares = 0;
  let peak = 0;

  for (let i = 0; i < activeLength; i++) {
    const absIdx = startSample + i;
    const f = Math.min(numFrames - 1, Math.floor(absIdx / frameSize));
    const targetGateGain =
      STT_CONFIG.noiseGateEnabled &&
      !isSpeechFrame(f) &&
      frameRms[f]! < noiseFloorRms * 1.6
        ? 0.3
        : 1.0;
    smoothedGateGain = smoothedGateGain * 0.92 + targetGateGain * 0.08;

    const gated = rawSamples[absIdx]! * smoothedGateGain;
    const preEmph = i === 0 ? gated : gated - preCoeff * prevGated;
    prevGated = gated;

    processed[i] = preEmph;
    const absV = Math.abs(preEmph);
    sumSquares += preEmph * preEmph;
    if (absV > peak) {
      peak = absV;
    }
  }

  const rms = activeLength > 0 ? Math.sqrt(sumSquares / activeLength) : 0;
  const durationSec = activeLength / SAMPLE_RATE;

  // 상위 98% 진폭 백분위수 기반 AGC로 단일 스파이크에 의한 증폭 저하 방지
  const sampleStep = Math.max(1, Math.floor(activeLength / 4096));
  const sampledAbs: number[] = [];
  for (let i = 0; i < activeLength; i += sampleStep) {
    sampledAbs.push(Math.abs(processed[i]!));
  }
  sampledAbs.sort((a, b) => a - b);
  const p98 =
    sampledAbs[Math.floor((sampledAbs.length - 1) * 0.98)] ?? peak;
  const refAmp = Math.max(p98, peak * 0.5);

  // 4. 자동 이득 제어(AGC) + Soft-Knee 리미터 + Whisper 최적 무음 패딩 (앞 120ms, 뒤 280ms)
  const gain =
    refAmp > 0.008
      ? Math.min(
          STT_CONFIG.agcMaxGain,
          Math.max(1.0, STT_CONFIG.agcTargetPeak / refAmp),
        )
      : 1.0;

  const leadPad = Math.floor(SAMPLE_RATE * 0.12);
  const trailPad = Math.floor(SAMPLE_RATE * 0.28);
  const paddedSamples = new Float32Array(leadPad + activeLength + trailPad);

  for (let i = 0; i < activeLength; i++) {
    const amplified = processed[i]! * gain;
    const absAmp = Math.abs(amplified);
    // 0.85 초과 구간을 tanh로 부드럽게 압축하여 클리핑 왜곡 방지
    const limited =
      absAmp > 0.85
        ? Math.sign(amplified) * (0.85 + 0.15 * Math.tanh((absAmp - 0.85) / 0.15))
        : amplified;
    paddedSamples[leadPad + i] = Math.max(-1.0, Math.min(1.0, limited));
  }

  return { samples: paddedSamples, rms, peak, durationSec };
};

/**
 * Float32Array(16kHz Mono) 오디오를 16-bit PCM WAV Buffer로 변환 (외부 STT API 전송용)
 */
const float32ToWavBuffer = (
  samples: Float32Array,
  sampleRate: number = SAMPLE_RATE,
): Buffer => {
  const dataByteLength = samples.length * 2;
  const wavBuffer = Buffer.allocUnsafe(44 + dataByteLength);

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataByteLength, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20); // PCM
  wavBuffer.writeUInt16LE(1, 22); // Mono
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * 2, 28);
  wavBuffer.writeUInt16LE(2, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataByteLength, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    wavBuffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return wavBuffer;
};

/**
 * Deepgram Nova-2 REST API를 이용한 초고정밀 음성 인식
 */
const transcribeWithDeepgram = async (
  samples: Float32Array,
): Promise<string> => {
  const wavBuffer = float32ToWavBuffer(samples);
  const params = new URLSearchParams({
    model: STT_CONFIG.deepgramModel,
    smart_format: "true",
    punctuate: "true",
  });
  const isoLang = resolveIsoLanguage(STT_CONFIG.language);
  if (isoLang) {
    params.set("language", isoLang);
  } else {
    params.set("detect_language", "true");
  }

  const res = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${STT_CONFIG.deepgramApiKey}`,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array(wavBuffer),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram API 오류 (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    results?: {
      channels?: Array<{
        alternatives?: Array<{ transcript?: string }>;
      }>;
    };
  };
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
};

/**
 * OpenAI / Groq 호환 Whisper large-v3 REST API를 이용한 음성 인식
 */
const transcribeWithOpenAiApi = async (
  samples: Float32Array,
): Promise<string> => {
  const wavBuffer = float32ToWavBuffer(samples);
  const baseUrl =
    STT_CONFIG.apiUrl ||
    (STT_CONFIG.provider === "groq"
      ? "https://api.groq.com/openai/v1"
      : "https://api.openai.com/v1");

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }),
    "speech.wav",
  );
  formData.append("model", STT_CONFIG.apiModel);

  const isoLang = resolveIsoLanguage(STT_CONFIG.language);
  if (isoLang) {
    formData.append("language", isoLang);
  }
  if (STT_CONFIG.initialPrompt) {
    formData.append("prompt", STT_CONFIG.initialPrompt);
  }

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STT_CONFIG.apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI/Groq STT API 오류 (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text || "";
};

/**
 * 로컬 Whisper ONNX 파이프라인 추론
 */
const transcribeWithLocalWhisper = async (
  samples: Float32Array,
  durationSec: number,
): Promise<string> => {
  const transcriber = await preloadWhisperModel();
  const whisperLang = resolveWhisperLanguage(STT_CONFIG.language);
  const asrOptions: Record<string, unknown> = {
    task: "transcribe",
    ...(whisperLang ? { language: whisperLang } : {}),
    // 20초 이상 긴 발화는 30초 슬라이딩 윈도우 청킹 활성화
    ...(durationSec > 20 ? { chunk_length_s: 30, stride_length_s: 5 } : {}),
    max_new_tokens: 160,
    num_beams: STT_CONFIG.numBeams,
    temperature: STT_CONFIG.temperature,
    repetition_penalty: 1.05,
    no_repeat_ngram_size: 4,
  };

  let result: { text: string } | { text: string }[];
  try {
    result = await (
      transcriber as unknown as (
        audio: Float32Array,
        options: Record<string, unknown>,
      ) => Promise<{ text: string } | { text: string }[]>
    )(samples, asrOptions);
  } catch (sttErr: any) {
    // 무음/잡음 등으로 인한 빈 토큰 디코딩 예외는 안전하게 무시
    if (sttErr?.message?.includes("token_ids")) {
      return "";
    }
    throw sttErr;
  }

  return Array.isArray(result)
    ? result.map((r) => r.text).join(" ")
    : result.text;
};

/**
 * 설정된 STT 공급자(Deepgram Nova-2 / OpenAI Whisper-large-v3 / 로컬 Whisper-large-v3-turbo)를 통해 음성 인식 실행
 * - 외부 API 실패 시 로컬 Whisper로 자동 폴백
 */
export const transcribeAudioSamples = async (
  samples: Float32Array,
  durationSec: number,
): Promise<string> => {
  const activeProvider = resolveActiveSttProvider();

  if (activeProvider === "deepgram") {
    try {
      return await transcribeWithDeepgram(samples);
    } catch (err) {
      console.warn(
        "[VoiceChat] Deepgram STT 호출 실패, 로컬 Whisper로 폴백합니다:",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (activeProvider === "openai") {
    try {
      return await transcribeWithOpenAiApi(samples);
    } catch (err) {
      console.warn(
        "[VoiceChat] 외부 Whisper API 호출 실패, 로컬 Whisper로 폴백합니다:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return await transcribeWithLocalWhisper(samples, durationSec);
};

/**
 * Whisper STT 한국어 오인식 후처리 (호칭 '설아' 및 프로젝트 도메인 용어 발음 교정)
 * - 음성 인식 모델이 문맥 없이 소리나는 대로 적은 호칭('서로야', '저라야', '바라야', '올아야' 등)과
 *   에이전트/기술 용어('에이지와이', '에스티티', '티티에스', '제시작' 등)를 자연스럽게 보정합니다.
 */
export const postProcessKoreanSttText = (rawText: string): string => {
  let text = rawText.trim();
  if (!text) return "";

  // 1. 문두의 설아 호칭 오인식 교정 ("서로야", "저라야", "바라야", "올아야", "수라야", "솔아야", "살아야", "성아야", "안녕 서라/저랑")
  text = text.replace(
    /^[.,!?~…"''"\s]*(?:설아야|서라야|설하야|소라야|사라야|서로야|저라야|바라야|바로야|올아야|수라야|솔아야|살아야|성아야|철아야|선아야|털아야)(?=[\s,!?~.]|$)/,
    "설아야",
  );
  text = text.replace(
    /^[.,!?~…"''"\s]*(?:서라|설하|소라|저라)(?=\s+(?:안녕|이리\s*온|들어와|통화|꺼져|나가|노래|음악|목소리|모델|대답|상태|프로세스|재시작|제시작|검색))/,
    "설아",
  );
  text = text.replace(
    /^(안녕[,.!?\s]*)(?:서라|설하|소라|사라|저라|저랑|서로)(?=[\s,!?~.]|$)/,
    "$1설아",
  );

  // 2. 프로젝트 전용 에이전트 및 기술 키워드 발음 교정
  text = text
    // agy (Antigravity CLI) 발음 변형 교정
    .replace(
      /(?:에이\s*지\s*와이|에이\s*지\s*아이|에이\s*자\s*이|A\.?\s*G\.?\s*Y\.?|A\.?\s*J\.?\s*I\.?|AZI|AJI)/gi,
      "agy",
    )
    .replace(
      /(?:의지|애지|아지|에지|엘지|LG)(?=(?:로|에서|한테|에게|\s*호출|\s*상태|\s*지금|\s*작업|\s*실행))/gi,
      "agy",
    )
    // STT / TTS 발음 변형 교정
    .replace(/(?:에스\s*티\s*티|에스\s*피\s*티|SPT|에티케이스)/gi, "STT")
    .replace(
      /(?:티\s*티\s*에스|디\s*티\s*에스|DTS)(?=\s*(?:목소리|보이스|음성|성능|끊기|속도|엔진|재생|설정|바꿔|개선)?)/gi,
      "TTS",
    )
    // 프로세스 재시작 발음 변형 교정
    .replace(/브로스에서\s*(?:되시작|제시작|재시작)/g, "프로세스 재시작")
    .replace(/프로세스\s*(?:되시작|제\s*시작|제시작)/g, "프로세스 재시작")
    // 자주 틀리는 동사/명령어 교정
    .replace(/기선\s*시켜\s*(?:봐|줘|가)/g, "개선시켜봐")
    .replace(/개선\s*시켜\s*가(?=[.!?~\s]*$)/g, "개선시켜봐")
    .replace(/틀어\s*져(?=[.!?~\s]*$)/g, "틀어줘");

  return text.replace(/\s+/g, " ").trim();
};

/**
 * Whisper 환각 문구 및 무의미한 기호/반복 패턴 필터링
 */
const isMeaningfulTranscription = (text: string): boolean => {
  const cleaned = text
    .replace(/\[.*?\]|\(.*?\)|♪|♬/g, "")
    .replace(/[.,!?~…"''"\s]/g, "")
    .toLowerCase();

  if (!cleaned || cleaned.length < 1) {
    return false;
  }

  if (WHISPER_HALLUCINATIONS.has(cleaned)) {
    return false;
  }

  // 유튜브/방송 자막 계열 전형적인 Whisper 환각 패턴 차단
  if (
    cleaned.includes("자막제공") ||
    cleaned.includes("시청해주셔서") ||
    cleaned.includes("구독과좋아요") ||
    cleaned.includes("좋아요와구독") ||
    cleaned.includes("알림설정") ||
    cleaned.includes("다음영상에서") ||
    cleaned.includes("영상에서만나요") ||
    cleaned.includes("mbc뉴스") ||
    cleaned.includes("kbs뉴스") ||
    cleaned.includes("sbs뉴스") ||
    /뉴스[가-힣]{2,4}입니다$/.test(cleaned)
  ) {
    return false;
  }

  // 동일 글자나 2~3글자 음절이 무의미하게 5회 이상 반복되는 루프 환각 차단 (예: "아아아아아", "네네네네네")
  if (/^(.{1,3})\1{4,}$/.test(cleaned)) {
    return false;
  }

  return true;
};

/**
 * TTS가 어색하게 읽지 않도록 텍스트 정리 (괄호 지문/부연설명, 자음 이모티콘, 마크다운 기호 등 제거)
 */
const cleanTextForTTS = (text: string): string => {
  // macOS NFD(자소 분리: ᄌ-ㅓ-ㄴ-ㅡ-ㄴ) 유니코드를 표준 NFC(완성형: 저는)로 정규화
  let cleaned = text
    .normalize("NFC")
    // 코드 블록 및 인라인 코드 기호 제거
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    // <think>...</think> 등 태그 블록 제거
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // **(지문)**, *(지문)* 등 마크다운으로 감싸진 괄호 지문 제거 (강조 텍스트의 내용은 보존)
    .replace(/\*\*\s*\([^)]*\)\s*\*\*/g, "")
    .replace(/\*\s*\([^)]*\)\s*\*/g, "");

  // 중첩 괄호를 포함해 소괄호(), 대괄호[], 중괄호{}, 전각 괄호（）【】 내부 텍스트 완전 제거
  let prev = "";
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned
      .replace(/\([^()]*\)/g, "")
      .replace(/（[^（）]*）/g, "")
      .replace(/\[[^[\]]*\]/g, "")
      .replace(/【[^【】]*】/g, "")
      .replace(/\{[^{}]*\}/g, "")
      .replace(/<[^<>]*>/g, "");
  }

  // 앞부분에 남은 orphaned 닫는 괄호/지문 기호 제거 (청크 분할 시 잔여 지문 방어)
  cleaned = cleaned.replace(/^[^([（【{]*[)\]）】}]/g, "");

  // 닫히지 않은 채로 남은 여는 괄호 이후 텍스트 및 잔여 괄호 기호 제거
  cleaned = cleaned
    .replace(/[([（【{][^)\]）】}]*$/g, "")
    .replace(/[()[\]（）【】{}<>]/g, "");

  return cleaned
    .replace(/(\*\*|\*|__|_|~~)/g, "")
    .replace(/ㅋ{2,}/g, " 하하 ")
    .replace(/ㅎ{2,}/g, " 헤헤 ")
    .replace(/[ㅠㅜ]{2,}/g, "")
    .replace(/[ㅋㅎㅠㅜ]/g, "")
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
};

export interface SynthesizedSpeechResource {
  streamOrPath: Readable | string;
  inputType: StreamType;
  tempFilePath?: string;
  cleanup?: () => void;
}

export type EmotionType =
  | "happy"
  | "sad"
  | "angry"
  | "calm"
  | "whisper"
  | "playful"
  | "neutral";

export interface EmotionProfile {
  type: EmotionType;
  filter?: string;
  speedMultiplier: number;
}

/**
 * 발화 텍스트의 감정 태그([기쁨], [슬픔] 등) 또는 어휘 문맥을 분석하여 오디오 DSP 필터 산출
 */
export const detectEmotionProfile = (text: string): EmotionProfile => {
  const normalized = text.toLowerCase();

  // 1. 명시적 감정 태그 검사
  if (/\[(?:기쁨|신남|행복|happy|joy)\]/i.test(normalized)) {
    return {
      type: "happy",
      filter:
        "asetrate=44100*1.08,atempo=1/1.08*1.05,equalizer=f=3800:t=q:w=1:g=2.5",
      speedMultiplier: 1.05,
    };
  }
  if (/\[(?:슬픔|우울|눈물|sad|sorrow)\]/i.test(normalized)) {
    return {
      type: "sad",
      filter:
        "asetrate=44100*0.93,atempo=1/0.93*0.94,equalizer=f=250:t=q:w=1:g=2,lowpass=f=4500",
      speedMultiplier: 0.94,
    };
  }
  if (/\[(?:화남|새침|흥|angry|tsundere)\]/i.test(normalized)) {
    return {
      type: "angry",
      filter:
        "asetrate=44100*1.07,atempo=1/1.07*1.10,equalizer=f=3200:t=q:w=1:g=2",
      speedMultiplier: 1.1,
    };
  }
  if (/\[(?:속삭임|비밀|whisper)\]/i.test(normalized)) {
    return {
      type: "whisper",
      filter: "lowpass=f=4000,volume=1.25,atempo=0.96",
      speedMultiplier: 0.96,
    };
  }
  if (/\[(?:차분|진지|calm)\]/i.test(normalized)) {
    return {
      type: "calm",
      filter: "asetrate=44100*0.96,atempo=1/0.96,equalizer=f=300:t=q:w=1:g=2",
      speedMultiplier: 0.98,
    };
  }
  if (/\[(?:장난|애교|귀여움|playful)\]/i.test(normalized)) {
    return {
      type: "playful",
      filter:
        "asetrate=44100*1.12,atempo=1/1.12*1.06,equalizer=f=4000:t=q:w=1:g=3",
      speedMultiplier: 1.06,
    };
  }

  // 2. 어휘 및 기호 기반 자연어 감정 추론
  if (
    /(?:헤헤|히히|꺄아|좋아|최고|축하|신나|대박|고마워|사랑해)/.test(normalized)
  ) {
    return {
      type: "happy",
      filter:
        "asetrate=44100*1.06,atempo=1/1.06*1.04,equalizer=f=3800:t=q:w=1:g=2",
      speedMultiplier: 1.04,
    };
  }
  if (/(?:ㅠㅠ|ㅜㅜ|슬퍼|속상|힘들|아쉬워|미안|아파)/.test(normalized)) {
    return {
      type: "sad",
      filter: "asetrate=44100*0.94,atempo=1/0.94*0.95,lowpass=f=4800",
      speedMultiplier: 0.95,
    };
  }
  if (/(?:흥|바보야|어이없어|딱히|착각하지\s*마|뭐래)/.test(normalized)) {
    return {
      type: "angry",
      filter: "asetrate=44100*1.06,atempo=1/1.06*1.08",
      speedMultiplier: 1.08,
    };
  }

  return { type: "neutral", speedMultiplier: 1.0 };
};

/**
 * 단일 문장을 TTS 오디오 리소스로 합성
 * - 1순위(기본): 로컬 한국어 전용 신경망 MeloTTS-Korean (44.1kHz 16-bit WAV 인메모리 스트림 + 감정 DSP 필터)
 * - 2순위(폴백/Edge 프리셋): Microsoft Edge 신경망 TTS (96kbps MP3)
 * - 3순위(오프라인 폴백): macOS 내장 `say` (Yuna)
 */
export const synthesizeSpeechResource = async (
  rawText: string,
): Promise<SynthesizedSpeechResource | null> => {
  const emotion = detectEmotionProfile(rawText);
  const speakableText = cleanTextForTTS(rawText);
  if (!speakableText) {
    return null;
  }

  const preset = getCurrentVoicePreset();

  // -1차: Qwen3-TTS MLX 신경망 엔진 (Apple Silicon Metal 가속)
  if (preset.engine === "qwen") {
    try {
      const isAvailable = await isQwenTtsAvailable();
      if (!isAvailable) {
        console.warn(
          `[VoiceChat] Qwen3-TTS 서버(${CONFIG.QWEN_TTS_API_URL})가 응답하지 않아 CosyVoice/MeloTTS로 폴백합니다.`,
        );
        // CosyVoice 프롬프트가 설정된 프리셋(케이, 묘야 등)인 경우 CosyVoice 서버 가용 여부 확인 후 CosyVoice로 시도
        if (
          (preset.cosyPromptWav || preset.id === "kei") &&
          (await isCosyVoiceAvailable())
        ) {
          const cosyResult = await synthesizeCosyVoiceSentence(speakableText, {
            speed: preset.cosySpeed ?? 1.0,
            mode: "3초 음성 복제",
            promptText: preset.cosyPromptText || CONFIG.COSYVOICE_PROMPT_TEXT,
            promptWavPath: preset.cosyPromptWav || CONFIG.COSYVOICE_PROMPT_WAV,
            instructText:
              preset.cosyInstructText !== undefined
                ? preset.cosyInstructText
                : CONFIG.COSYVOICE_INSTRUCT_TEXT,
          });
          if (cosyResult) {
            return {
              streamOrPath: cosyResult.stream,
              inputType: StreamType.Arbitrary,
            };
          }
        }
      } else {
        const qwenResult = await synthesizeQwenSentence(speakableText, {
          mode: preset.qwenMode || "clone",
          speaker: preset.qwenSpeaker || "Vivian",
          instruct: preset.qwenInstruct || "",
          refAudio: preset.qwenRefAudio,
          refText: preset.qwenRefText,
        });
        if (qwenResult) {
          return {
            streamOrPath: qwenResult.stream,
            inputType: StreamType.Arbitrary,
          };
        }
      }
    } catch (qwenError) {
      console.warn(
        "[VoiceChat] Qwen3-TTS 합성 실패, 폴백을 시도합니다:",
        qwenError,
      );
    }
  }

  // 0차: 로컬 CosyVoice 대규모 신경망 엔진 (상위 디렉터리 CosyVoice Gradio 5.x WebUI 연동)
  if (preset.engine === "cosyvoice") {
    try {
      const isAvailable = await isCosyVoiceAvailable();
      if (!isAvailable) {
        console.warn(
          `[VoiceChat] CosyVoice 서버(${CONFIG.COSYVOICE_API_URL})가 응답하지 않아 MeloTTS로 폴백합니다.`,
        );
      } else {
        const cosyResult = await synthesizeCosyVoiceSentence(speakableText, {
          speed: preset.cosySpeed ?? 1.0,
          mode: preset.cosyMode || CONFIG.COSYVOICE_MODE,
          promptText: preset.cosyPromptText || CONFIG.COSYVOICE_PROMPT_TEXT,
          promptWavPath: preset.cosyPromptWav || CONFIG.COSYVOICE_PROMPT_WAV,
          instructText:
            preset.cosyInstructText !== undefined
              ? preset.cosyInstructText
              : CONFIG.COSYVOICE_INSTRUCT_TEXT,
        });
        if (cosyResult) {
          return {
            streamOrPath: cosyResult.stream,
            inputType: StreamType.Arbitrary,
          };
        }
      }
    } catch (cosyError) {
      console.warn(
        "[VoiceChat] CosyVoice 합성 실패, MeloTTS로 폴백합니다:",
        cosyError,
      );
    }
  }

  // 1차: 로컬 MeloTTS-Korean 엔진 (한국어 억양/장단음 최적화 + 실시간 감정 필터링)
  if (
    preset.engine === "melotts" ||
    preset.engine === "cosyvoice" ||
    preset.engine === "qwen"
  ) {
    try {
      const activeFilter = emotion.filter || preset.meloFilter;
      const baseSpeed = preset.meloSpeed ?? 1.0;
      const effectiveSpeed =
        Math.round(baseSpeed * emotion.speedMultiplier * 100) / 100;

      const meloResult = await synthesizeMeloSentence(speakableText, {
        speed: effectiveSpeed,
        ...(activeFilter ? { filter: activeFilter } : {}),
        ...(preset.meloNoiseScale !== undefined
          ? { noiseScale: preset.meloNoiseScale }
          : {}),
        ...(preset.meloNoiseScaleW !== undefined
          ? { noiseScaleW: preset.meloNoiseScaleW }
          : {}),
        ...(preset.meloSdpRatio !== undefined
          ? { sdpRatio: preset.meloSdpRatio }
          : {}),
      });
      if (meloResult) {
        return {
          streamOrPath: meloResult.stream,
          inputType: StreamType.Arbitrary,
        };
      }
    } catch (meloError) {
      console.warn(
        "[VoiceChat] MeloTTS-Korean 합성 실패, Edge TTS로 폴백합니다:",
        meloError,
      );
    }
  }

  // 2차: Microsoft Edge 신경망 TTS (고음질 96kbps MP3 -> FFmpeg 48kHz Stereo 리샘플링)
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      preset.voiceName,
      OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
      { voiceLocale: preset.voiceLocale },
    );
    const { audioStream } = tts.toStream(speakableText, {
      rate: preset.rate,
      pitch: preset.pitch,
    });

    return {
      streamOrPath: audioStream,
      inputType: StreamType.Arbitrary,
      cleanup: () => {
        try {
          tts.close();
        } catch {
          // 소켓 종료 중 예외 무시
        }
      },
    };
  } catch (edgeError) {
    console.warn(
      "[VoiceChat] Edge TTS 합성 실패, macOS 내장 TTS(say)로 폴백합니다:",
      edgeError,
    );
  }

  // 3차 폴백: macOS 내장 `say` 명령어로 임시 오디오 파일 생성
  if (process.platform === "darwin") {
    const tempFile = path.join(
      os.tmpdir(),
      `seola-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`,
    );
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("say", ["-v", "Yuna", "-o", tempFile, speakableText]);
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`say exited with code ${code}`));
      });
    });

    return {
      streamOrPath: tempFile,
      inputType: StreamType.Arbitrary,
      tempFilePath: tempFile,
    };
  }

  return null;
};

/**
 * TTS 엔진별 특성에 맞춰 문장을 최적 길이 단위로 묶음(Chunking)
 * - CosyVoice3는 CausalConv1d 커널 크기(4) 제약으로 인해 너무 짧은 문장에서 에러가 발생하므로 20자 이상으로 자연스럽게 결합
 */
export const groupSentencesForTTS = (
  sentences: string[],
  minLength = 20,
): string[] => {
  const result: string[] = [];
  let buffer = "";

  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;

    if (!buffer) {
      buffer = trimmed;
    } else if (buffer.length < minLength) {
      buffer = `${buffer} ${trimmed}`;
    } else {
      result.push(buffer);
      buffer = trimmed;
    }
  }

  if (buffer) {
    if (buffer.length < minLength && result.length > 0) {
      result[result.length - 1] = `${result[result.length - 1]} ${buffer}`;
    } else {
      result.push(buffer);
    }
  }

  return result;
};

// 길드별 TTS 재생 직렬화 락 및 음악 일시정지 상태 추적
const guildTtsLocks = new Map<string, Promise<void>>();
const ttsPausedMusicGuilds = new Set<string>();

/**
 * TTS 발화 시작 전 길드별 재생 락을 획득하고, 음악이 재생 중이면 일시정지한 뒤 TTS 전용 플레이어로 전환합니다.
 */
const acquireGuildTtsPlayback = async (
  connection: VoiceConnection,
  musicPlayer: AudioPlayer,
  guildId: string,
): Promise<{ ttsPlayer: AudioPlayer; release: () => void }> => {
  const prevLock = guildTtsLocks.get(guildId) ?? Promise.resolve();
  let releaseLock!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  guildTtsLocks.set(guildId, currentLock);

  await prevLock;

  // 음악이 재생/버퍼링 중이면 리소스를 파괴하지 않고 일시정지하여 발화 종료 후 이어서 재생할 수 있도록 보존
  const hasActiveTrack = Boolean(getGuildCurrentTrack(guildId));
  const musicStatus = musicPlayer.state.status;
  if (
    hasActiveTrack &&
    (musicStatus === AudioPlayerStatus.Playing ||
      musicStatus === AudioPlayerStatus.Buffering)
  ) {
    try {
      musicPlayer.pause(true);
      ttsPausedMusicGuilds.add(guildId);
      console.log(
        `[VoiceChat] ⏸️ TTS 발화를 위해 음악 재생 일시정지 (길드: ${guildId})`,
      );
    } catch (err) {
      console.warn(`[VoiceChat] 음악 일시정지 실패 (길드: ${guildId}):`, err);
    }
  }

  setGuildPlaybackMode(guildId, "tts");
  const ttsPlayer = getGuildTtsAudioPlayer(guildId);
  connection.subscribe(ttsPlayer);

  return {
    ttsPlayer,
    release: () => {
      try {
        connection.subscribe(musicPlayer);
      } catch {}

      const wasMusicPausedByTts = ttsPausedMusicGuilds.delete(guildId);
      const stillHasTrack = Boolean(getGuildCurrentTrack(guildId));
      if (wasMusicPausedByTts && stillHasTrack) {
        const status = musicPlayer.state.status;
        if (
          status === AudioPlayerStatus.Paused ||
          status === AudioPlayerStatus.AutoPaused
        ) {
          try {
            musicPlayer.unpause();
            console.log(
              `[VoiceChat] ▶️ TTS 발화 종료 — 일시정지된 음악 재개 (길드: ${guildId})`,
            );
          } catch (err) {
            console.warn(`[VoiceChat] 음악 재개 실패 (길드: ${guildId}):`, err);
          }
        }
        setGuildPlaybackMode(guildId, "music");
      } else {
        const session = guildSessions.get(guildId);
        if (session && session.playbackMode === "tts") {
          session.playbackMode = stillHasTrack ? "music" : "idle";
        }
      }

      if (guildTtsLocks.get(guildId) === currentLock) {
        guildTtsLocks.delete(guildId);
      }
      releaseLock();
    },
  };
};

export interface TtsPipelineStats {
  totalMs: number;
  totalSynthMs: number;
  totalPlayMs: number;
  firstPlaybackAtMs: number | null;
  sentenceCount: number;
  presetId: string;
}

/**
 * 문장 단위 스트리밍 합성 및 순차 재생 파이프라인 생성
 * - 문장이 들어오는 즉시 백그라운드에서 MeloTTS-Korean 합성을 선행(Prefetch) 시작하고,
 *   첫 문장 합성이 완료되는 즉시 TTS 전용 AudioPlayer에서 재생을 시작하여 체감 지연시간을 최소화합니다.
 * - 음악 재생 중 발화가 시작되면 음악을 일시정지했다가 발화 종료 후 멈춘 지점부터 자동 재개합니다.
 */
export const createSentenceSpeechPipeline = (
  connection: VoiceConnection,
  player: AudioPlayer,
  guildId: string,
  options?: { maxSentences?: number; splitSentences?: boolean },
) => {
  const pipelineStartMs = Date.now();
  const isCosyVoicePreset = getCurrentVoicePreset().engine === "cosyvoice";
  const shouldSplit = options?.splitSentences ?? !isCosyVoicePreset;
  // 고부하 신경망 TTS(CosyVoice)의 병렬 폭주 및 소켓 타임아웃을 방지하기 위해 작업 함수 큐로 순차 처리
  const synthesisQueue: (() => Promise<SynthesizedSpeechResource | null>)[] =
    [];
  // CosyVoice 프리셋은 대화를 자르지 않고 전체 발화, 일반 스트리밍 엔진은 최대 3문장으로 제한
  const maxSentences = shouldSplit
    ? (options?.maxSentences ?? 3)
    : Number.POSITIVE_INFINITY;
  let enqueuedSentenceCount = 0;
  let synthesizedCount = 0;
  let totalSynthMs = 0;
  let totalPlayMs = 0;
  let firstPlaybackAtMs: number | null = null;
  let isFinished = false;
  let wakeConsumer: (() => void) | null = null;
  let ttsPlaybackHandle: {
    ttsPlayer: AudioPlayer;
    release: () => void;
  } | null = null;

  const notifyQueueUpdated = () => {
    if (wakeConsumer) {
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake();
    }
  };

  const consumerPromise = (async () => {
    try {
      while (true) {
        if (synthesisQueue.length === 0) {
          if (isFinished) break;
          await new Promise<void>((resolve) => {
            wakeConsumer = resolve;
          });
          continue;
        }

        const nextSynthTask = synthesisQueue.shift()!;
        // 순차적으로 다음 문장을 합성하여 서버 부하 및 소켓 드랍 방지
        const synthStartMs = Date.now();
        const ttsResult = await nextSynthTask();
        totalSynthMs += Date.now() - synthStartMs;
        if (!ttsResult) continue;

        if (!ttsPlaybackHandle) {
          ttsPlaybackHandle = await acquireGuildTtsPlayback(
            connection,
            player,
            guildId,
          );
        }

        try {
          const resource = createAudioResource(ttsResult.streamOrPath, {
            inputType: ttsResult.inputType,
          });

          const playStartMs = Date.now();
          ttsPlaybackHandle.ttsPlayer.play(resource);
          await entersState(
            ttsPlaybackHandle.ttsPlayer,
            AudioPlayerStatus.Playing,
            5_000,
          );
          if (firstPlaybackAtMs === null) {
            firstPlaybackAtMs = Date.now();
          }
          await entersState(
            ttsPlaybackHandle.ttsPlayer,
            AudioPlayerStatus.Idle,
            60_000,
          );
          totalPlayMs += Date.now() - playStartMs;
          synthesizedCount++;
        } catch (error) {
          console.error(
            "[VoiceChat] 문장 단위 TTS 오디오 재생 중 오류:",
            error,
          );
        } finally {
          ttsResult.cleanup?.();
          if (ttsResult.tempFilePath && fs.existsSync(ttsResult.tempFilePath)) {
            fs.unlink(ttsResult.tempFilePath, () => {});
          }
        }
      }
    } finally {
      if (ttsPlaybackHandle) {
        ttsPlaybackHandle.release();
        ttsPlaybackHandle = null;
      } else {
        const session = guildSessions.get(guildId);
        if (session && session.playbackMode === "tts") {
          session.playbackMode = getGuildCurrentTrack(guildId)
            ? "music"
            : "idle";
        }
      }
    }
  })();

  const enqueueSentence = (rawSentence: string): void => {
    // 음성 대화에서는 대답을 짧게 유지하기 위해 최대 문장 수 제한 초과분은 스킵
    if (enqueuedSentenceCount >= maxSentences) {
      return;
    }

    const cleaned = cleanTextForTTS(rawSentence);
    if (!cleaned) return;

    // CosyVoice 등 분할 비활성화 모드에서는 대화를 자르지 않고 전체 텍스트를 한 번에 전송
    if (!shouldSplit) {
      enqueuedSentenceCount++;
      const synthTask = () =>
        synthesizeSpeechResource(cleaned).catch((err) => {
          console.error("[VoiceChat] 문장 합성 오류:", err);
          return null;
        });
      synthesisQueue.push(synthTask);
      notifyQueueUpdated();
      return;
    }

    // 한 번에 여러 문장이 들어온 경우에도 문장 단위로 쪼갠 뒤 너무 짧은 문장은 결합하여 합성 큐에 등록
    const rawSubSentences = splitTextIntoSentences(cleaned);
    const subSentences = groupSentencesForTTS(rawSubSentences, 20);

    for (const sentence of subSentences) {
      if (!sentence) continue;
      if (enqueuedSentenceCount >= maxSentences) {
        break;
      }
      enqueuedSentenceCount++;

      const synthTask = () =>
        synthesizeSpeechResource(sentence).catch((err) => {
          console.error("[VoiceChat] 문장 합성 오류:", err);
          return null;
        });
      synthesisQueue.push(synthTask);
    }
    notifyQueueUpdated();
  };

  const finish = async (): Promise<TtsPipelineStats> => {
    isFinished = true;
    notifyQueueUpdated();
    await consumerPromise;
    return {
      totalMs: Date.now() - pipelineStartMs,
      totalSynthMs,
      totalPlayMs,
      firstPlaybackAtMs,
      sentenceCount: synthesizedCount,
      presetId: getCurrentVoicePreset().id,
    };
  };

  return {
    enqueueSentence,
    finish,
  };
};

/**
 * 텍스트를 문장 단위로 분할하여 합성되는 즉시 디스코드 음성 채널에서 순차 재생
 */
export const speakInVoiceChannel = async (
  connection: VoiceConnection,
  player: AudioPlayer,
  guildId: string,
  text: string,
): Promise<TtsPipelineStats> => {
  const speechPipeline = createSentenceSpeechPipeline(
    connection,
    player,
    guildId,
  );
  speechPipeline.enqueueSentence(text);
  const stats = await speechPipeline.finish();
  if (stats.sentenceCount > 0) {
    console.log(
      `[TTS] 🗣️ 발화 완료 (${stats.presetId}, 합성 ${formatDurationMs(stats.totalSynthMs)}, 재생 ${formatDurationMs(stats.totalPlayMs)}, 총 ${formatDurationMs(stats.totalMs)})`,
    );
  }
  return stats;
};

/**
 * 음성 명령으로 음악 재생 요청인지 판별 (로컬 곡명 또는 유튜브 검색어 반환)
 */
const matchVoiceSongCommand = (text: string): string | null => {
  const isPlayAction = /(?:틀어\s*줘|재생해\s*줘|틀어|재생)\s*[.!?~]*$/i.test(
    text.trim(),
  );
  if (!isPlayAction) {
    return null;
  }

  const normalized = text
    .replace(
      /^(?:설아야?|서라야?|설하야?|소라야?|사라야?|서로야?|저라야?|바라야?|바로야?|올아야?|수라야?|솔아야?)\s*/,
      "",
    )
    .replace(/\s*(틀어\s*줘|재생해\s*줘|틀어|재생)\s*[.!?~]*$/, "")
    .trim();

  // "노래 틀어줘" / "음악 틀어줘" 처럼 곡명 없이 단독 요청인 경우 기본 대표곡 반환
  if (!normalized || normalized === "노래" || normalized === "음악") {
    return "아리아";
  }

  return normalized;
};

/**
 * 현재 음성 채널에 접속 중인 실제 사람(봇 제외) 인원수 계산
 */
const getHumanMemberCount = (voiceChannel: VoiceBasedChannel): number => {
  const freshChannel = voiceChannel.guild.channels.cache.get(voiceChannel.id);
  const targetChannel =
    freshChannel && freshChannel.isVoiceBased() ? freshChannel : voiceChannel;

  return targetChannel.members.filter((m) => !m.user.bot).size;
};

/**
 * 다인원 음성 채널에서 설아에게 직접 건넨 말/질문인지 판별
 * - Whisper STT에서 '설아'가 '서라', '설하', '소라', '사라', '서로야', '저라야', '바라야', '올아야' 등으로 오인식되는 경우까지 포괄
 */
const isAddressedToSeola = (text: string): boolean => {
  const normalized = text
    .replace(/\[.*?\]|\(.*?\)/g, "")
    .replace(/^[.,!?~…"''"\s]+/, "")
    .trim();

  // 문장 앞부분이나 문장 내에서 설아를 부르는 호칭 포함 여부 확인
  return /(?:^|[\s,!?~])(설아야?|서라야?|설하야?|소라야?|사라야?|서로야|저라야|바라야|바로야|올아야|수라야|솔아야)(?=[\s,!?~.]|$)/.test(
    normalized,
  );
};

/**
 * 발화 텍스트에서 앞뒤 설아 호출어 제거 ("설아야"는 제거, "설아"는 지시어로 유지)
 */
const stripSeolaWakeWord = (text: string): string => {
  const stripped = text
    .replace(
      /^[.,!?~…"''"\s]*(?:설아야|서라야|설하야|소라야|사라야|서로야|저라야|바라야|바로야|올아야|수라야|솔아야)[\s,!?~.]*/,
      "",
    )
    .replace(
      /[\s,!?~.]*(?:설아야|서라야|설하야|소라야|사라야|서로야|저라야|바라야|바로야|올아야|수라야|솔아야)[.,!?~…"''"\s]*$/,
      "",
    )
    .trim();

  return stripped || text.trim();
};

/**
 * 디스코드 음성 채널 실시간 대화(STT -> LLM -> TTS) 리스너 등록
 */
export const setupVoiceChatListener = (params: {
  client: Client;
  connection: VoiceConnection;
  voiceChannel: VoiceBasedChannel;
  textChannel: SendableChannels | null;
  player: AudioPlayer;
}): void => {
  const { client, connection, voiceChannel, textChannel, player } = params;
  const guildId = voiceChannel.guild.id;

  // 기존 세션 리스너가 있다면 리스너 이벤트만 안전하게 정리 (음성 연결 connection은 파괴하지 않고 유지)
  const existingSession = guildSessions.get(guildId);
  if (existingSession) {
    try {
      existingSession.cleanup();
    } catch (err) {
      console.warn(
        `[VoiceChat] 기존 세션 cleanup 중 오류 (길드: ${guildId}):`,
        err,
      );
    }
    guildSessions.delete(guildId);
  }

  // 백그라운드에서 Whisper STT 모델 사전 로드 (로컬 제공자인 경우에만 즉시 로드)
  if (resolveActiveSttProvider() === "local") {
    preloadWhisperModel().catch(() => {});
  } else {
    preloadMeloTTSModel().catch(() => {});
  }

  // 오디오 플레이어 음성 연결에 구독
  connection.subscribe(player);

  // DB에 영구 저장된 길드별 음악 볼륨 복원
  initGuildMusicVolume(guildId).catch(() => {});

  // 음성 채널 세션 상태를 DB에 저장 (재부팅/업데이트 시 자동 복원용)
  saveVoiceSessionToDb({
    guildId,
    guildName: voiceChannel.guild.name,
    voiceChannelId: voiceChannel.id,
    voiceChannelName: voiceChannel.name,
    textChannelId: textChannel?.id || null,
  }).catch(() => {});

  const session: GuildVoiceSession = {
    guildId,
    voiceChannel,
    textChannel,
    activeUsers: new Set<string>(),
    processingChain: Promise.resolve(),
    pendingSttCount: 0,
    voiceChatEnabled: true,
    playbackMode: "idle",
    cleanup: () => {},
  };

  // 음악 재생 및 대기열이 모두 종료되어 플레이어가 Idle로 돌아올 때 재생 모드만 초기화 (대기열/트랙 정리는 youtubeMusic.ts가 담당)
  const onPlayerIdle = () => {
    if (
      session.playbackMode === "music" &&
      !getGuildCurrentTrack(guildId) &&
      getGuildMusicQueue(guildId).length === 0
    ) {
      session.playbackMode = "idle";
    }
  };
  player.on(AudioPlayerStatus.Idle, onPlayerIdle);

  const onSpeakingStart = (userId: string) => {
    if (!session.voiceChatEnabled) return;
    if (session.activeUsers.has(userId)) return;
    if (session.playbackMode === "tts") return;

    const member = voiceChannel.guild.members.cache.get(userId);
    if (member?.user.bot || userId === client.user?.id) {
      return;
    }

    session.activeUsers.add(userId);

    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: STT_CONFIG.silenceDurationMs,
      },
    });

    const decoder = new OpusEncoder(SAMPLE_RATE, 1);
    const pcmChunks: Buffer[] = [];
    let totalBytes = 0;
    let lastPacketAt = 0;
    const maxBytes = SAMPLE_RATE * 2 * STT_CONFIG.maxSpeechSeconds;

    opusStream.on("data", (opusPacket: Buffer) => {
      if (totalBytes >= maxBytes) return;
      try {
        const now = Date.now();
        if (lastPacketAt > 0) {
          const gapMs = now - lastPacketAt;
          if (gapMs > 60) {
            const missingMs = Math.min(250, Math.max(0, gapMs - 20));
            const silenceSamples = Math.floor((SAMPLE_RATE * missingMs) / 1000);
            const silenceByteLen = silenceSamples * 2;
            if (silenceByteLen > 0 && totalBytes + silenceByteLen < maxBytes) {
              pcmChunks.push(Buffer.alloc(silenceByteLen));
              totalBytes += silenceByteLen;
            }
          }
        }
        lastPacketAt = now;

        const decodedPcm = decoder.decode(opusPacket);
        pcmChunks.push(decodedPcm);
        totalBytes += decodedPcm.length;
      } catch {
        // 손상된 패킷 무시
      }
    });

    opusStream.on("error", (err) => {
      console.error(
        `[VoiceChat] 유저(${userId}) 오디오 수신 스트림 오류:`,
        err,
      );
      session.activeUsers.delete(userId);
    });

    opusStream.once("end", () => {
      session.activeUsers.delete(userId);

      if (pcmChunks.length === 0) return;
      const fullPcm = Buffer.concat(pcmChunks);
      const { samples, rms, peak, durationSec } = pcm16ToFloat32(fullPcm);

      // 너무 짧은 잡음(클릭음, 숨소리)이거나 음량(RMS 및 Peak)이 너무 작으면 무시
      if (
        durationSec < STT_CONFIG.minSpeechSeconds ||
        rms < STT_CONFIG.minRmsThreshold ||
        peak < STT_CONFIG.minPeakThreshold
      ) {
        console.log(
          `[VoiceChat:Debug] 🔇 미세 소음 무시: duration=${durationSec.toFixed(2)}s, rms=${rms.toFixed(4)}, peak=${peak.toFixed(3)}`,
        );
        return;
      }

      // 다인원 채널 등에서 STT 작업이 이미 밀려 있으면 이벤트 루프/인터랙션 지연 방지를 위해 초과분 스킵
      if (session.pendingSttCount >= 2) {
        console.log(
          `[VoiceChat:Debug] ⏭️ STT 대기열 혼잡(대기 ${session.pendingSttCount}건)으로 발화 스킵`,
        );
        return;
      }

      session.pendingSttCount++;
      session.processingChain = session.processingChain
        .then(async () => {
          // 이벤트 루프에 대기 중인 Discord 인터랙션(deferReply 등)을 먼저 처리하도록 양보
          await new Promise<void>((resolve) => setImmediate(resolve));
          const sttStartMs = Date.now();
          const rawText = await transcribeAudioSamples(samples, durationSec);
          const sttElapsedMs = Date.now() - sttStartMs;
          const transcribedText = postProcessKoreanSttText(rawText);

          if (!isMeaningfulTranscription(transcribedText)) {
            console.log(
              `[VoiceChat:Debug] 🔇 무의미한 발화로 판단되어 무시: raw="${rawText}" -> "${transcribedText}"`,
            );
            return;
          }

          const humanMemberCount = getHumanMemberCount(voiceChannel);
          const isMultiPersonChannel = humanMemberCount > 1;
          const addressedToSeola = isAddressedToSeola(transcribedText);

          // 음악 재생 중에는 "설아야" 또는 "설아"로 부른 경우에만 반응
          if (session.playbackMode === "music" && !addressedToSeola) {
            return;
          }

          // 사람이 여러 명(2명 이상)일 때는 설아에게 직접 하는 말/질문(호출어 포함)에만 대답
          if (isMultiPersonChannel && !addressedToSeola) {
            console.log(
              `[VoiceChat] 👥 다인원 채널(${humanMemberCount}명) 일반 대화 무시: "${transcribedText}"`,
            );
            return;
          }

          const resolvedMember =
            member ||
            (await voiceChannel.guild.members.fetch(userId).catch(() => null));
          const userName =
            resolvedMember?.displayName ||
            resolvedMember?.user.username ||
            "사용자";

          console.log(
            `[STT] 🎙️ ${userName} (${durationSec.toFixed(1)}s, rms=${rms.toFixed(3)}, peak=${peak.toFixed(2)}, 소요=${formatDurationMs(sttElapsedMs)}, 인원=${humanMemberCount}명): ${transcribedText}`,
          );

          // 1. 음성 명령: 퇴장 ("설아야 꺼져", "설아야 나가")
          if (
            /^(?:설아야?|서라야?|설하야?|소라야?|사라야?)\s*(꺼져|나가|종료해)/.test(
              transcribedText,
            )
          ) {
            await recordVoiceTranscript({
              guildName: voiceChannel.guild.name,
              channelName: voiceChannel.name,
              userName,
              userText: transcribedText,
              botReply: "알겠어, 나중에 또 불러줘!",
              actionType: "leave",
              durationSec,
            });
            await appendConversationContext(
              userName,
              transcribedText,
              "알겠어, 나중에 또 불러줘!",
            );
            await speakInVoiceChannel(
              connection,
              player,
              guildId,
              "알겠어, 나중에 또 불러줘!",
            );
            player.stop();
            removeVoiceChatSession(guildId);
            notifyVoiceDashboardStatusChanged();
            return;
          }

          // 2. 음성 명령: 노래 정지 ("설아야 노래 꺼줘", "노래 멈춰")
          if (
            /^(?:(?:설아야?|서라야?|설하야?|소라야?|사라야?)\s*)?(?:노래|음악)\s*(?:꺼\s*줘|멈춰\s*줘|꺼|멈춰|중지)/.test(
              transcribedText,
            ) &&
            session.playbackMode === "music"
          ) {
            stopGuildMusic(guildId);
            player.stop();
            session.playbackMode = "idle";
            notifyVoiceDashboardStatusChanged();
            await recordVoiceTranscript({
              guildName: voiceChannel.guild.name,
              channelName: voiceChannel.name,
              userName,
              userText: transcribedText,
              botReply: "응, 노래 껐어!",
              actionType: "music_stop",
              durationSec,
            });
            await appendConversationContext(
              userName,
              transcribedText,
              "응, 노래 껐어!",
            );
            await speakInVoiceChannel(
              connection,
              player,
              guildId,
              "응, 노래 껐어!",
            );
            return;
          }

          // 2.5 음성 명령: 음악 볼륨 조절 ("설아야 소리 줄여줘", "볼륨 낮춰줘", "볼륨 20으로 해줘")
          const volumeMatch = transcribedText.match(
            /(?:(?:설아야?|서라야?|소라야?)\s*)?(?:음악\s*|노래\s*)?(?:볼륨|음량|소리)\s*(?:(\d{1,3})(?:으로|로)?\s*(?:해\s*줘|맞춰\s*줘|바꿔\s*줘)?|(줄여\s*줘|낮춰\s*줘|내려\s*줘)|(키워\s*줘|높여\s*줘|올려\s*줘)|(몇\s*이야|어때))/i,
          );
          if (volumeMatch) {
            const currentVol = getGuildMusicVolumePercent(guildId);
            let targetVol = currentVol;
            let replyText = "";

            if (volumeMatch[1]) {
              targetVol = parseInt(volumeMatch[1], 10);
              replyText = `음악 볼륨을 ${targetVol}%로 맞췄어!`;
            } else if (volumeMatch[2]) {
              targetVol = Math.max(0, currentVol - 15);
              replyText = `음악 소리 줄였어! 지금 ${targetVol}%야.`;
            } else if (volumeMatch[3]) {
              targetVol = Math.min(100, currentVol + 15);
              replyText = `음악 소리 키웠어! 지금 ${targetVol}%야.`;
            } else {
              replyText = `현재 음악 볼륨은 ${currentVol}%야!`;
            }

            if (targetVol !== currentVol) {
              await setGuildMusicVolume(guildId, targetVol);
              notifyVoiceDashboardStatusChanged();
            }

            await recordVoiceTranscript({
              guildName: voiceChannel.guild.name,
              channelName: voiceChannel.name,
              userName,
              userText: transcribedText,
              botReply: replyText,
              actionType: "chat",
              durationSec,
            });
            await appendConversationContext(
              userName,
              transcribedText,
              replyText,
            );
            await speakInVoiceChannel(connection, player, guildId, replyText);
            return;
          }

          // 2-2. 음성 명령: 목소리(TTS) 프리셋 조회/변경 ("설아야 목소리 케이로 바꿔줘")
          const voicePresetCmd = extractVoicePresetCommand(transcribedText);
          if (voicePresetCmd) {
            let replyText = "";
            if (voicePresetCmd.type === "list") {
              const current = getCurrentVoicePreset();
              replyText = `현재 내 목소리는 ${current.label}이고, 설아, 케이, 큐웬, 코지, 레바, 감규리, 다시는 만날 수 없는, 발랄, 차분, 속삭임, 멜로, 아바, 선희 중에서 고를 수 있어!`;
            } else if (voicePresetCmd.type === "current") {
              const current = getCurrentVoicePreset();
              replyText = `지금 적용된 내 목소리는 ${current.label}이야!`;
            } else {
              const updated = await setVoicePreset(voicePresetCmd.presetId);
              if (updated) {
                replyText = `목소리를 ${updated.label}로 바꿔봤어! 어때, 마음에 들어?`;
                notifyVoiceDashboardStatusChanged();
              }
            }

            if (replyText) {
              await recordVoiceTranscript({
                guildName: voiceChannel.guild.name,
                channelName: voiceChannel.name,
                userName,
                userText: transcribedText,
                botReply: replyText,
                actionType: "chat",
                durationSec,
              });
              await appendConversationContext(
                userName,
                transcribedText,
                replyText,
              );
              await speakInVoiceChannel(connection, player, guildId, replyText);
              return;
            }
          }

          // 2-3. 음성 명령: 다음 곡 스킵 ("다음 곡", "노래 넘겨", "스킵")
          if (
            /(?:다음\s*곡|노래\s*넘겨|음악\s*넘겨|스킵|건너뛰)/.test(
              transcribedText,
            )
          ) {
            const skipResult = await skipGuildMusic(guildId, player);
            if (skipResult.nextTrack) {
              session.playbackMode = "music";
              notifyVoiceDashboardStatusChanged();
              if (session.textChannel && session.textChannel.isSendable()) {
                const embed = createMusicTrackEmbed(
                  skipResult.nextTrack,
                  userName,
                  guildId,
                );
                session.textChannel
                  .send({
                    content: `⏭️ **${skipResult.skipped?.title || "이전 곡"}** 건너뛰고 다음 곡 재생!`,
                    embeds: [embed],
                  })
                  .catch(() => {});
              }
            } else {
              session.playbackMode = "idle";
              notifyVoiceDashboardStatusChanged();
              await speakInVoiceChannel(
                connection,
                player,
                guildId,
                skipResult.skipped
                  ? "다음 대기 중인 노래가 없어서 음악을 마칠게."
                  : "지금 재생 중인 노래가 없어.",
              );
            }
            return;
          }

          // 3. 음성 명령: 노래 재생 ("<곡명> 틀어줘" / "노래 틀어줘")
          const songQuery = matchVoiceSongCommand(transcribedText);
          if (songQuery) {
            session.playbackMode = "music";
            const playResult = await playMusicTrack({
              guildId,
              query: songQuery,
              player,
              connection,
              requesterName: userName,
              onQueueEnd: () => {
                session.playbackMode = "idle";
                notifyVoiceDashboardStatusChanged();
              },
            });

            if (playResult.success && playResult.track) {
              const replyText = playResult.queued
                ? `${playResult.track.title}을 대기열 ${playResult.queuePosition}번에 추가했어!`
                : playResult.track.isLocal
                  ? `${playResult.track.title} 틀어줄게!`
                  : `유튜브에서 ${playResult.track.title} 찾아 틀어줄게!`;

              if (session.textChannel && session.textChannel.isSendable()) {
                const embed = createMusicTrackEmbed(
                  playResult.track,
                  userName,
                  guildId,
                  {
                    ...(playResult.queued ? { queued: true } : {}),
                    ...(playResult.queuePosition !== undefined
                      ? { queuePosition: playResult.queuePosition }
                      : {}),
                    ...(playResult.playlistCount !== undefined
                      ? { playlistCount: playResult.playlistCount }
                      : {}),
                  },
                );
                session.textChannel.send({ embeds: [embed] }).catch(() => {});
                void sendOrUpdateMusicControlPanel(
                  guildId,
                  session.textChannel,
                  player,
                );
              }

              await recordVoiceTranscript({
                guildName: voiceChannel.guild.name,
                channelName: voiceChannel.name,
                userName,
                userText: transcribedText,
                botReply: replyText,
                actionType: "music_play",
                durationSec,
              });
              await appendConversationContext(
                userName,
                transcribedText,
                replyText,
              );
              notifyVoiceDashboardStatusChanged();
              return;
            } else {
              if (!getGuildCurrentTrack(guildId)) {
                session.playbackMode = "idle";
              }
              await speakInVoiceChannel(
                connection,
                player,
                guildId,
                `미안, ${songQuery} 노래를 찾지 못했어.`,
              );
              return;
            }
          }

          // 4. 일반 AI 실시간 대화 응답 생성 및 문장 단위 스트리밍 TTS 발화 (채팅 채널에는 전송하지 않고 대시보드에만 기록)
          const promptText = `${stripSeolaWakeWord(transcribedText)} /no_think`;
          console.log(
            `[VoiceChat:Debug] 🚀 AI 대답 생성 시작: prompt="${promptText}", user="${userName}"`,
          );

          const llmStartMs = Date.now();
          let firstSentenceAtMs: number | null = null;
          const useWholeReplyTts = getCurrentVoicePreset().engine === "cosyvoice";

          const speechPipeline = createSentenceSpeechPipeline(
            connection,
            player,
            guildId,
            useWholeReplyTts
              ? { splitSentences: false }
              : { maxSentences: 3 },
          );

          const aiReply = await generateAIResponse(userName, promptText, {
            isVoiceMode: true,
            isMultiPersonVoice: isMultiPersonChannel,
            humanMemberCount,
            channel: session.textChannel,
            ...(useWholeReplyTts
              ? {}
              : {
                  onSentence: (sentence) => {
                    if (firstSentenceAtMs === null) {
                      firstSentenceAtMs = Date.now();
                    }
                    console.log(
                      `[VoiceChat:Debug] 🔊 TTS 파이프라인 문장 투입: "${sentence}"`,
                    );
                    speechPipeline.enqueueSentence(sentence);
                  },
                }),
          });
          const llmElapsedMs = Date.now() - llmStartMs;

          if (!aiReply) {
            console.warn(
              `[VoiceChat:Warn] ⚠️ AI 응답 생성 결과가 비어있어(null 또는 빈 문자열) 발화를 건너뜁니다. (prompt="${promptText}")`,
            );
            await speechPipeline.finish();
            return;
          }

          if (useWholeReplyTts) {
            console.log(
              `[VoiceChat:Debug] 🔊 CosyVoice 전체 발화 투입 (자르지 않음): "${aiReply}"`,
            );
            speechPipeline.enqueueSentence(aiReply);
          }

          console.log(`[VoiceChat] 💬 설아 -> ${userName}: ${aiReply}`);

          await recordVoiceTranscript({
            guildName: voiceChannel.guild.name,
            channelName: voiceChannel.name,
            userName,
            userText: transcribedText,
            botReply: aiReply,
            actionType: "chat",
            durationSec,
          });

          // 음성 세션 타임스탬프 갱신 (지속 통화 중 봇 업데이트 시에도 복원 가능하도록 유지)
          saveVoiceSessionToDb({
            guildId,
            guildName: voiceChannel.guild.name,
            voiceChannelId: voiceChannel.id,
            voiceChannelName: voiceChannel.name,
            textChannelId: session.textChannel?.id || null,
          }).catch(() => {});

          const ttsStats = await speechPipeline.finish();
          const totalTurnMs = Date.now() - sttStartMs;
          const llmTtfaMs =
            firstSentenceAtMs !== null ? firstSentenceAtMs - llmStartMs : null;
          const perceivedLatencyMs =
            ttsStats.firstPlaybackAtMs !== null
              ? ttsStats.firstPlaybackAtMs - sttStartMs
              : null;
          const sttSummary = getSttConfigSummary();
          const llmModel = await getUserModel(userName).catch(() => "ollama");
          const cleanSttModel =
            sttSummary.model.split(" ")[0]?.split("/").pop() || sttSummary.model;

          logVoicePipelineTiming({
            userName,
            audioDurationSec: durationSec,
            transcribedText,
            sttMs: sttElapsedMs,
            sttLabel: `${sttSummary.provider}:${cleanSttModel}`,
            llmMs: llmElapsedMs,
            llmTtfaMs,
            llmModel,
            ttsTotalMs: ttsStats.totalMs,
            ttsSynthMs: ttsStats.totalSynthMs,
            ttsPlayMs: ttsStats.totalPlayMs,
            ttsSentenceCount: ttsStats.sentenceCount,
            ttsPreset: ttsStats.presetId,
            perceivedLatencyMs,
            totalTurnMs,
          });
        })
        .catch((err) => {
          console.error("[VoiceChat] 음성 대화 처리 중 오류 발생:", err);
        })
        .finally(() => {
          session.pendingSttCount = Math.max(0, session.pendingSttCount - 1);
        });
    });
  };

  connection.receiver.speaking.on("start", onSpeakingStart);

  const onDestroyed = () => {
    const s = guildSessions.get(guildId);
    if (s) {
      try {
        s.cleanup();
      } catch {}
      guildSessions.delete(guildId);
    }
  };
  connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);

  session.cleanup = () => {
    connection.receiver.speaking.off("start", onSpeakingStart);
    player.off(AudioPlayerStatus.Idle, onPlayerIdle);
    connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
    session.activeUsers.clear();
  };

  guildSessions.set(guildId, session);
};
