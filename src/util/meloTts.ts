import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { PassThrough, type Readable } from "stream";
import ffmpegPath from "ffmpeg-static";
import ort from "onnxruntime-node";

const MODEL_DIR = path.resolve(process.cwd(), "models", "melotts-kr");
const G2P_DIR = path.join(MODEL_DIR, "g2pkk");
const ONNX_PATH = path.join(MODEL_DIR, "melotts_kr_fp32.onnx");
const CONFIG_PATH = path.join(MODEL_DIR, "melotts_kr_config.json");
const SYMBOLS_PATH = path.join(MODEL_DIR, "symbols.json");
const TABLE_CSV_PATH = path.join(G2P_DIR, "table.csv");
const IDIOMS_TXT_PATH = path.join(G2P_DIR, "idioms.txt");

const HF_BASE_URL =
  "https://huggingface.co/gnyong/melotts-kr-onnx/resolve/main";

// MeloTTS-Korean 기본 샘플링 레이트 (44.1kHz)
export const MELOTTS_SAMPLE_RATE = 44100;

export interface MeloSynthesizeOptions {
  speed?: number;
  noiseScale?: number;
  noiseScaleW?: number;
  sdpRatio?: number;
  filter?: string;
}

interface MeloConfigData {
  symbols: string[];
  data?: {
    sampling_rate?: number;
    add_blank?: boolean;
    spk2id?: Record<string, number>;
  };
}

interface SymbolsMetaData {
  language_id_map?: Record<string, number>;
  language_tone_start_map?: Record<string, number>;
}

interface G2PIdiomRule {
  pattern: string;
  replacement: string;
}

interface G2PTableRegexRule {
  regex: RegExp;
  replacement: string;
}

// ─── 한국어 숫자/특수문자/영문 발음 사전 ────────────────────────────────────────

const ETC_DICTIONARY: Record<string, string> = {
  "1+1": "원플러스원",
  "2+1": "투플러스원",
  "1+": "원플러스",
  "2+": "투플러스",
  "3+": "쓰리플러스",
  "4+": "포플러스",
  "2D": "투디",
  "3D": "쓰리디",
  "4D": "포디",
  "5G": "파이브지",
  "4G": "포지",
  "%": "퍼센트",
  "℃": "도씨",
  "&": "앤드",
  "@": "골뱅이",
};

const ENGLISH_DICTIONARY: Record<string, string> = {
  KOREA: "코리아",
  IDOL: "아이돌",
  IQ: "아이큐",
  UP: "업",
  DOWN: "다운",
  CCTV: "씨씨티비",
  AI: "에이아이",
  API: "에이피아이",
  CPU: "씨피유",
  GPU: "지피유",
  RAM: "램",
  ROM: "롬",
  USB: "유에스비",
  SSD: "에스에스디",
  HDD: "하드디스크",
  OS: "오에스",
  UI: "유아이",
  UX: "유엑스",
  URL: "유알엘",
  SNS: "에스엔에스",
  MBTI: "엠비티아이",
  OTT: "오티티",
  PC: "피씨",
  TV: "티비",
  IT: "아이티",
  ID: "아이디",
  VIP: "브이아이피",
  CEO: "씨이오",
  LLM: "엘엘엠",
  TTS: "티티에스",
  STT: "에스티티",
  GPT: "지피티",
  OK: "오케이",
  DJ: "디제이",
  MC: "엠씨",
  PD: "피디",
  CF: "씨에프",
  ost: "오에스티",
  OST: "오에스티",
  discord: "디스코드",
  seola: "설아",
  ollama: "올라마",
  whisper: "위스퍼",
  gemma: "젬마",
  qwen: "큐웬",
  llama: "라마",
  agy: "에이지와이",
  hermes: "헤르메스",
  git: "깃",
  github: "깃허브",
  node: "노드",
  typescript: "타입스크립트",
  javascript: "자바스크립트",
  python: "파이썬",
  docker: "도커",
  mac: "맥",
  macbook: "맥북",
  apple: "애플",
  google: "구글",
  youtube: "유튜브",
  netflix: "넷플릭스",
  instagram: "인스타그램",
  kakao: "카카오",
  naver: "네이버",
  hello: "헬로",
  hi: "하이",
  bye: "바이",
  test: "테스트",
  server: "서버",
  bot: "봇",
  model: "모델",
  voice: "보이스",
  chat: "챗",
  music: "뮤직",
  play: "플레이",
  stop: "스톱",
  start: "스타트",
  help: "헬프",
  status: "스테이터스",
  search: "서치",
};

