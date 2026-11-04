import { pgTable, bigint, varchar, text, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const contexts = pgTable("contexts", {
	id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
	name: varchar({ length: 100 }).notNull(),
	context: text().notNull(),
});

export const userModels = pgTable("user_models", {
	name: varchar({ length: 255 }).primaryKey(),
	model: varchar({ length: 255 }).notNull(),
});
