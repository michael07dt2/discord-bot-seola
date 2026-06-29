# 웰컴

ㅇ

- npx drizzle-kit pull --init 디비 동기화

```sql
CREATE TABLE "contexts" (
 "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
 "name" varchar(100) NOT NULL,
 "context" text NOT NULL,
);
```