const UPPER_CHAR_TO_KR: Record<string, string> = {
  A: "에이",
  B: "비",
  C: "씨",
  D: "디",
  E: "이",
  F: "에프",
  G: "지",
  H: "에이치",
  I: "아이",
  J: "제이",
  K: "케이",
  L: "엘",
  M: "엠",
  N: "엔",
  O: "오",
  P: "피",
  Q: "큐",
  R: "알",
  S: "에스",
  T: "티",
  U: "유",
  V: "브이",
  W: "더블유",
  X: "엑스",
  Y: "와이",
  Z: "제트",
};

// 고유어 수사와 결합하는 단위 의존명사
const BOUND_NOUNS = new Set([
  "군데",
  "권",
  "개",
  "그루",
  "닢",
  "대",
  "두",
  "마리",
  "모",
  "모금",
  "뭇",
  "발",
  "발자국",
  "방울",
  "번",
  "벌",
  "보람",
  "봉지",
  "분",
  "뼘",
  "살",
  "섬",
  "소큼",
  "송이",
  "수",
  "술",
  "시",
  "씨",
  "쌈",
  "움큼",
  "자루",
  "자욱",
  "잔",
  "장",
  "점",
  "죽",
  "줌",
  "짝",
  "채",
  "척",
  "첩",
  "축",
  "켤레",
  "코",
  "톨",
  "통",
  "포기",
  "푼",
  "명",
  "달",
  "병",
  "스푼",
]);

const SINO_DIGITS: Record<string, string> = {
  "0": "영",
  "1": "일",
  "2": "이",
  "3": "삼",
  "4": "사",
  "5": "오",
  "6": "육",
  "7": "칠",
  "8": "팔",
  "9": "구",
};

const SMALL_UNITS = ["", "십", "백", "천"];
const LARGE_UNITS = ["", "만", "억", "조", "경"];

const NATIVE_ONES_MODIFIER: Record<number, string> = {
  1: "한",
  2: "두",
  3: "세",
  4: "네",
  5: "다섯",
  6: "여섯",
  7: "일곱",
  8: "여덟",
  9: "아홉",
};

const NATIVE_TENS: Record<number, string> = {
  10: "열",
  20: "스물",
  30: "서른",
  40: "마흔",
  50: "쉰",
  60: "예순",
  70: "일흔",
  80: "여든",
  90: "아흔",
};

/**
 * 아라비아 숫자를 한자어 수사(일, 이, 삼... 십, 백, 천, 만)로 변환
 */
const numberToSinoKorean = (numStr: string): string => {
  const cleaned = numStr.replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return numStr;
  if (/^0+$/.test(cleaned)) return "영";

  if (cleaned.length > 16 || (cleaned.length > 1 && cleaned.startsWith("0"))) {
    return cleaned
      .split("")
      .map((d) => SINO_DIGITS[d] || "")
      .join("");
  }

  let result = "";
  const len = cleaned.length;
  let groupHasNonZero = false;

  for (let i = 0; i < len; i++) {
    const digit = cleaned[i]!;
    const pos = len - 1 - i;
    const smallIdx = pos % 4;
    const largeIdx = Math.floor(pos / 4);

    if (digit !== "0") {
      groupHasNonZero = true;
      const isOneBeforeUnit =
        digit === "1" &&
        (smallIdx > 0 || (smallIdx === 0 && largeIdx === 1 && len === 5));
      if (!isOneBeforeUnit) {
        result += SINO_DIGITS[digit] || "";
      }
      result += SMALL_UNITS[smallIdx] || "";
    }

    if (smallIdx === 0) {
      if (groupHasNonZero && largeIdx > 0) {
        result += LARGE_UNITS[largeIdx] || "";
      }
      groupHasNonZero = false;
    }
  }

  return result || "영";
};

/**
 * 단위 명사 앞의 1~99 숫자를 고유어 관형수사(한, 두, 세... 스무 등)로 변환
 */
const numberToNativeModifier = (n: number): string | null => {
  if (n <= 0 || n >= 100) return null;
  if (n === 20) return "스무";
  const tens = Math.floor(n / 10) * 10;
  const ones = n % 10;
  const tensStr = tens > 0 ? NATIVE_TENS[tens] || "" : "";
  const onesStr = ones > 0 ? NATIVE_ONES_MODIFIER[ones] || "" : "";
  return tensStr + onesStr;
};

/**
 * 텍스트 내 숫자 표현을 자연스러운 한국어 발음으로 정규화
 */
