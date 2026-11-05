import { drizzle } from "drizzle-orm/node-postgres";
import CONFIG from "../config/index.ts";

/**
 * 전역 단일 PostgreSQL 데이터베이스 연결 인스턴스
 * 다중 인스턴스 생성으로 인한 연결 풀 낭비를 방지하고 애플리케이션 전체에서 공유합니다.
 */
export const db = drizzle(CONFIG.DATABASE_URL);

export * from "./schema.ts";
export default db;
