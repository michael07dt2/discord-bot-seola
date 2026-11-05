import fs from "fs";
import path from "path";
import { Readable } from "stream";
import ort from "onnxruntime-node";

const MODEL_DIR = path.resolve(process.cwd(), "models", "melotts-kr");
const G2P_DIR = path.join(MODEL_DIR, "g2pkk");
const ONNX_PATH = path.join(MODEL_DIR, "melotts_kr_fp32.onnx");
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
}

interface SymbolsData {
  symbols: string[];
  symbol_to_id: Record<string, number>;
  language_id_map: Record<string, number>;
  language_tone_start_map: Record<string, number>;
}

interface G2PRule {
  pattern: string;
  replacement: string;
}

// ─── 한국어 숫자/특수문자/영문 발음 사전 ────────────────────────────────────────

const ETC_DICTIONARY: Record<string, string> = {
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
  "닢",
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

  // 너무 긴 숫자(전화번호 등)는 자리별로 읽기
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
        digit === "1" && (smallIdx > 0 || (smallIdx === 0 && largeIdx === 1 && len === 5));
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
  // 1. 소수점 숫자 (예: 3.14 -> 삼점일사)
  let out = text.replace(/(\d+)\.(\d+)/g, (_, intPart: string, fracPart: string) => {
    const intKr = numberToSinoKorean(intPart);
    const fracKr = fracPart
      .split("")
      .map((d) => SINO_DIGITS[d] || "")
      .join("");
    return `${intKr}점${fracKr}`;
  });

  // 2. 숫자 + 고유어 단위명사 (예: 1개 -> 한개, 2시 -> 두시, 20살 -> 스무살)
  out = out.replace(
    /(\d{1,2})\s*([가-힣]+)/g,
    (fullMatch, numStr: string, followingWord: string) => {
      for (const noun of BOUND_NOUNS) {
        if (followingWord === noun || followingWord.startsWith(noun)) {
          // '분'이 시간(Minute) 의미로 쓰일 때('10분', '30분', '5분')는 한자어 수사가 자연스러움
          if (noun === "분" && !/^(께서|께|이|은|도|만|들)/.test(followingWord.slice(1))) {
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

  // 3. 일반 정수 (예: 2026 -> 이천이십육)
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

    // 짧은 대문자 약어(4글자 이하)는 알파벳 한 글자씩 읽기
    if (word === upper && word.length <= 4) {
      return word
        .split("")
        .map((ch) => UPPER_CHAR_TO_KR[ch] || "")
        .join("");
    }

    // 나머지 영단어는 알파벳 단위로 안전하게 변환
    return upper
      .split("")
      .map((ch) => UPPER_CHAR_TO_KR[ch] || "")
      .join("");
  });
};

// ─── G2PKK (한국어 음운 변동 규칙) ────────────────────────────────────────────

/**
 * 호환용 자모(ㄱ~ㅎ, ㅏ~ㅣ)를 음절 NFD 자모(ᄀ~ᄒ, ᅡ~ᅵ)로 매핑
 */
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

const applyG2PSpecialRules = (inp: string): string => {
  let text = inp;

  // 1. jyeo: ㅈ, ㅉ, ㅊ + ㅕ -> ㅓ
  text = text.replace(/([ᄌᄍᄎ])ᅧ/g, "$1ᅥ");

  // 2. ye: 자음(ᄋ, ᆯ, ᆫ, ᄒ 제외) 뒤의 ᅨ -> ᅦ
  text = text.replace(/([ᄀᄁᄃᄄᄆᄇᄈᄉᄊᄌᄍᄎᄏᄐᄑ])ᅨ/g, "$1ᅦ");

  // 3. consonant_ui: 자음(ᄋ 제외) + ᅴ -> ᅵ
  text = text.replace(/([ᄀᄁᄂᄃᄄᄅᄆᄇᄈᄉᄊᄌᄍᄎᄏᄐᄑᄒ])ᅴ/g, "$1ᅵ");

  // 4. 조사 '의' 및 단어 두음 이외의 '의' 완화 (공백 뒤 첫 음절이 아닌 의 -> 에/이)
  text = text.replace(/([가-힣\u1161-\u11C2])의/g, "$1에");

  // 5. jamo: 어말 및 자음 앞 겹받침 단순화
  text = text.replace(/([ᆨᆿᇁᆭᆰ])ᆺ/g, "$1");
  text = text.replace(/([ᆨᆰ])([ᆺᄌ])/g, "ᆨ$2");
  text = text.replace(/([ᆫᆬ])([ᄌ])/g, "ᆫ$2");
  text = text.replace(/([ᆯᆴ])([ᆺ])/g, "ᆯ$2");
  text = text.replace(/ᆲ([ᆺ])/g, "ᆸ$1");

  // 6. 밟- 예외 (밟다, 밟소, 밟지, 밟고 등 -> 밥-)
  text = text.replace(/(바)ᆲ($|[^ᄋᄒ])/g, "$1ᆸ$2");

  // 7. 구개음화 (ㄷ, ㅌ + 이/히 -> 지/치)
  text = text.replace(/ᆮᄋ([ᅵᅧ])/g, "ᄌ$1");
  text = text.replace(/ᇀᄋ([ᅵᅧ])/g, "ᄎ$1");
  text = text.replace(/ᆴᄋ([ᅵᅧ])/g, "ᆯᄎ$1");
  text = text.replace(/ᆮᄒ([ᅵ])/g, "ᄎ$1");

  // 8. 관형사형 'ㄹ' 뒤 경음화 (할 것을 -> 할 꺼슬, 갈 데 -> 갈 떼 등)
  text = text.replace(/ᆯ ᄀ/g, "ᆯ ᄁ");
  text = text.replace(/ᆯ ᄃ/g, "ᆯ ᄄ");
  text = text.replace(/ᆯ ᄇ/g, "ᆯ ᄈ");
  text = text.replace(/ᆯ ᄉ/g, "ᆯ ᄊ");
  text = text.replace(/ᆯ ᄌ/g, "ᆯ ᄍ");

  return text;
};

const applyG2PLiaisonRules = (inp: string): string => {
  let text = inp;

  // link1: 홑받침/쌍받침 연음 (ㅇ 제외)
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
    text = text.replaceAll(from, to);
  }

  // link2: 겹받침 연음
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
    text = text.replaceAll(from, to);
  }

  // link3: 어절 경계(공백) 넘어 연음 완화 (자연스러운 일상 발음)
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
    text = text.replaceAll(from, to);
  }

  // link4: ㅎ 탈락 (ㅎ, ㄶ, ㅀ + ㅇ)
  text = text.replaceAll("ᇂᄋ", "ᄋ");
  text = text.replaceAll("ᆭᄋ", "ᄂ");
  text = text.replaceAll("ᆶᄋ", "ᄅ");

  return text;
};

