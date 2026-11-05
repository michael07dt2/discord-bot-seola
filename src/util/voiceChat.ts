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
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type {
  Client,
  SendableChannels,
  VoiceBasedChannel,
} from "discord.js";
import { generateAIResponse } from "./helper.ts";
import { songMap } from "./songmap.ts";
import {
  recordVoiceTranscript,
  type ActiveVoiceSessionStatus,
} from "./dashboard.ts";

const { OpusEncoder } = opus;

// Whisper 로컬 STT 모델 (기본값: 한국어 인식 및 실시간 응답 속도의 균형이 좋은 whisper-base)
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || "onnx-community/whisper-base";

// Whisper 입력 샘플링 레이트 (16kHz Mono)
const SAMPLE_RATE = 16000;
// 최소/최대 발화 길이 (초) 및 최소 음량(RMS) 임계치
const MIN_SPEECH_SECONDS = 0.45;
const MAX_SPEECH_SECONDS = 30.0;
const MIN_RMS_THRESHOLD = 0.008;

// TTS 목소리 프리셋 정의
export interface VoicePreset {
  id: string;
  label: string;
  description: string;
  voiceName: string;
  voiceLocale: string;
  pitch: string;
  rate: string;
}

export const VOICE_PRESETS: Record<string, VoicePreset> = {
  ava: {
    id: "ava",
    label: "아바 (자연스러운 대화형 - 기본)",
    description: "가장 자연스럽고 부드러운 20대 여성 대화 톤 (Ava Multilingual)",
    voiceName: "en-US-AvaMultilingualNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  seola: {
    id: "seola",
    label: "설아 (밝고 경쾌한 톤)",
    description: "한국어 전용 음성에 밝은 톤을 더한 목소리 (SunHi 밝은 톤)",
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+10Hz",
    rate: "+5%",
  },
  sunhi: {
    id: "sunhi",
    label: "선희 (차분한 한국어 기본)",
    description: "가장 또렷하고 안정적인 한국어 여성 음성 (SunHi 기본)",
    voiceName: "ko-KR-SunHiNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  emma: {
    id: "emma",
    label: "엠마 (차분하고 따뜻한 톤)",
    description: "차분하고 나긋나긋한 여성 대화 톤 (Emma Multilingual)",
    voiceName: "en-US-EmmaMultilingualNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  seraphina: {
    id: "seraphina",
    label: "세라피나 (맑고 또렷한 톤)",
    description: "맑고 깨끗한 음색의 다국어 여성 음성 (Seraphina Multilingual)",
    voiceName: "de-DE-SeraphinaMultilingualNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
  vivienne: {
    id: "vivienne",
    label: "비비안 (부드러운 저음 톤)",
    description: "차분하고 성숙한 분위기의 다국어 여성 음성 (Vivienne Multilingual)",
    voiceName: "fr-FR-VivienneMultilingualNeural",
    voiceLocale: "ko-KR",
    pitch: "+0Hz",
    rate: "+0%",
  },
};

// 현재 선택된 목소리 프리셋 (기본값: 가장 자연스러운 대화형인 ava)
let currentVoicePresetKey: string =
  process.env.TTS_PRESET && VOICE_PRESETS[process.env.TTS_PRESET]
    ? process.env.TTS_PRESET
    : "ava";

export const getCurrentVoicePreset = (): VoicePreset => {
  return VOICE_PRESETS[currentVoicePresetKey] ?? VOICE_PRESETS["ava"]!;
};

export const setVoicePreset = (input: string): VoicePreset | null => {
  const key = input.trim().toLowerCase();
  const aliasMap: Record<string, string> = {
    아바: "ava",
    ava: "ava",
    기본: "ava",
    설아: "seola",
    seola: "seola",
    선희: "sunhi",
    sunhi: "sunhi",
    엠마: "emma",
    emma: "emma",
    세라피나: "seraphina",
    seraphina: "seraphina",
    비비안: "vivienne",
    vivienne: "vivienne",
  };

  const resolvedKey = aliasMap[key] || (VOICE_PRESETS[key] ? key : undefined);
  if (!resolvedKey || !VOICE_PRESETS[resolvedKey]) {
    return null;
  }

  currentVoicePresetKey = resolvedKey;
  return VOICE_PRESETS[resolvedKey]!;
};

// 무음/잡음 구간에서 Whisper가 흔히 생성하는 환각(Hallucination) 문구 필터
const WHISPER_HALLUCINATIONS = new Set([
  "자막 제공",
  "자막제공",
  "한글자막",
  "시청해주셔서 감사합니다",
  "시청해 주셔서 감사합니다",
  "구독과 좋아요",
  "감사합니다",
  "고맙습니다",
  "mbc뉴스",
  "kbs뉴스",
  "sbs뉴스",
  "뉴스",
  "딩동댕",
  "음",
  "아",
  "어",
  "으",
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
 * 로컬 Whisper STT 파이프라인 싱글톤 로드
 */
export const preloadWhisperModel =
  async (): Promise<AutomaticSpeechRecognitionPipeline> => {
    if (!transcriberPromise) {
      console.log(
        `[VoiceChat] 로컬 Whisper STT 모델 로드 중... (${WHISPER_MODEL})`,
      );
      transcriberPromise = (
        pipeline as unknown as (
          task: "automatic-speech-recognition",
          model: string,
          options: { dtype: "q8" | "fp32" },
        ) => Promise<AutomaticSpeechRecognitionPipeline>
      )("automatic-speech-recognition", WHISPER_MODEL, {
        dtype: "q8",
      })
        .then((instance) => {
          console.log(`[VoiceChat] Whisper STT 모델 준비 완료 (${WHISPER_MODEL})`);
          return instance;
        })
        .catch((err) => {
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
 * 길드 음성 대화 세션 해제
 */
export const removeVoiceChatSession = (guildId: string): void => {
  const session = guildSessions.get(guildId);
  if (session) {
    session.cleanup();
    guildSessions.delete(guildId);
  }
};

/**
 * 16-bit Signed Little-Endian PCM 버퍼를 정규화된 Float32Array(-1.0 ~ 1.0)로 변환하고 RMS 에너지를 계산
 */
const pcm16ToFloat32 = (
  pcmBuffer: Buffer,
): { samples: Float32Array; rms: number; durationSec: number } => {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const samples = new Float32Array(sampleCount);
  let sumSquares = 0;

  for (let i = 0; i < sampleCount; i++) {
    const int16 = pcmBuffer.readInt16LE(i * 2);
    const normalized = int16 / 32768.0;
    samples[i] = normalized;
    sumSquares += normalized * normalized;
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const durationSec = sampleCount / SAMPLE_RATE;

  return { samples, rms, durationSec };
};

/**
 * Whisper 환각 문구 및 무의미한 기호 필터링
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

  if (
    cleaned.includes("자막제공") ||
    cleaned.includes("시청해주셔서") ||
    cleaned.includes("구독과좋아요")
  ) {
    return false;
  }

  return true;
};

/**
 * TTS가 어색하게 읽지 않도록 텍스트 정리 (괄호 지문/부연설명, 자음 이모티콘, 마크다운 기호 등 제거)
 */
const cleanTextForTTS = (text: string): string => {
  let cleaned = text
    // 코드 블록 및 인라인 코드 기호 제거
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    // <think>...</think> 등 태그 블록 제거
    .replace(/<think>[\s\S]*?<\/think>/gi, "");

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

/**
 * Edge TTS를 이용해 텍스트를 고음질(96kbps MP3) 스트림으로 합성
 * - 기존 WEBM_24KHZ_16BIT_MONO_OPUS + StreamType.WebmOpus 조합은 Discord의 48kHz 2채널 규격과 맞지 않아 음질이 깨지는 문제가 있었음.
 * - AUDIO_24KHZ_96KBITRATE_MONO_MP3 + StreamType.Arbitrary를 사용하여 FFmpeg가 48kHz 2채널 Stereo Opus로 깨끗하게 리샘플링하도록 개선.
 */
export const synthesizeSpeechResource = async (
  rawText: string,
): Promise<{
  streamOrPath: Readable | string;
  inputType: StreamType;
  tempFilePath?: string;
  cleanup?: () => void;
} | null> => {
  const speakableText = cleanTextForTTS(rawText);
  if (!speakableText) {
    return null;
  }

  const preset = getCurrentVoicePreset();

  // 1차 시도: Microsoft Edge 신경망 TTS (고음질 96kbps MP3 -> FFmpeg 48kHz Stereo 리샘플링)
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

  // 2차 폴백: macOS 내장 `say` 명령어로 임시 오디오 파일 생성
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
 * 합성된 TTS 음성을 디스코드 음성 채널에서 재생하고 완료될 때까지 대기
 */
export const speakInVoiceChannel = async (
  connection: VoiceConnection,
  player: AudioPlayer,
  guildId: string,
  text: string,
): Promise<void> => {
  const ttsResult = await synthesizeSpeechResource(text);
  if (!ttsResult) return;

  setGuildPlaybackMode(guildId, "tts");

  try {
    const resource = createAudioResource(ttsResult.streamOrPath, {
      inputType: ttsResult.inputType,
    });

    player.play(resource);
    connection.subscribe(player);

    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(player, AudioPlayerStatus.Idle, 60_000);
  } catch (error) {
    console.error("[VoiceChat] TTS 오디오 재생 중 오류:", error);
  } finally {
    ttsResult.cleanup?.();
    if (ttsResult.tempFilePath && fs.existsSync(ttsResult.tempFilePath)) {
      fs.unlink(ttsResult.tempFilePath, () => {});
    }
    const session = guildSessions.get(guildId);
    if (session && session.playbackMode === "tts") {
      session.playbackMode = "idle";
    }
  }
};

/**
 * 음성 명령으로 음악 재생 요청인지 판별
 */
const matchVoiceSongCommand = (text: string): string | null => {
  const normalized = text
    .replace(/^(?:설아야?|서라야?|설하야?|소라야?|사라야?)\s*/, "")
    .replace(/\s*(틀어\s*줘|재생해\s*줘|틀어|재생)\s*[.!?~]*$/, "")
    .trim();

  if (!normalized || normalized === text.trim()) {
    return null;
  }

  if (songMap[normalized]) {
    return normalized;
  }

  const compactInput = normalized.replace(/\s+/g, "").toLowerCase();
  for (const key of Object.keys(songMap)) {
    if (key.replace(/\s+/g, "").toLowerCase() === compactInput) {
      return key;
    }
  }

  return null;
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
 * - Whisper STT에서 '설아'가 '서라', '설하', '소라', '사라' 등으로 오인식되는 경우까지 포괄
 */
const isAddressedToSeola = (text: string): boolean => {
  const normalized = text
    .replace(/\[.*?\]|\(.*?\)/g, "")
    .replace(/^[.,!?~…"''"\s]+/, "")
    .trim();

  // 문장 앞부분이나 문장 내에서 설아를 부르는 호칭 포함 여부 확인
  return /(?:^|[\s,!?~])(설아야?|서라야?|설하야?|소라야?|사라야?)(?=[\s,!?~.]|$)/.test(
    normalized,
  );
};

/**
 * 발화 텍스트에서 앞뒤 설아 호출어 제거
 */
const stripSeolaWakeWord = (text: string): string => {
  const stripped = text
    .replace(
      /^[.,!?~…"''"\s]*(?:설아야?|서라야?|설하야?|소라야?|사라야?)[\s,!?~.]*/,
      "",
    )
    .replace(
      /[\s,!?~.]*(?:설아야?|서라야?|설하야?|소라야?|사라야?)[.,!?~…"''"\s]*$/,
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

  // 기존 세션이 있으면 정리 후 재등록
  removeVoiceChatSession(guildId);

  // 백그라운드에서 Whisper 모델 사전 로드 시작
  preloadWhisperModel().catch(() => {});

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

  // 플레이어가 Idle로 돌아올 때 재생 모드 초기화
  const onPlayerIdle = () => {
    if (session.playbackMode !== "idle") {
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

    // 800ms 동안 침묵이 유지되면 한 문장 발화가 끝난 것으로 판단
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 800,
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
      const { samples, rms, durationSec } = pcm16ToFloat32(fullPcm);

      // 너무 짧은 잡음(클릭음, 숨소리)이거나 음량이 너무 작으면 무시
      if (durationSec < MIN_SPEECH_SECONDS || rms < MIN_RMS_THRESHOLD) {
        return;
      }

      session.processingChain = session.processingChain
        .then(async () => {
          const transcriber = await preloadWhisperModel();
          const result = await transcriber(samples, {
            language: "korean",
            task: "transcribe",
          });

          const rawText = Array.isArray(result)
            ? result.map((r) => r.text).join(" ")
            : result.text;
          const transcribedText = rawText.trim();

          if (!isMeaningfulTranscription(transcribedText)) {
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
            `[VoiceChat] 🎙️ ${userName} (${durationSec.toFixed(1)}s, rms=${rms.toFixed(3)}, 인원=${humanMemberCount}명): ${transcribedText}`,
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
            await speakInVoiceChannel(
              connection,
              player,
              guildId,
              "응, 노래 껐어!",
            );
            return;
          }

          // 3. 음성 명령: 노래 재생 ("<곡명> 틀어줘")
          const matchedSongKey = matchVoiceSongCommand(transcribedText);
          if (matchedSongKey) {
            const songFileName = songMap[matchedSongKey];
            if (songFileName) {
              const targetPath = path.resolve(
                process.cwd(),
                "src",
                "audio",
                songFileName,
              );
              if (fs.existsSync(targetPath)) {
                await recordVoiceTranscript({
                  guildName: voiceChannel.guild.name,
                  channelName: voiceChannel.name,
                  userName,
                  userText: transcribedText,
                  botReply: `${matchedSongKey} 틀어줄게!`,
                  actionType: "music_play",
                  durationSec,
                });
                const resource = createAudioResource(targetPath, {
                  inputType: StreamType.Arbitrary,
                });
                session.playbackMode = "music";
                player.play(resource);
                connection.subscribe(player);
                return;
              }
            }
          }

          // 4. 일반 AI 실시간 대화 응답 생성 및 TTS 발화 (채팅 채널에는 전송하지 않고 대시보드에만 기록)
          const promptText = stripSeolaWakeWord(transcribedText);
          const aiReply = await generateAIResponse(userName, promptText, {
            isVoiceMode: true,
            isMultiPersonVoice: isMultiPersonChannel,
            humanMemberCount,
            channel: session.textChannel,
          });

          if (!aiReply) return;

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

          await speakInVoiceChannel(connection, player, guildId, aiReply);
        })
        .catch((err) => {
          console.error("[VoiceChat] 음성 대화 처리 중 오류 발생:", err);
        });
    });
  };

  connection.receiver.speaking.on("start", onSpeakingStart);

  session.cleanup = () => {
    connection.receiver.speaking.off("start", onSpeakingStart);
    player.off(AudioPlayerStatus.Idle, onPlayerIdle);
    session.activeUsers.clear();
  };

  guildSessions.set(guildId, session);
};