const normalizeKoreanNumbers = (text: string): string => {
  let out = text.replace(
    /(\d+)\.(\d+)/g,
    (_, intPart: string, fracPart: string) => {
      const intKr = numberToSinoKorean(intPart);
      const fracKr = fracPart
        .split("")
        .map((d) => SINO_DIGITS[d] || "")
        .join("");
      return `${intKr}점${fracKr}`;
    },
  );

  out = out.replace(
    /(\d{1,2})\s*([가-힣]+)/g,
    (fullMatch, numStr: string, followingWord: string) => {
      for (const noun of BOUND_NOUNS) {
        if (followingWord === noun || followingWord.startsWith(noun)) {
          if (
            noun === "분" &&
            !/^(께서|께|이|은|도|만|들)/.test(followingWord.slice(1))
          ) {
            return `${numberToSinoKorean(numStr)}${followingWord}`;
          }
          const n = parseInt(numStr, 10);
          const nativeKr = numberToNativeModifier(n);
          if (nativeKr) {
            return `${nativeKr}${followingWord}`;
          }
        }
      }
      return fullMatch;
    },
  );

  out = out.replace(/\d[\d,]*/g, (match) => numberToSinoKorean(match));
  return out;
};

/**
 * 영문 단어를 한글 발음으로 변환
 */
const normalizeEnglishToKorean = (text: string): string => {
  return text.replace(/[A-Za-z]+/g, (word) => {
    const exact = ENGLISH_DICTIONARY[word];
    if (exact) return exact;

    const lower = word.toLowerCase();
    const lowerMatch = ENGLISH_DICTIONARY[lower];
    if (lowerMatch) return lowerMatch;

    const upper = word.toUpperCase();
    const upperMatch = ENGLISH_DICTIONARY[upper];
    if (upperMatch) return upperMatch;

    return upper
      .split("")
      .map((ch) => UPPER_CHAR_TO_KR[ch] || "")
      .join("");
  });
};

// ─── G2PKK (한국어 음운 변동 규칙: g2pkk/special.py, table.csv, regular.py) ────

const COMPAT_TO_CHOSEONG: Record<string, string> = {
  ㄱ: "\u1100",
  ㄲ: "\u1101",
  ㄴ: "\u1102",
  ㄷ: "\u1103",
  ㄸ: "\u1104",
  ㄹ: "\u1105",
  ㅁ: "\u1106",
  ㅂ: "\u1107",
  ㅃ: "\u1108",
  ㅅ: "\u1109",
  ㅆ: "\u110A",
  ㅇ: "\u110B",
  ㅈ: "\u110C",
  ㅉ: "\u110D",
  ㅊ: "\u110E",
  ㅋ: "\u110F",
  ㅌ: "\u1110",
  ㅍ: "\u1111",
  ㅎ: "\u1112",
};

/**
 * 관형사형 'ㄹ' + 의존명사(것, 거, 수, 데, 줄, 바, 리, 지, 뿐) 경음화 선처리
 */
const applyRieulBoundNounTensification = (text: string): string => {
  return text
    .replace(/([가-힣]+)\s+(것|거)(?=[가-힣\s.!?…~]|$)/g, (m, prev: string, noun: string) => {
      if (prev.normalize("NFD").endsWith("ᆯ")) {
        return `${prev} ${noun === "것" ? "껏" : "꺼"}`;
      }
      return m;
    })
    .replace(/([가-힣]+)\s+수(?=[가-힣\s.!?…~]|$)/g, (m, prev: string) => {
      if (prev.normalize("NFD").endsWith("ᆯ")) {
        return `${prev} 쑤`;
      }
      return m;
    })
    .replace(/([가-힣]+)\s+데(?=[가-힣\s.!?…~]|$)/g, (m, prev: string) => {
      if (prev.normalize("NFD").endsWith("ᆯ")) {
        return `${prev} 떼`;
      }
      return m;
    })
    .replace(/([가-힣]+)\s+줄(?=[가-힣\s.!?…~]|$)/g, (m, prev: string) => {
      if (prev.normalize("NFD").endsWith("ᆯ")) {
        return `${prev} 쭐`;
      }
      return m;
    });
};

/**
 * g2pkk/special.py 음운 규칙 적용
 */
