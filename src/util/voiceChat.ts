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
} from "@huggingface/transformers";
import CONFIG from "../config/index.ts";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type {
  Client,
  SendableChannels,
  VoiceBasedChannel,
} from "discord.js";
import {
  generateAIResponse,
  appendConversationContext,
  connectToVoiceChannel,
} from "./helper.ts";
import { songMap } from "./songmap.ts";
import {
  playMusicTrack,
  stopGuildMusic,
  createMusicTrackEmbed,
  getGuildMusicVolumePercent,
  setGuildMusicVolume,
  skipGuildMusic,
  getGuildCurrentTrack,
  getGuildMusicQueue,
} from "./youtubeMusic.ts";
import {
  getGuildAudioPlayer,
  destroyGuildAudioPlayer,
} from "./audioPlayer.ts";
import {
  getBotSetting,
  setBotSetting,
  getBotSettingsByPrefix,
  deleteBotSetting,
} from "./settings.ts";
import {
  recordVoiceTranscript,
  type ActiveVoiceSessionStatus,
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
import {
  synthesizeQwenSentence,
  isQwenTtsAvailable,
} from "./qwenTts.ts";

const { OpusEncoder } = opus;

// Whisper 로컬 STT 모델 (기본값: 한국어 음성 인식률이 대폭 향상된 whisper-small)
const WHISPER_MODEL = CONFIG.WHISPER_MODEL;
const FALLBACK_WHISPER_MODEL = "onnx-community/whisper-base";

// Whisper 입력 샘플링 레이트 (16kHz Mono)
const SAMPLE_RATE = 16000;
// 최소/최대 발화 길이 (초) 및 최소 음량(RMS)/피크 임계치
const MIN_SPEECH_SECONDS = 0.35;
const MAX_SPEECH_SECONDS = 30.0;
const MIN_RMS_THRESHOLD = 0.005;
const MIN_PEAK_THRESHOLD = 0.02;

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
    description: "차분하고 쿨하면서도 앙칼진 블루아카이브 케이의 신경망 복제 보이스 (Qwen3-TTS / CosyVoice)",
    engine: "qwen",
    qwenMode: "clone",
    qwenRefAudio: resolveAssetPath("/Users/micha/Projects/personal_projects/qwen3-tts-mlx/samples/youtube_kei.wav"),
    qwenRefText: "에이! 진짜 그렇게 착한 애 취급하지 말라구요! 그쵸! 그렇게까지 애 아니니까요! 무섭겠다... 선생님 지금 웃었죠? 똑똑히 봤어요! 두고 봐요! 언젠간 그 몸에 뼈저리게 새겨줄테니까!",
    qwenInstruct: "차갑고 감정이 절제된 어린 소녀의 목소리. 아리스보다 반 옥타브 낮고 차분한 톤으로, 억양의 높낮이 변화가 적고 기계처럼 또박또박 일정한 속도로 말한다.",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("/Users/micha/Projects/personal_projects/CosyVoice/asset/youtube_kei.wav"),
    cosyInstructText: "차갑고 감정이 절제된 어린 소녀의 목소리. 아리스보다 반 옥타브 낮고 차분한 톤으로, 억양의 높낮이 변화가 적고 기계처럼 또박또박 일정한 속도로 말한다.",
    voiceName: "kei-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  qwen: {
    id: "qwen",
    label: "큐웬 (Qwen3-TTS MLX 프리셋)",
    description: "Apple Silicon 최적화 Qwen3-TTS 0.6B CustomVoice 모델 (Vivian 성우)",
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
    cosyPromptWav: resolveAssetPath("/Users/micha/Projects/personal_projects/CosyVoice/asset/youtube_prompt.wav"),
    cosyPromptText: "확실히 요새 좀 옛날보단 그림에 대한 상상력이 줄어든 것 같아요.".normalize("NFC"),
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
    cosyPromptWav: resolveAssetPath("/Users/micha/Projects/personal_projects/CosyVoice/asset/youtube_prompt_307_318.wav"),
    cosyPromptText: "자 이렇게 오늘의 게임 마무리해보도록 하겠습니다. 어쩐지 뭐 얼마 안 한 거 같은데 여기 다 온 거 같지?".normalize("NFC"),
    voiceName: "gamgyuri-custom",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  myoya: {
    id: "myoya",
    label: "다시는 만날 수 없는 (Qwen3-TTS 신경망 복제)",
    description: "다시는 만날 수 없는 그 사람의 다정하고 나긋나긋한 신경망 복제 보이스 (Qwen3-TTS)",
    engine: "qwen",
    qwenMode: "clone",
    qwenRefAudio: resolveAssetPath("/Users/micha/Projects/personal_projects/qwen3-tts-mlx/samples/youtube_myoya.wav"),
    qwenRefText: "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize("NFC"),
    qwenInstruct: "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("/Users/micha/Projects/personal_projects/CosyVoice/asset/youtube_myoya.wav"),
    cosyPromptText: "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize("NFC"),
    cosyInstructText: "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    voiceName: "myoya-qwen",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  myoya_cosy: {
    id: "myoya_cosy",
    label: "다시는 만날 수 없는 (CosyVoice 음성 복제)",
    description: "다시는 만날 수 없는 그 사람의 다정하고 나긋나긋한 음성 복제 보이스 (CosyVoice)",
    engine: "cosyvoice",
    cosySpeed: 1.0,
    cosyMode: "3초 고속 복제",
    cosyPromptWav: resolveAssetPath("/Users/micha/Projects/personal_projects/CosyVoice/asset/youtube_myoya.wav"),
    cosyPromptText: "길드 이름을 동화공방으로 지은 배경이 혹시 있으실까요? 저게 원래요 완전 방송 초창기 때 제 블로그 이름이었어요. 약간 동화책 같은 그림을 그리는 작업실 같은 느낌으로 만든 거예요. 제가 원래 그림으로 방송을 시작했었단 말이죠. 근데 애니메이션 제작사가 있더라고요. 엄청 유명한.".normalize("NFC"),
    cosyInstructText: "A young woman with a bright, cute, and high-pitched voice, speaking cheerfully with lively intonation.",
    voiceName: "myoya-cosy",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  seola: {
    id: "seola",
    label: "설아 (MeloTTS 자연스러운 기본)",
    description:
      "설아의 시그니처 톤 - 밝고 또렷한 20대 여성 목소리 (기본값)",
    engine: "melotts",
    meloSpeed: 1.04,
    meloFilter: "asetrate=44100*1.04,atempo=1/1.04,equalizer=f=3500:t=q:w=1:g=2",
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
    meloFilter: "asetrate=44100*1.14,atempo=1/1.14,equalizer=f=4000:t=q:w=1:g=3",
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
    console.warn("[VoiceChat] DB 목소리 설정 복원 실패 (로컬 캐시 확인 중):", err);
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

export const setVoicePreset = async (
  input: string,
  options?: { persist?: boolean },
): Promise<VoicePreset | null> => {
  const key = input.trim().toLowerCase();
  const aliasMap: Record<string, string> = {
    설아: "seola",
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
    key: "kei",
    qwen: "qwen",
    큐웬: "qwen",
    qwen3: "qwen",
    reva: "reva",
    레바: "reva",
    gamgyuri: "gamgyuri",
    감규리: "gamgyuri",
    규리: "gamgyuri",
    gyuri: "gamgyuri",
    myoya: "myoya",
    묘야: "myoya",
    묘야큐웬: "myoya",
    "다시는 만날 수 없는": "myoya",
    "다시는만날수없는": "myoya",
    "다만없": "myoya",
    myoya_cosy: "myoya_cosy",
    myoyacosy: "myoya_cosy",
    묘야코지: "myoya_cosy",
    "다시는 만날 수 없는 코지": "myoya_cosy",
    "다시는만날수없는코지": "myoya_cosy",
    "다만없코지": "myoya_cosy",
  };

  const resolvedKey = aliasMap[key] || (VOICE_PRESETS[key] ? key : undefined);
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
      console.warn("[VoiceChat] 목소리 설정 DB 저장 실패 (로컬 캐시에는 보존됨):", err);
    }
  }

  return VOICE_PRESETS[resolvedKey]!;
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
  voiceChatEnabled: boolean;
  playbackMode: "idle" | "tts" | "music";
  cleanup: () => void;
}

const guildSessions = new Map<string, GuildVoiceSession>();

/**
 * 로컬 Whisper STT 및 MeloTTS-Korean 파이프라인 싱글톤 사전 로드
 * - 기본 모델(`onnx-community/whisper-small`) 로드 실패 시 `whisper-base`로 자동 폴백
 */
export const preloadWhisperModel =
  async (): Promise<AutomaticSpeechRecognitionPipeline> => {
    // MeloTTS-Korean 로컬 모델도 함께 워밍업
    preloadMeloTTSModel().catch(() => {});

    if (!transcriberPromise) {
      const loadAsr = (
        pipeline as unknown as (
          task: "automatic-speech-recognition",
          model: string,
          options: { dtype: "q8" | "fp32" },
        ) => Promise<AutomaticSpeechRecognitionPipeline>
      );

      console.log(
        `[VoiceChat] 로컬 Whisper STT 모델 로드 중... (${WHISPER_MODEL})`,
      );
      transcriberPromise = loadAsr(
        "automatic-speech-recognition",
        WHISPER_MODEL,
        { dtype: "q8" },
      )
        .then((instance) => {
          console.log(`[VoiceChat] Whisper STT 모델 준비 완료 (${WHISPER_MODEL})`);
          return instance;
        })
        .catch(async (err) => {
          if (WHISPER_MODEL !== FALLBACK_WHISPER_MODEL) {
            console.warn(
              `[VoiceChat] ${WHISPER_MODEL} 로드 실패, 폴백 모델(${FALLBACK_WHISPER_MODEL})로 재시도합니다:`,
              err,
            );
            try {
              const fallbackInstance = await loadAsr(
                "automatic-speech-recognition",
                FALLBACK_WHISPER_MODEL,
                { dtype: "q8" },
              );
              console.log(
                `[VoiceChat] Whisper STT 폴백 모델 준비 완료 (${FALLBACK_WHISPER_MODEL})`,
              );
              return fallbackInstance;
            } catch (fallbackErr) {
              transcriberPromise = null;
              console.error(
                "[VoiceChat] Whisper STT 폴백 모델 로드 실패:",
                fallbackErr,
              );
              throw fallbackErr;
            }
          }
          transcriberPromise = null;
          console.error("[VoiceChat] Whisper STT 모델 로드 실패:", err);
          throw err;
        });
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
      console.log(`[VoiceChat] 길드(${guildId}) 음성 채널 연결을 성공적으로 해제(퇴장)했습니다.`);
      return true;
    } catch (err) {
      console.error(`[VoiceChat] 길드(${guildId}) connection.destroy 실패:`, err);
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
export const clearVoiceSessionFromDb = async (guildId: string): Promise<void> => {
  try {
    await deleteBotSetting(`voice_session:${guildId}`);
  } catch (err) {
    console.warn(`[VoiceChat] 음성 세션 상태 삭제 실패 (길드: ${guildId}):`, err);
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
 * 16-bit Signed Little-Endian PCM 버퍼를 Whisper 입력에 최적화된 Float32Array(-1.0 ~ 1.0)로 전처리
 * - 1) DC 오프셋 제거 및 1차 하이패스 필터(HPF ~80Hz)로 마이크 험/저주파 진동 노이즈 제거
 * - 2) 프레임(20ms) 에너지 기반 앞뒤 무음 트리밍(Silence Trimming) 후 Whisper 인식 최적 여백(전면 80ms, 후면 240ms) 패딩
 * - 3) 자동 이득 제어(AGC / Peak Normalization)로 작은 목소리도 목표 피크(0.85, 최대 증폭 5.0x)까지 선명하게 보정
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

  const rawSamples = new Float32Array(sampleCount);

  // 1. Int16 -> Float32 변환 및 1차 하이패스 필터 (y[n] = alpha * (y[n-1] + x[n] - x[n-1]), alpha ≈ 0.969 @ 16kHz -> ~80Hz cutoff)
  const hpfAlpha = 0.969;
  let prevX = 0;
  let prevY = 0;

  for (let i = 0; i < sampleCount; i++) {
    const x = pcmBuffer.readInt16LE(i * 2) / 32768.0;
    const y = hpfAlpha * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    rawSamples[i] = Math.max(-1.0, Math.min(1.0, y));
  }

  // 2. 20ms(320샘플) 프레임 단위 에너지 분석으로 앞뒤 무음 구간 트리밍
  const frameSize = 320;
  const numFrames = Math.ceil(sampleCount / frameSize);
  const frameRms = new Float32Array(numFrames);
  let maxFrameRms = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    const end = Math.min(sampleCount, start + frameSize);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = rawSamples[i]!;
      sumSq += v * v;
    }
    const r = Math.sqrt(sumSq / Math.max(1, end - start));
    frameRms[f] = r;
    if (r > maxFrameRms) {
      maxFrameRms = r;
    }
  }

  // 동적 활성 발화 프레임 임계치 (배경 잡음 대비 실제 음성 시작/끝점 탐색)
  const activeFrameThreshold = Math.max(0.004, Math.min(0.025, maxFrameRms * 0.12));
  let firstActiveFrame = 0;
  let lastActiveFrame = numFrames - 1;

  while (
    firstActiveFrame < numFrames &&
    frameRms[firstActiveFrame]! < activeFrameThreshold
  ) {
    firstActiveFrame++;
  }
  while (
    lastActiveFrame > firstActiveFrame &&
    frameRms[lastActiveFrame]! < activeFrameThreshold
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

  // 앞쪽 3프레임(60ms), 뒤쪽 6프레임(120ms) 여유분 포함하여 슬라이스
  const startSample = Math.max(0, (firstActiveFrame - 3) * frameSize);
  const endSample = Math.min(sampleCount, (lastActiveFrame + 7) * frameSize);
  const activeLength = Math.max(0, endSample - startSample);

  // 트리밍된 실제 발화 구간의 RMS 및 Peak 측정
  let sumSquares = 0;
  let peak = 0;
  for (let i = startSample; i < endSample; i++) {
    const v = rawSamples[i]!;
    const absV = Math.abs(v);
    sumSquares += v * v;
    if (absV > peak) {
      peak = absV;
    }
  }

  const rms = activeLength > 0 ? Math.sqrt(sumSquares / activeLength) : 0;
  const durationSec = activeLength / SAMPLE_RATE;

  // 3. 자동 이득 제어 (AGC): 작은 마이크 입력도 Whisper가 또렷하게 인식하도록 피크 0.85 기준으로 증폭 (최대 5배 제한으로 배경 백색소음 과증폭 방지)
  const targetPeak = 0.85;
  const gain =
    peak > 0.01 ? Math.min(5.0, Math.max(1.0, targetPeak / peak)) : 1.0;

  // 4. Whisper 디코더가 첫 음절과 끝 받침을 놓치지 않도록 앞 80ms, 뒤 240ms 무음 패딩 추가
  const leadPad = Math.floor(SAMPLE_RATE * 0.08);
  const trailPad = Math.floor(SAMPLE_RATE * 0.24);
  const paddedSamples = new Float32Array(leadPad + activeLength + trailPad);

  for (let i = 0; i < activeLength; i++) {
    const amplified = rawSamples[startSample + i]! * gain;
    paddedSamples[leadPad + i] = Math.max(-1.0, Math.min(1.0, amplified));
  }

  return { samples: paddedSamples, rms, peak, durationSec };
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
    .replace(/(?:티\s*티\s*에스|디\s*티\s*에스|DTS)(?=\s*(?:목소리|보이스|음성|성능|끊기|속도|엔진|재생|설정|바꿔|개선)?)/gi, "TTS")
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
  let cleaned = text.normalize("NFC")
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
      filter: "asetrate=44100*1.08,atempo=1/1.08*1.05,equalizer=f=3800:t=q:w=1:g=2.5",
      speedMultiplier: 1.05,
    };
  }
  if (/\[(?:슬픔|우울|눈물|sad|sorrow)\]/i.test(normalized)) {
    return {
      type: "sad",
      filter: "asetrate=44100*0.93,atempo=1/0.93*0.94,equalizer=f=250:t=q:w=1:g=2,lowpass=f=4500",
      speedMultiplier: 0.94,
    };
  }
  if (/\[(?:화남|새침|흥|angry|tsundere)\]/i.test(normalized)) {
    return {
      type: "angry",
      filter: "asetrate=44100*1.07,atempo=1/1.07*1.10,equalizer=f=3200:t=q:w=1:g=2",
      speedMultiplier: 1.10,
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
      filter: "asetrate=44100*1.12,atempo=1/1.12*1.06,equalizer=f=4000:t=q:w=1:g=3",
      speedMultiplier: 1.06,
    };
  }

  // 2. 어휘 및 기호 기반 자연어 감정 추론
  if (/(?:헤헤|히히|꺄아|좋아|최고|축하|신나|대박|고마워|사랑해)/.test(normalized)) {
    return {
      type: "happy",
      filter: "asetrate=44100*1.06,atempo=1/1.06*1.04,equalizer=f=3800:t=q:w=1:g=2",
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
  if (preset.engine === "melotts" || preset.engine === "cosyvoice" || preset.engine === "qwen") {
    try {
      const activeFilter = emotion.filter || preset.meloFilter;
      const baseSpeed = preset.meloSpeed ?? 1.0;
      const effectiveSpeed = Math.round(baseSpeed * emotion.speedMultiplier * 100) / 100;

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

/**
 * 문장 단위 스트리밍 합성 및 순차 재생 파이프라인 생성
 * - 문장이 들어오는 즉시 백그라운드에서 MeloTTS-Korean 합성을 선행(Prefetch) 시작하고,
 *   첫 문장 합성이 완료되는 즉시 AudioPlayer에서 재생을 시작하여 체감 지연시간을 최소화합니다.
 * - 앞 문장이 재생되는 동안 뒷 문장이 백그라운드에서 미리 합성되므로 문장 간 끊김 없이 이어집니다.
 */
export const createSentenceSpeechPipeline = (
  connection: VoiceConnection,
  player: AudioPlayer,
  guildId: string,
  options?: { maxSentences?: number },
) => {
  // 고부하 신경망 TTS(CosyVoice)의 병렬 폭주 및 소켓 타임아웃을 방지하기 위해 작업 함수 큐로 순차 처리
  const synthesisQueue: (() => Promise<SynthesizedSpeechResource | null>)[] = [];
  // 음성 통화 환경에 맞춰 발화 문장을 최대 3문장으로 제한 (과도하게 긴 대답 및 무한 루프 발화 방지)
  const maxSentences = options?.maxSentences ?? 3;
  let enqueuedSentenceCount = 0;
  let isFinished = false;
  let wakeConsumer: (() => void) | null = null;
  let hasStartedPlayback = false;

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
        const ttsResult = await nextSynthTask();
        if (!ttsResult) continue;

        if (!hasStartedPlayback) {
          hasStartedPlayback = true;
          setGuildPlaybackMode(guildId, "tts");
          connection.subscribe(player);
        }

        try {
          const resource = createAudioResource(ttsResult.streamOrPath, {
            inputType: ttsResult.inputType,
          });

          player.play(resource);
          await entersState(player, AudioPlayerStatus.Playing, 5_000);
          await entersState(player, AudioPlayerStatus.Idle, 60_000);
        } catch (error) {
          console.error("[VoiceChat] 문장 단위 TTS 오디오 재생 중 오류:", error);
        } finally {
          ttsResult.cleanup?.();
          if (
            ttsResult.tempFilePath &&
            fs.existsSync(ttsResult.tempFilePath)
          ) {
            fs.unlink(ttsResult.tempFilePath, () => {});
          }
        }
      }
    } finally {
      const session = guildSessions.get(guildId);
      if (session && session.playbackMode === "tts") {
        session.playbackMode = "idle";
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

  const finish = async (): Promise<void> => {
    isFinished = true;
    notifyQueueUpdated();
    await consumerPromise;
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
): Promise<void> => {
  const speechPipeline = createSentenceSpeechPipeline(
    connection,
    player,
    guildId,
  );
  speechPipeline.enqueueSentence(text);
  await speechPipeline.finish();
};

/**
 * 음성 명령으로 음악 재생 요청인지 판별 (로컬 곡명 또는 유튜브 검색어 반환)
 */
const matchVoiceSongCommand = (text: string): string | null => {
  const isPlayAction =
    /(?:틀어\s*줘|재생해\s*줘|틀어|재생)\s*[.!?~]*$/i.test(text.trim());
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
      console.warn(`[VoiceChat] 기존 세션 cleanup 중 오류 (길드: ${guildId}):`, err);
    }
    guildSessions.delete(guildId);
  }

  // 백그라운드에서 Whisper 모델 사전 로드 시작
  preloadWhisperModel().catch(() => {});

  // 오디오 플레이어 음성 연결에 구독
  connection.subscribe(player);

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
        duration: 750,
      },
    });

    const decoder = new OpusEncoder(SAMPLE_RATE, 1);
    const pcmChunks: Buffer[] = [];
    let totalBytes = 0;
    const maxBytes = SAMPLE_RATE * 2 * MAX_SPEECH_SECONDS;

    opusStream.on("data", (opusPacket: Buffer) => {
      if (totalBytes >= maxBytes) return;
      try {
        const decodedPcm = decoder.decode(opusPacket);
        pcmChunks.push(decodedPcm);
        totalBytes += decodedPcm.length;
      } catch {
        // 손상된 패킷 무시
      }
    });

    opusStream.on("error", (err) => {
      console.error(`[VoiceChat] 유저(${userId}) 오디오 수신 스트림 오류:`, err);
      session.activeUsers.delete(userId);
    });

    opusStream.once("end", () => {
      session.activeUsers.delete(userId);

      if (pcmChunks.length === 0) return;
      const fullPcm = Buffer.concat(pcmChunks);
      const { samples, rms, peak, durationSec } = pcm16ToFloat32(fullPcm);

      // 너무 짧은 잡음(클릭음, 숨소리)이거나 음량(RMS 및 Peak)이 너무 작으면 무시
      if (
        durationSec < MIN_SPEECH_SECONDS ||
        rms < MIN_RMS_THRESHOLD ||
        peak < MIN_PEAK_THRESHOLD
      ) {
        console.log(
          `[VoiceChat:Debug] 🔇 미세 소음 무시: duration=${durationSec.toFixed(2)}s, rms=${rms.toFixed(4)}, peak=${peak.toFixed(3)}`,
        );
        return;
      }

      session.processingChain = session.processingChain
        .then(async () => {
          const transcriber = await preloadWhisperModel();
          const sttStartMs = Date.now();
          let result: { text: string } | { text: string }[];
          try {
            result = await (
              transcriber as unknown as (
                audio: Float32Array,
                options: Record<string, unknown>,
              ) => Promise<{ text: string } | { text: string }[]>
            )(samples, {
              language: "korean",
              task: "transcribe",
              // 25초 이상 긴 발화일 때만 청크 슬라이딩 윈도우를 활성화하고, 일반 대화는 단일 패스로 빠르게 디코딩
              ...(durationSec > 25
                ? { chunk_length_s: 30, stride_length_s: 5 }
                : {}),
              max_new_tokens: 128,
              num_beams: 1,
              temperature: 0.0,
              repetition_penalty: 1.15,
              no_repeat_ngram_size: 3,
            });
          } catch (sttErr: any) {
            // 무음/잡음 등으로 인한 빈 토큰 디코딩 예외는 안전하게 무시
            if (sttErr?.message?.includes("token_ids")) {
              return;
            }
            throw sttErr;
          }
          const sttElapsedMs = Date.now() - sttStartMs;

          const rawText = Array.isArray(result)
            ? result.map((r) => r.text).join(" ")
            : result.text;
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
            `[VoiceChat] 🎙️ ${userName} (${durationSec.toFixed(1)}s, rms=${rms.toFixed(3)}, peak=${peak.toFixed(2)}, stt=${sttElapsedMs}ms, 인원=${humanMemberCount}명): ${transcribedText}`,
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
            connection.destroy();
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
            await appendConversationContext(userName, transcribedText, replyText);
            await speakInVoiceChannel(connection, player, guildId, replyText);
            return;
          }

          // 2-2. 음성 명령: 다음 곡 스킵 ("다음 곡", "노래 넘겨", "스킵")
          if (
            /(?:다음\s*곡|노래\s*넘겨|음악\s*넘겨|스킵|건너뛰)/.test(
              transcribedText,
            )
          ) {
            const skipResult = await skipGuildMusic(guildId, player);
            if (skipResult.nextTrack) {
              session.playbackMode = "music";
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
                  playResult.queued
                    ? {
                        queued: true,
                        ...(playResult.queuePosition !== undefined
                          ? { queuePosition: playResult.queuePosition }
                          : {}),
                      }
                    : undefined,
                );
                session.textChannel.send({ embeds: [embed] }).catch(() => {});
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

          const speechPipeline = createSentenceSpeechPipeline(
            connection,
            player,
            guildId,
            { maxSentences: 3 },
          );

          const aiReply = await generateAIResponse(userName, promptText, {
            isVoiceMode: true,
            isMultiPersonVoice: isMultiPersonChannel,
            humanMemberCount,
            channel: session.textChannel,
            onSentence: (sentence) => {
              console.log(`[VoiceChat:Debug] 🔊 TTS 파이프라인 문장 투입: "${sentence}"`);
              speechPipeline.enqueueSentence(sentence);
            },
          });

          if (!aiReply) {
            console.warn(
              `[VoiceChat:Warn] ⚠️ AI 응답 생성 결과가 비어있어(null 또는 빈 문자열) 발화를 건너뜁니다. (prompt="${promptText}")`,
            );
            await speechPipeline.finish();
            return;
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

          await speechPipeline.finish();
        })
        .catch((err) => {
          console.error("[VoiceChat] 음성 대화 처리 중 오류 발생:", err);
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
