import { desc, eq, sql } from "drizzle-orm";
import { db, userMemoriesTable } from "../db/index.ts";
import CONFIG from "../config/index.ts";

export interface MemoryItem {
  id: number;
  userName: string;
  memory: string;
  category: string;
  importance: number;
  createdAt: string;
}

let isMemoriesTableInitialized = false;

// 인메모리 캐시: 유저별 장기 기억 목록 (DB 접근 최소화 및 오프라인 폴백 지원)
const memoryCache = new Map<string, MemoryItem[]>();

export const ensureUserMemoriesTable = async (): Promise<void> => {
  if (isMemoriesTableInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "user_memories" (
        "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        "user_name" varchar(255) NOT NULL,
        "memory" text NOT NULL,
        "category" varchar(50) NOT NULL DEFAULT 'general',
        "importance" integer NOT NULL DEFAULT 3,
        "embedding" text,
        "created_at" timestamptz NOT NULL DEFAULT NOW(),
        "updated_at" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    isMemoriesTableInitialized = true;
  } catch (error) {
    console.error("user_memories 테이블 초기화 중 오류 발생:", error);
  }
};

/**
 * 텍스트로부터 단어 빈도 기반 임베딩 벡터 생성 (Ollama 미구동 시의 가벼운 폴백)
 */
const getFallbackEmbedding = (text: string): number[] => {
  const words = text
    .toLowerCase()
    .replace(/[^\w가-힣\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  const hashDim = 128;
  const vector = new Array(hashDim).fill(0);

  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = (hash << 5) - hash + word.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % hashDim;
    vector[idx] += 1;
  }

  // L2 정규화
  let norm = 0;
  for (let i = 0; i < hashDim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < hashDim; i++) vector[i] /= norm;
  }
  return vector;
};

/**
 * 로컬 Ollama 또는 폴백 알고리즘을 통한 텍스트 임베딩 벡터 생성
 */
export const getEmbedding = async (text: string): Promise<number[]> => {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const res = await fetch(`${CONFIG.OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: trimmed,
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const data = (await res.json()) as { embedding?: number[] };
      if (Array.isArray(data.embedding) && data.embedding.length > 0) {
        return data.embedding;
      }
    }
  } catch {
    // Ollama 임베딩 서버 미설치/미응답 시 자체 해시 임베딩으로 폴백
  }

  return getFallbackEmbedding(trimmed);
};

/**
 * 두 벡터 간의 코사인 유사도(Cosine Similarity) 계산
 */
export const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  if (vecA.length === 0 || vecB.length === 0) return 0;
  if (vecA.length !== vecB.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
    normA += vecA[i]! * vecA[i]!;
    normB += vecB[i]! * vecB[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
};

/**
 * 사용자 장기 기억 추가 및 임베딩 저장
 */
export const saveUserMemory = async (params: {
  userName: string;
  memory: string;
  category?: string;
  importance?: number;
}): Promise<MemoryItem> => {
  const {
    userName,
    memory,
    category = "general",
    importance = 3,
  } = params;

  const embedding = await getEmbedding(memory);
  const embeddingJson = JSON.stringify(embedding);

  let insertedId = Date.now();
  try {
    await ensureUserMemoriesTable();
    const rows = await db
      .insert(userMemoriesTable)
      .values({
        userName,
        memory,
        category,
        importance,
        embedding: embeddingJson,
      })
      .returning({ id: userMemoriesTable.id, createdAt: userMemoriesTable.createdAt });

    if (rows[0]) {
      insertedId = rows[0].id;
    }
  } catch (err) {
    console.warn("[MemoryRAG] DB 저장 실패, 메모리 캐시로 기록:", err);
  }

  const item: MemoryItem = {
    id: insertedId,
    userName,
    memory,
    category,
    importance,
    createdAt: new Date().toISOString(),
  };

  const userList = memoryCache.get(userName) || [];
  userList.unshift(item);
  memoryCache.set(userName, userList);

  return item;
};

/**
 * 사용자 관련 모든 기억 목록 조회 (최신순)
 */
export const listUserMemories = async (userName: string): Promise<MemoryItem[]> => {
  try {
    await ensureUserMemoriesTable();
    const rows = await db
      .select()
      .from(userMemoriesTable)
      .where(eq(userMemoriesTable.userName, userName))
      .orderBy(desc(userMemoriesTable.importance), desc(userMemoriesTable.id));

    const list: MemoryItem[] = rows.map((r) => ({
      id: r.id,
      userName: r.userName,
      memory: r.memory,
      category: r.category,
      importance: r.importance,
      createdAt: r.createdAt.toISOString(),
    }));

    memoryCache.set(userName, list);
    return list;
  } catch {
    return memoryCache.get(userName) || [];
  }
};

/**
 * 특정 장기 기억 삭제
 */
export const deleteUserMemory = async (id: number): Promise<boolean> => {
  try {
    await ensureUserMemoriesTable();
    await db.delete(userMemoriesTable).where(eq(userMemoriesTable.id, id));
  } catch (err) {
    console.warn("[MemoryRAG] DB 삭제 실패:", err);
  }

  // 캐시에서도 삭제
  for (const [userName, list] of memoryCache.entries()) {
    const nextList = list.filter((m) => m.id !== id);
    if (nextList.length !== list.length) {
      memoryCache.set(userName, nextList);
      break;
    }
  }
  return true;
};

/**
 * 질의(Query)와 가장 의미적으로 유사한 개인화 기억 Top-K 검색
 */
export const retrieveRelevantMemories = async (
  userName: string,
  query: string,
  topK = 3,
): Promise<{ memory: string; score: number; category: string }[]> => {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const memories = await listUserMemories(userName);
  if (memories.length === 0) return [];

  const queryVec = await getEmbedding(trimmed);

  // 유사도 계산 및 랭킹
  const scoredList: { memory: string; score: number; category: string }[] = [];

  for (const item of memories) {
    // 키워드 겹침 보너스
    const itemWords = item.memory.split(/\s+/);
    let keywordOverlap = 0;
    for (const w of itemWords) {
      if (w.length >= 2 && trimmed.includes(w)) {
        keywordOverlap += 0.2;
      }
    }

    const itemVec = await getEmbedding(item.memory);
    const cosScore = cosineSimilarity(queryVec, itemVec);
    const totalScore = cosScore + keywordOverlap + (item.importance * 0.05);

    if (totalScore > 0.15) {
      scoredList.push({
        memory: item.memory,
        score: totalScore,
        category: item.category,
      });
    }
  }

  scoredList.sort((a, b) => b.score - a.score);
  return scoredList.slice(0, topK);
};

/**
 * 사용자의 자연스러운 발화 중에서 개인 취향, 정보, 기억할 만한 사실을 자동 감지하여 저장
 */
export const extractAndStoreImplicitMemories = async (
  userName: string,
  userText: string,
): Promise<void> => {
  const text = userText.trim();
  if (text.length < 5 || text.length > 200) return;

  // 개인 선호 및 신상 정보 패턴
  const patterns: { regex: RegExp; category: string; importance: number }[] = [
    {
      regex: /(?:내|제|나|저)\s*(?:의)?\s*(?:생년월일|생일|생신|출생일|태어난\s*(?:날|해)?)(?:은|이|이야|야)?\s*([^\n,.!?~]+)/i,
      category: "birthday",
      importance: 5,
    },
    {
      regex: /(?:나|내|저|제)\s*(?:는|가|의)?\s*(?:취미|특기)(?:는|가)?\s*([^\n,.!?~]+)/i,
      category: "hobby",
      importance: 4,
    },
    {
      regex: /(?:나|저)\s*(?:는|가)?\s*([^\n,.!?~]+?)(?:을|를|이|가)?\s*(?:제일|가장|엄청|완전|진짜)?\s*(?:좋아해|좋아함|선호해|사랑해)/i,
      category: "preference",
      importance: 4,
    },
    {
      regex: /(?:나|저)\s*(?:는|가)?\s*([^\n,.!?~]+?)(?:을|를|은|는)?\s*(?:싫어해|못\s*먹어|안\s*좋아해|질색해)/i,
      category: "dislike",
      importance: 4,
    },
    {
      regex: /(?:내|제|나)\s*(?:MBTI|엠비티아이)(?:는|이)?\s*([A-Za-z]{4})/i,
      category: "mbti",
      importance: 4,
    },
    {
      regex: /(?:나|저)\s*(?:는|가)?\s*([^\n,.!?~]+?)(?:에|에서)?\s*(?:살아|살고\s*있어|거주해)/i,
      category: "location",
      importance: 3,
    },
    {
      regex: /(?:나|저|내|제)\s*(?:직업|일|직장|하는\s*일)(?:은|이)?\s*([^\n,.!?~]+)/i,
      category: "job",
      importance: 4,
    },
    {
      regex: /(?:나|저)\s*(?:요즘|최근에)?\s*([^\n,.!?~]+?)(?:공부|준비|배우고|시작했어)/i,
      category: "study",
      importance: 3,
    },
    {
      regex: /(?:내|나|저|제)\s*(.+?)(?:기억해\s*줘|기억해|저장해\s*줘|외워\s*둬|잊지\s*마)/i,
      category: "custom",
      importance: 5,
    },
  ];

  for (const { regex, category, importance } of patterns) {
    const match = text.match(regex);
    if (match) {
      const summary = text.slice(0, 100);
      // 이미 유사한 기억이 등록되어 있는지 확인
      const existing = await retrieveRelevantMemories(userName, summary, 1);
      if (existing[0] && existing[0].score > 0.8) {
        continue;
      }

      await saveUserMemory({
        userName,
        memory: summary,
        category,
        importance,
      });
      console.log(`[MemoryRAG] 🧠 ${userName}님의 새로운 기억 자동 학습: "${summary}"`);
      break;
    }
  }
};