const applyG2PSpecialRules = (inp: string): string => {
  let out = inp;

  // 1. jyeo (5.1): ㅈ, ㅉ, ㅊ + ㅕ -> ㅓ
  out = out.replace(/([ᄌᄍᄎ])ᅧ/g, "$1ᅥ");

  // 2. consonant_ui (5.3): 자음 + ᅴ -> ᅵ
  out = out.replace(/([ᄀᄁᄂᄃᄄᄅᄆᄇᄈᄉᄊᄌᄍᄎᄏᄐᄑᄒ])ᅴ/g, "$1ᅵ");

  // 3. jamo (16): ㄷ, ㅈ, ㅊ, ㅋ, ㅌ, ㅍ, ㅎ 어말/모음 연음 예외
  out = out.replace(/([그])ᆮᄋ/g, "$1ᄉ");
  out = out.replace(/([으])[ᆽᆾᇀᇂ]ᄋ/g, "$1ᄉ");
  out = out.replace(/([으])[ᆿ]ᄋ/g, "$1ᄀ");
  out = out.replace(/([으])[ᇁ]ᄋ/g, "$1ᄇ");

  // 4. balb (10.1): '밟-' 및 '넓죽/넓둥' 예외
  out = out.replace(/(바)ᆲ($|[^ᄋᄒ])/g, "$1ᆸ$2");
  out = out.replace(/(너)ᆲ([ᄌᄍ]ᅮ|[ᄃᄄ]ᅮ)/g, "$1ᆸ$2");

  // 5. palatalize (17): 구개음화 (ㄷ, ㅌ + 이/히 -> 지/치)
  out = out.replace(/ᆮᄋ([ᅵᅧ])/g, "ᄌ$1");
  out = out.replace(/ᇀᄋ([ᅵᅧ])/g, "ᄎ$1");
  out = out.replace(/ᆴᄋ([ᅵᅧ])/g, "ᆯᄎ$1");
  out = out.replace(/ᆮᄒ([ᅵ])/g, "ᄎ$1");

  // 6. modifying_rieul (27): 관형사형 'ㄹ' 뒤 된소리되기
  const rieulPairs: [string, string][] = [
    ["ᆯ걸", "ᆯ껄"],
    ["ᆯ밖에", "ᆯ빠께"],
    ["ᆯ세라", "ᆯ쎄라"],
    ["ᆯ수록", "ᆯ쑤록"],
    ["ᆯ지라도", "ᆯ찌라도"],
    ["ᆯ지언정", "ᆯ찌언정"],
    ["ᆯ진대", "ᆯ찐대"],
  ];
  for (const [from, to] of rieulPairs) {
    out = out.replaceAll(from, to);
  }

  return out;
};

/**
 * g2pkk/regular.py 연음(Liaison) 및 ㅎ 탈락 규칙 적용
 */
const applyG2PLiaisonRules = (inp: string): string => {
  let out = inp;

  // link1 (13): 홑받침/쌍받침 연음
  const link1Pairs: [string, string][] = [
    ["ᆨᄋ", "ᄀ"],
    ["ᆩᄋ", "ᄁ"],
    ["ᆫᄋ", "ᄂ"],
    ["ᆮᄋ", "ᄃ"],
    ["ᆯᄋ", "ᄅ"],
    ["ᆷᄋ", "ᄆ"],
    ["ᆸᄋ", "ᄇ"],
    ["ᆺᄋ", "ᄉ"],
    ["ᆻᄋ", "ᄊ"],
    ["ᆽᄋ", "ᄌ"],
    ["ᆾᄋ", "ᄎ"],
    ["ᆿᄋ", "ᄏ"],
    ["ᇀᄋ", "ᄐ"],
    ["ᇁᄋ", "ᄑ"],
  ];
  for (const [from, to] of link1Pairs) {
    out = out.replaceAll(from, to);
  }

  // link2 (14): 겹받침 연음
  const link2Pairs: [string, string][] = [
    ["ᆪᄋ", "ᆨᄊ"],
    ["ᆬᄋ", "ᆫᄌ"],
    ["ᆰᄋ", "ᆯᄀ"],
    ["ᆱᄋ", "ᆯᄆ"],
    ["ᆲᄋ", "ᆯᄇ"],
    ["ᆳᄋ", "ᆯᄊ"],
    ["ᆴᄋ", "ᆯᄐ"],
    ["ᆵᄋ", "ᆯᄑ"],
    ["ᆹᄋ", "ᆸᄊ"],
  ];
  for (const [from, to] of link2Pairs) {
    out = out.replaceAll(from, to);
  }

  // link3 (15): 어절 경계 연음
  const link3Pairs: [string, string][] = [
    ["ᆨ ᄋ", " ᄀ"],
    ["ᆩ ᄋ", " ᄁ"],
    ["ᆫ ᄋ", " ᄂ"],
    ["ᆮ ᄋ", " ᄃ"],
    ["ᆯ ᄋ", " ᄅ"],
    ["ᆷ ᄋ", " ᄆ"],
    ["ᆸ ᄋ", " ᄇ"],
    ["ᆺ ᄋ", " ᄉ"],
    ["ᆻ ᄋ", " ᄊ"],
    ["ᆽ ᄋ", " ᄌ"],
    ["ᆾ ᄋ", " ᄎ"],
    ["ᆿ ᄋ", " ᄏ"],
    ["ᇀ ᄋ", " ᄐ"],
    ["ᇁ ᄋ", " ᄑ"],
    ["ᆪ ᄋ", "ᆨ ᄊ"],
    ["ᆬ ᄋ", "ᆫ ᄌ"],
    ["ᆰ ᄋ", "ᆯ ᄀ"],
    ["ᆱ ᄋ", "ᆯ ᄆ"],
    ["ᆲ ᄋ", "ᆯ ᄇ"],
    ["ᆳ ᄋ", "ᆯ ᄊ"],
    ["ᆴ ᄋ", "ᆯ ᄐ"],
    ["ᆵ ᄋ", "ᆯ ᄑ"],
    ["ᆹ ᄋ", "ᆸ ᄊ"],
  ];
  for (const [from, to] of link3Pairs) {
    out = out.replaceAll(from, to);
  }

  // link4 (12.4): ㅎ, ㄶ, ㅀ + ㅇ 연음 시 ㅎ 탈락
  out = out.replaceAll("ᇂᄋ", "ᄋ");
  out = out.replaceAll("ᆭᄋ", "ᄂ");
  out = out.replaceAll("ᆶᄋ", "ᄅ");

  // utils.py compose: 초성이 없는 중성 앞에 ᄋ 보충
  out = out.replace(/(^|[^\u1100-\u1112])([\u1161-\u1175])/g, "$1ᄋ$2");

  return out;
};

