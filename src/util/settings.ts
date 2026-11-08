import { eq, sql } from "drizzle-orm";
import { db, botSettingsTable } from "../db/index.ts";

let isTableInitialized = false;

/**
 * bot_settings 테이블이 없으면 자동으로 생성
 */
export const ensureBotSettingsTable = async (): Promise<void> => {
  if (isTableInitialized) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "bot_settings" (
        "key" varchar(128) PRIMARY KEY,
        "value" text NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT NOW()
      );
    `);
    isTableInitialized = true;
  } catch (error) {
    console.error("[Settings] bot_settings 테이블 초기화 오류:", error);
  }
};

/**
 * DB에서 특정 설정값 조회
 */
export const getBotSetting = async (
  key: string,
  defaultValue?: string,
): Promise<string | undefined> => {
  try {
    await ensureBotSettingsTable();
    const rows = await db
      .select()
      .from(botSettingsTable)
      .where(eq(botSettingsTable.key, key));

    if (rows[0]) {
      return rows[0].value;
    }
  } catch (error) {
    console.error(`[Settings] 설정 조회 오류 (key: ${key}):`, error);
  }
  return defaultValue;
};

/**
 * DB에 설정값 저장 (Upsert)
 */
export const setBotSetting = async (
  key: string,
  value: string,
): Promise<void> => {
  try {
    await ensureBotSettingsTable();
    await db
      .insert(botSettingsTable)
      .values({
        key,
        value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: botSettingsTable.key,
        set: {
          value,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error(`[Settings] 설정 저장 오류 (key: ${key}, val: ${value}):`, error);
  }
};
