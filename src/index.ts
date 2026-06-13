import { Client, GatewayIntentBits } from "discord.js";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = 3000;

// 1. 디스코드 봇 클라이언트 설정
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 반드시 활성화 필요
  ],
});

// 2. 프리픽스 명령어 처리
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (message.content.startsWith("!text")) {
    message.reply("응답 성공!");
  }
  if (message.content.startsWith("!love")) {
    message.reply("사랑해");
  }
});

// 3. Express 서버 실행
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(port, () => console.log(`Server running on port ${port}`));

// 4. 봇 로그인
client.login(process.env.DISCORD_TOKEN);