// ─── 싱글톤 모델 및 G2P 리소스 로더 ──────────────────────────────────────────

interface MeloTTSRuntime {
  session: ort.InferenceSession;
  symbolToId: Record<string, number>;
  krLangId: number;
  krToneStart: number;
  tableRules: G2PTableRegexRule[];
  idiomRules: G2PIdiomRule[];
}

let runtimePromise: Promise<MeloTTSRuntime> | null = null;

const downloadFileIfMissing = async (
  url: string,
  destPath: string,
): Promise<void> => {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  console.log(`[MeloTTS] 리소스 다운로드 중: ${path.basename(destPath)} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
};

const parseIdioms = (raw: string): G2PIdiomRule[] => {
  const rules: G2PIdiomRule[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.split("#")[0]?.trim();
    if (!trimmed || !trimmed.includes("===")) continue;
    const [pattern, replacement] = trimmed.split("===");
    if (pattern && replacement !== undefined) {
      rules.push({ pattern: pattern.trim(), replacement: replacement.trim() });
    }
  }
  return rules;
};

const parseTableCsv = (raw: string): G2PTableRegexRule[] => {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const onsets = lines[0]!.split(",");
  const rules: G2PTableRegexRule[] = [];

  for (let rowIdx = 1; rowIdx < lines.length; rowIdx++) {
    const cols = lines[rowIdx]!.split(",");
    const coda = cols[0];
    if (!coda) continue;

    for (let colIdx = 1; colIdx < onsets.length; colIdx++) {
      const onset = onsets[colIdx];
      const cell = cols[colIdx];
      if (!onset || !cell) continue;

      const jsOnsetPattern = onset.replace(
        "(\\W|$)",
        "([^\\u1100-\\u11FF\\uAC00-\\uD7A3A-Za-z0-9_]|$)",
      );
      const patternStr = `${coda}${jsOnsetPattern}`;
      const rawReplacement = cell.includes("(") ? cell.split("(")[0]! : cell;
      const jsReplacement = rawReplacement.replace(/\\1/g, "$1");

      rules.push({
        regex: new RegExp(patternStr, "g"),
        replacement: jsReplacement,
      });
    }
  }

  return rules;
};

/**
 * 로컬 MeloTTS-Korean ONNX 모델 및 한국어 G2P 리소스 사전 로드
 */
export const preloadMeloTTSModel = async (): Promise<MeloTTSRuntime> => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      await Promise.all([
        downloadFileIfMissing(
          `${HF_BASE_URL}/melotts_kr_fp32.onnx`,
          ONNX_PATH,
        ),
        downloadFileIfMissing(
          `${HF_BASE_URL}/melotts_kr_config.json`,
          CONFIG_PATH,
        ),
        downloadFileIfMissing(`${HF_BASE_URL}/symbols.json`, SYMBOLS_PATH),
        downloadFileIfMissing(
          `${HF_BASE_URL}/g2pkk/table.csv`,
          TABLE_CSV_PATH,
        ),
        downloadFileIfMissing(
          `${HF_BASE_URL}/g2pkk/idioms.txt`,
          IDIOMS_TXT_PATH,
        ),
      ]);

      console.log("[MeloTTS] 로컬 MeloTTS-Korean ONNX 엔진 초기화 중...");
      const [session, configRaw, symbolsRaw, tableRaw, idiomsRaw] =
        await Promise.all([
          ort.InferenceSession.create(ONNX_PATH, {
            intraOpNumThreads: 4,
            interOpNumThreads: 1,
          }),
          fs.promises.readFile(CONFIG_PATH, "utf-8"),
          fs.promises.readFile(SYMBOLS_PATH, "utf-8"),
          fs.promises.readFile(TABLE_CSV_PATH, "utf-8"),
          fs.promises.readFile(IDIOMS_TXT_PATH, "utf-8"),
        ]);

      const configData = JSON.parse(configRaw) as MeloConfigData;
      const symbolsMeta = JSON.parse(symbolsRaw) as SymbolsMetaData;

      const symbolToId: Record<string, number> = {};
      configData.symbols.forEach((sym, idx) => {
        symbolToId[sym] = idx;
      });

      const krLangId = symbolsMeta.language_id_map?.["KR"] ?? 4;
      const krToneStart = symbolsMeta.language_tone_start_map?.["KR"] ?? 11;
      const tableRules = parseTableCsv(tableRaw);
      const idiomRules = parseIdioms(idiomsRaw);

      console.log("[MeloTTS] MeloTTS-Korean 로컬 엔진 준비 완료 (44.1kHz FP32)");
      return {
        session,
        symbolToId,
        krLangId,
        krToneStart,
        tableRules,
        idiomRules,
      };
    })().catch((err) => {
      runtimePromise = null;
      console.error("[MeloTTS] 모델 초기화 실패:", err);
      throw err;
    });
  }
  return runtimePromise;
};

/**
 * 단일 어절에 대해 g2pkk 음운 변동 및 NFD 자모 변환 수행
 */
const koreanWordToPhonemes = (
  word: string,
  runtime: MeloTTSRuntime,
): string => {
  const replacedCompat = word.replace(
    /[ㄱ-ㅎ]/g,
    (ch) => COMPAT_TO_CHOSEONG[ch] || "",
  );
  let jamo = replacedCompat.normalize("NFD");

  jamo = applyG2PSpecialRules(jamo);
  for (const rule of runtime.tableRules) {
    jamo = jamo.replace(rule.regex, rule.replacement);
  }
  jamo = applyG2PLiaisonRules(jamo);

  return jamo;
};

/**
 * 텍스트 정규화 (특수기호, 관용구, 영문, 숫자, 관형사형 ㄹ 경음화)
 */
const normalizeKoreanText = (
  rawText: string,
  runtime: MeloTTSRuntime,
): string => {
  let text = rawText.trim();
  if (!text) return "";

  text = text.replace(
    /[⺀-⺙⺛-⻳⼀-⿕々〇〡-〩〸-〺〻㐀-䶵一-鿃豈-鶴侮-頻並-龎]/g,
    "",
  );
  for (const [k, v] of Object.entries(ETC_DICTIONARY)) {
    text = text.replaceAll(k, v);
  }
  for (const rule of runtime.idiomRules) {
    text = text.replaceAll(rule.pattern, rule.replacement);
  }

  text = normalizeEnglishToKorean(text);
  text = normalizeKoreanNumbers(text);
  text = applyRieulBoundNounTensification(text);

  return text
    .replace(/~+/g, ",")
    .replace(/\.{2,}|…+/g, ".")
    .replace(/[""''"']/g, "");
};

/**
 * 단일 구절(Clause: 문장 내 구두점이 없는 순수 어절 묶음 + 종결부호 1개)을 토큰 시퀀스로 변환
 * - 문장 중간에 `,`나 `!` 토큰이 들어가면 zero-BERT 상태에서 파열음/경음 노이즈("까", "찌")가 생기는 현상을 방지하기 위해
 *   구절 내부에는 순수 한국어 자모만 배치하고 맨 끝에만 종결 구두점 토큰 1개를 부여합니다.
 */
const clauseToMeloSequence = (
  clauseBody: string,
  endPunctuation: "." | "?" | "!",
  runtime: MeloTTSRuntime,
): { phones: number[]; tones: number[]; langIds: number[] } | null => {
  const words = clauseBody.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g)?.filter(Boolean) ?? [];
  if (words.length === 0) return null;

  const { symbolToId, krLangId, krToneStart } = runtime;
  const startEndId = symbolToId["_"] ?? 0;
  const rawTokenIds: number[] = [startEndId];

  for (const word of words) {
    const phonemes = koreanWordToPhonemes(word, runtime);
    for (const ch of phonemes) {
      const id = symbolToId[ch];
      if (id !== undefined) {
        rawTokenIds.push(id);
      }
    }
  }

  if (rawTokenIds.length <= 1) {
    return null;
  }

  const endPuncId = symbolToId[endPunctuation] ?? symbolToId["."];
  if (endPuncId !== undefined) {
    rawTokenIds.push(endPuncId);
  }
  rawTokenIds.push(startEndId);

  const phones: number[] = [0];
  const tones: number[] = [0];
  const langIds: number[] = [0];

  for (const tokenId of rawTokenIds) {
    phones.push(tokenId, 0);
    tones.push(krToneStart, 0);
    langIds.push(krLangId, 0);
  }

  return { phones, tones, langIds };
};

/**
 * 구절 합성 파형의 앞뒤 불필요한 무음을 다듬어 반환
 */
const trimClauseWaveform = (
  samples: Float32Array,
  sampleRate: number = MELOTTS_SAMPLE_RATE,
): Float32Array => {
  const silenceThreshold = 0.003;
  let startIdx = 0;
  let endIdx = samples.length - 1;

  while (
    startIdx < samples.length &&
    Math.abs(samples[startIdx]!) < silenceThreshold
  ) {
    startIdx++;
  }
  while (
    endIdx > startIdx &&
    Math.abs(samples[endIdx]!) < silenceThreshold
  ) {
    endIdx--;
  }

  const padStart = Math.floor(sampleRate * 0.02);
  const padEnd = Math.floor(sampleRate * 0.085);
  startIdx = Math.max(0, startIdx - padStart);
  endIdx = Math.min(samples.length - 1, endIdx + padEnd);

  return samples.slice(startIdx, endIdx + 1);
};

/**
 * 구절별 파형들을 자연스러운 호흡 간격(140ms)과 끝 여백(380ms)을 두고 결합하여 16-bit PCM WAV Buffer로 변환
 * - 끝 여백(380ms)이 충분해야 FFmpeg 및 Discord Opus 인코더가 문장 마지막 음절을 잘라먹지 않음
 */
const clauseWaveformsToWavBuffer = (
  clauseChunks: Float32Array[],
  sampleRate: number = MELOTTS_SAMPLE_RATE,
): Buffer => {
  const interClauseGap = new Float32Array(Math.floor(sampleRate * 0.14));
  const tailSilence = new Float32Array(Math.floor(sampleRate * 0.38));

  const segments: Float32Array[] = [];
  clauseChunks.forEach((chunk, idx) => {
    segments.push(chunk);
    if (idx < clauseChunks.length - 1) {
      segments.push(interClauseGap);
    }
  });
  segments.push(tailSilence);

  const totalSamples = segments.reduce((acc, cur) => acc + cur.length, 0);
  const dataByteLength = totalSamples * 2;
  const wavBuffer = Buffer.allocUnsafe(44 + dataByteLength);

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataByteLength, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(1, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * 2, 28);
  wavBuffer.writeUInt16LE(2, 32);
  wavBuffer.writeUInt16LE(16, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataByteLength, 40);

  let byteOffset = 44;
  for (const seg of segments) {
    for (let i = 0; i < seg.length; i++) {
      const s = Math.max(-1, Math.min(1, seg[i]!));
      const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      wavBuffer.writeInt16LE(int16, byteOffset);
      byteOffset += 2;
    }
  }

  return wavBuffer;
};

/**
 * FFmpeg 오디오 필터 (피치 변경, 이퀄라이저 등)를 인메모리로 빠르게 적용
 */
export const applyFfmpegFilter = (
  wavBuffer: Buffer,
  audioFilter: string,
): Promise<Buffer> => {
  const binaryPath =
    typeof ffmpegPath === "string"
      ? ffmpegPath
      : (ffmpegPath as unknown as { default?: string })?.default || "ffmpeg";

  if (!audioFilter || !binaryPath) return Promise.resolve(wavBuffer);

  return new Promise((resolve) => {
    try {
      const child = spawn(
        binaryPath,
        [
          "-f",
          "wav",
          "-i",
          "pipe:0",
          "-af",
          audioFilter,
          "-f",
          "wav",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "ignore"] as const },
      );

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", (err: Error) => {
        console.warn("[MeloTTS] FFmpeg 필터 적용 실패:", err);
        resolve(wavBuffer);
      });
      child.on("close", (code: number | null) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(wavBuffer);
        }
      });

      child.stdin?.end(wavBuffer);
    } catch {
      resolve(wavBuffer);
    }
  });
};

// ONNX 추론 직렬화 체인 (동시 다중 호출 시 스레드 경합 방지)
let inferenceQueue: Promise<unknown> = Promise.resolve();

/**
 * 한국어 문장을 구절(Clause) 단위로 정밀 합성하여 인메모리 WAV Buffer 및 바이너리 스트림으로 반환
 */
export const synthesizeMeloSentence = async (
  sentence: string,
  options?: MeloSynthesizeOptions,
): Promise<{ wavBuffer: Buffer; stream: Readable } | null> => {
  const runtime = await preloadMeloTTSModel();
  const normalized = normalizeKoreanText(sentence, runtime);
  if (!normalized) return null;

  // 문장 내 쉼표(,), 느낌표(!), 물음표(?), 마침표(.) 단위로 구절을 나누어 중간 구두점 아티팩트 원천 차단
  const rawClauses = Array.from(
    normalized.matchAll(/([^,!?.;:\n]+)([,!?.;:]?)/g),
  )
    .map((m) => ({
      body: (m[1] || "").trim(),
      punc: (m[2] || ".").trim(),
    }))
    .filter((c) => /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(c.body));

  if (rawClauses.length === 0) return null;

  const speed = options?.speed ?? 1.03;
  const lengthScale = 1.0 / Math.max(0.5, Math.min(2.0, speed));
  const noiseScale = options?.noiseScale ?? 0.5;
  const noiseScaleW = options?.noiseScaleW ?? 0.6;
  const sdpRatio = options?.sdpRatio ?? 0.2;

  const runTask = async (): Promise<Buffer | null> => {
    const clauseWaveforms: Float32Array[] = [];

    for (const clause of rawClauses) {
      const endPunc: "." | "?" | "!" =
        clause.punc === "?" ? "?" : clause.punc === "!" ? "!" : ".";
      const seq = clauseToMeloSequence(clause.body, endPunc, runtime);
      if (!seq) continue;

      const T = seq.phones.length;
      const feeds: Record<string, ort.Tensor> = {
        x: new ort.Tensor(
          "int64",
          BigInt64Array.from(seq.phones.map((n) => BigInt(n))),
          [1, T],
        ),
        x_lengths: new ort.Tensor(
          "int64",
          BigInt64Array.from([BigInt(T)]),
          [1],
        ),
        sid: new ort.Tensor("int64", BigInt64Array.from([0n]), [1]),
        tone: new ort.Tensor(
          "int64",
          BigInt64Array.from(seq.tones.map((n) => BigInt(n))),
          [1, T],
        ),
        language: new ort.Tensor(
          "int64",
          BigInt64Array.from(seq.langIds.map((n) => BigInt(n))),
          [1, T],
        ),
        bert: new ort.Tensor("float32", new Float32Array(1024 * T), [
          1,
          1024,
          T,
        ]),
        ja_bert: new ort.Tensor("float32", new Float32Array(768 * T), [
          1,
          768,
          T,
        ]),
        noise_scale: new ort.Tensor(
          "float32",
          Float32Array.from([noiseScale]),
          [1],
        ),
        length_scale: new ort.Tensor(
          "float32",
          Float32Array.from([lengthScale]),
          [1],
        ),
        noise_scale_w: new ort.Tensor(
          "float32",
          Float32Array.from([noiseScaleW]),
          [1],
        ),
        sdp_ratio: new ort.Tensor("float32", Float32Array.from([sdpRatio]), [
          1,
        ]),
      };

      const output = await runtime.session.run(feeds);
      const audioTensor = output["audio"];
      if (!audioTensor) continue;

      const samples = audioTensor.data as Float32Array;
      if (!samples || samples.length === 0) continue;

      clauseWaveforms.push(trimClauseWaveform(samples, MELOTTS_SAMPLE_RATE));
    }

    if (clauseWaveforms.length === 0) return null;
    return clauseWaveformsToWavBuffer(clauseWaveforms, MELOTTS_SAMPLE_RATE);
  };

  const nextTask = inferenceQueue.then(runTask, runTask);
  inferenceQueue = nextTask.catch(() => {});

  let wavBuffer = await nextTask;
  if (!wavBuffer) return null;

  // 음색 프리셋별 고유 필터(피치 시프트, 이퀄라이저) 적용
  if (options?.filter) {
    wavBuffer = await applyFfmpegFilter(wavBuffer, options.filter);
  }

  // Readable.from(Buffer)의 objectMode 이슈를 방지하기 위해 순수 바이너리 PassThrough 스트림 사용
  const stream = new PassThrough();
  stream.end(wavBuffer);

  return {
    wavBuffer,
    stream,
  };
};

/**
 * 응답 텍스트를 문장 단위 스트리밍 재생에 적합하도록 분할
 */
export const splitTextIntoSentences = (cleanedText: string): string[] => {
  const normalized = cleanedText.trim();
  if (!normalized) return [];

  const rawSegments = normalized
    .split(/(?<=[.!?…~])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const expandedSegments: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length > 65 && seg.includes(",")) {
      const commaParts = seg
        .split(/(?<=,)\s+/g)
        .map((p) => p.trim())
        .filter(Boolean);
      expandedSegments.push(...commaParts);
    } else {
      expandedSegments.push(seg);
    }
  }

  return expandedSegments;
};