// ─── 싱글톤 모델 및 G2P 리소스 로더 ──────────────────────────────────────────

interface MeloTTSRuntime {
  session: ort.InferenceSession;
  symbolsData: SymbolsData;
  tableRules: G2PRule[];
  idiomRules: G2PRule[];
}

let runtimePromise: Promise<MeloTTSRuntime> | null = null;

const downloadFileIfMissing = async (url: string, destPath: string): Promise<void> => {
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

const parseIdioms = (raw: string): G2PRule[] => {
  const rules: G2PRule[] = [];
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

const parseTableCsv = (raw: string): G2PRule[] => {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const onsets = lines[0]!.split(",").slice(1);
  const rules: G2PRule[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const coda = cols[0];
    if (!coda) continue;

    for (let j = 0; j < onsets.length; j++) {
      const onset = onsets[j];
      const cell = cols[j + 1];
      if (!onset || !cell) continue;

      const pattern = coda + onset;
      // NFD 자모로 정규화하여 비교/치환
      const normPattern = pattern.normalize("NFD");
      const normReplacement = cell.normalize("NFD");
      if (normPattern !== normReplacement) {
        rules.push({ pattern: normPattern, replacement: normReplacement });
      }
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
      const [session, symbolsRaw, tableRaw, idiomsRaw] = await Promise.all([
        ort.InferenceSession.create(ONNX_PATH, {
          intraOpNumThreads: 4,
          interOpNumThreads: 1,
        }),
        fs.promises.readFile(SYMBOLS_PATH, "utf-8"),
        fs.promises.readFile(TABLE_CSV_PATH, "utf-8"),
        fs.promises.readFile(IDIOMS_TXT_PATH, "utf-8"),
      ]);

      const symbolsData = JSON.parse(symbolsRaw) as SymbolsData;
      const tableRules = parseTableCsv(tableRaw);
      const idiomRules = parseIdioms(idiomsRaw);

      console.log("[MeloTTS] MeloTTS-Korean 로컬 엔진 준비 완료 (44.1kHz FP32)");
      return {
        session,
        symbolsData,
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
 * 한국어 문장을 MeloTTS-Korean 입력용 Jamo 음소 배열 및 토큰 시퀀스로 변환
 */
const textToMeloSequence = (
  rawSentence: string,
  runtime: MeloTTSRuntime,
): { phones: number[]; tones: number[]; langIds: number[] } | null => {
  let text = rawSentence.trim();
  if (!text) return null;

  // 1. 특수 기호 치환
  for (const [k, v] of Object.entries(ETC_DICTIONARY)) {
    text = text.replaceAll(k, v);
  }

  // 2. 관용구(idioms.txt) 치환
  for (const rule of runtime.idiomRules) {
    text = text.replaceAll(rule.pattern, rule.replacement);
  }

  // 3. 영문 -> 한글 발음 변환
  text = normalizeEnglishToKorean(text);

  // 4. 숫자 -> 한글 수사 변환
  text = normalizeKoreanNumbers(text);

  // 5. 물결표(~) 및 말줄임표 정규화 (MeloTTS 구두점 심볼 호환)
  text = text
    .replace(/~+/g, ",")
    .replace(/\.{2,}|…+/g, "…")
    .replace(/["""]/g, "")
    .replace(/[''']/g, "'");

  // 6. 단독 자음(ㄱ~ㅎ)이 남아있으면 초성 자모로 치환 후 전체 NFD 자모 분해
  text = text.replace(/[ㄱ-ㅎ]/g, (ch) => COMPAT_TO_CHOSEONG[ch] || "");
  let jamoText = text.normalize("NFD");

  // 7. G2PKK 음운 변동 적용 (특수 규칙 -> 자음동화/경음화 테이블 -> 연음 규칙)
  jamoText = applyG2PSpecialRules(jamoText);
  for (const rule of runtime.tableRules) {
    if (jamoText.includes(rule.pattern)) {
      jamoText = jamoText.replaceAll(rule.pattern, rule.replacement);
    }
  }
  jamoText = applyG2PLiaisonRules(jamoText);

  // 8. symbols.json 매핑
  const symbolToId = runtime.symbolsData.symbol_to_id;
  const krLangId = runtime.symbolsData.language_id_map["KR"] ?? 4;
  const krToneStart = runtime.symbolsData.language_tone_start_map["KR"] ?? 11;

  const rawTokenIds: number[] = [];
  const startEndId = symbolToId["_"] ?? 0;

  rawTokenIds.push(startEndId);
  for (const ch of jamoText) {
    if (ch === " ") {
      // 어절 경계에 짧은 쉼표/휴지 토큰 대신 공백 무시 (MeloTTS korean_text_to_phonemes는 공백을 제거함)
      continue;
    }
    const id = symbolToId[ch];
    if (id !== undefined) {
      rawTokenIds.push(id);
    }
  }
  rawTokenIds.push(startEndId);

  // 실제 발음할 음소가 하나도 없으면(구두점만 있는 경우) 건너뜀
  if (rawTokenIds.length <= 2) {
    return null;
  }

  // commons.intersperse(arr, 0): [0, t0, 0, t1, ..., 0]
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
 * Float32Array(-1.0 ~ 1.0) 오디오 파형을 16-bit PCM WAV Buffer로 변환
 * - 문장 간 이어붙일 때 자연스러운 호흡을 위해 앞뒤 과도한 무음(Silence)을 다듬고 짧은 여백(45ms)만 유지
 */
const float32ToWavBuffer = (
  samples: Float32Array,
  sampleRate: number = MELOTTS_SAMPLE_RATE,
): Buffer => {
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

  // 앞쪽 25ms, 뒤쪽 65ms 정도의 자연스러운 여백 유지
  const padStart = Math.floor(sampleRate * 0.025);
  const padEnd = Math.floor(sampleRate * 0.065);
  startIdx = Math.max(0, startIdx - padStart);
  endIdx = Math.min(samples.length - 1, endIdx + padEnd);

  const trimmedLength = Math.max(1, endIdx - startIdx + 1);
  const dataByteLength = trimmedLength * 2;
  const wavBuffer = Buffer.allocUnsafe(44 + dataByteLength);

  // RIFF WAV Header
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataByteLength, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16); // PCM chunk size
  wavBuffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  wavBuffer.writeUInt16LE(1, 22); // NumChannels = 1 (Mono)
  wavBuffer.writeUInt32LE(sampleRate, 24); // SampleRate
  wavBuffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  wavBuffer.writeUInt16LE(2, 32); // BlockAlign
  wavBuffer.writeUInt16LE(16, 34); // BitsPerSample
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataByteLength, 40);

  for (let i = 0; i < trimmedLength; i++) {
    const s = Math.max(-1, Math.min(1, samples[startIdx + i]!));
    const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    wavBuffer.writeInt16LE(int16, 44 + i * 2);
  }

  return wavBuffer;
};

// ONNX 추론 직렬화 체인 (동시 다중 호출 시 스레드 경합 방지)
let inferenceQueue: Promise<unknown> = Promise.resolve();

/**
 * 단일 한국어 문장을 MeloTTS-Korean으로 합성하여 인메모리 WAV Buffer(및 Readable 스트림)로 반환
 */
export const synthesizeMeloSentence = async (
  sentence: string,
  options?: MeloSynthesizeOptions,
): Promise<{ wavBuffer: Buffer; stream: Readable } | null> => {
  const runtime = await preloadMeloTTSModel();
  const seq = textToMeloSequence(sentence, runtime);
  if (!seq) return null;

  const speed = options?.speed ?? 1.05;
  const lengthScale = 1.0 / Math.max(0.5, Math.min(2.0, speed));
  const noiseScale = options?.noiseScale ?? 0.6;
  const noiseScaleW = options?.noiseScaleW ?? 0.8;
  const sdpRatio = options?.sdpRatio ?? 0.2;

  const T = seq.phones.length;

  const runTask = async (): Promise<Buffer | null> => {
    const feeds: Record<string, ort.Tensor> = {
      x: new ort.Tensor(
        "int64",
        BigInt64Array.from(seq.phones.map((n) => BigInt(n))),
        [1, T],
      ),
      x_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(T)]), [1]),
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
      noise_scale: new ort.Tensor("float32", Float32Array.from([noiseScale]), [
        1,
      ]),
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
      sdp_ratio: new ort.Tensor("float32", Float32Array.from([sdpRatio]), [1]),
    };

    const output = await runtime.session.run(feeds);
    const audioTensor = output["audio"];
    if (!audioTensor) return null;

    const samples = audioTensor.data as Float32Array;
    if (!samples || samples.length === 0) return null;

    return float32ToWavBuffer(samples, MELOTTS_SAMPLE_RATE);
  };

  const nextTask = inferenceQueue.then(runTask, runTask);
  inferenceQueue = nextTask.catch(() => {});

  const wavBuffer = await nextTask;
  if (!wavBuffer) return null;

  return {
    wavBuffer,
    stream: Readable.from(wavBuffer),
  };
};

/**
 * 응답 텍스트를 문장 단위 스트리밍 재생에 적합하도록 분할
 * - 마침표(.), 물음표(?), 느낌표(!), 말줄임표(…), 줄바꿈(\n) 기준으로 문장을 분리
 * - 너무 짧은 감탄사("응!", "헐,", "맞아!")는 단독 재생 시 끊기는 느낌을 줄이기 위해 뒤 문장과 자연스럽게 병합
 * - 반대로 구두점 없이 너무 긴 문장(65자 이상)은 쉼표(,)나 연결어미 단위로 한 번 더 분할하여 첫 오디오 지연 최소화
 */
export const splitTextIntoSentences = (cleanedText: string): string[] => {
  const normalized = cleanedText.trim();
  if (!normalized) return [];

  // 문장 종결부호(. ! ? … ~) 또는 줄바꿈 뒤에서 분리하되 종결부호는 앞 문장에 유지
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

  // 너무 짧은 조각(4자 이하)은 다음 문장과 결합하여 억양 자연스러움 유지
  const merged: string[] = [];
  let buffer = "";

  for (const seg of expandedSegments) {
    if (!buffer) {
      buffer = seg;
    } else if (buffer.length <= 5) {
      buffer = `${buffer} ${seg}`;
    } else {
      merged.push(buffer);
      buffer = seg;
    }
  }
  if (buffer) {
    if (merged.length > 0 && buffer.length <= 3) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${buffer}`;
    } else {
      merged.push(buffer);
    }
  }

  return merged;
};
