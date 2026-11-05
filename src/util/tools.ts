import fs from "fs";
import path from "path";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import type { ChatCompletionTool } from "openai/resources/chat/completions/completions.js";
import type { SendableChannels } from "discord.js";
import { getCurrentVoicePreset, leaveAllVoiceChannels } from "./voiceChat.ts";

const execFileAsync = promisify(execFile);

export interface ToolExecutionContext {
  userName: string;
  channel?: SendableChannels | null;
  onRestartRequested?: (reason: string) => void;
}

export interface SelfImprovementJobState {
  id: number;
  engine: "agy" | "hermes";
  instruction: string;
  pid?: number | undefined;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt?: Date;
  exitCode?: number | null;
  lastOutputSnippet: string;
  gitSyncReport?: string;
}

const activeSelfImprovementJobs = new Map<number, SelfImprovementJobState>();
const recentSelfImprovementJobs: SelfImprovementJobState[] = [];
let nextJobId = 1;

/**
 * OpenAI / Ollama Function Calling 규격의 설아 전용 Tool 정의
 */
export const SEOLA_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "인터넷 웹 검색 및 최신 뉴스/정보 검색을 수행합니다. 최신 이슈, 날씨, 인물, 사건, 사실 확인, 검색 요청 시 호출하세요.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "검색할 키워드 또는 질문 (예: '오늘 서울 날씨', '최신 IT 뉴스')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restart_bot",
      description:
        "설아 봇 자신의 Node.js 프로세스를 재시작합니다. 사용자가 '재시작해', '리부팅해', '다시 켜줘'라고 요청할 때 호출하세요.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "재시작 사유",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "self_improve",
      description:
        "Antigravity CLI(agy) 또는 Hermes 에이전트를 호출하여 설아 봇 자신의 소스 코드를 분석·수정·기능 추가(자기개선)합니다. 사용자가 코드 수정, 기능 추가, 버그 수정, 자기개선을 요청할 때만 호출하세요. (단순히 agy가 지금 뭐하는지 상태를 묻는 경우에는 get_self_improve_status를 호출하세요)",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "에이전트에게 전달할 구체적인 코드 수정/자기개선 지시사항",
          },
          engine: {
            type: "string",
            enum: ["agy", "hermes"],
            description:
              "사용할 에이전트 CLI ('agy' = Antigravity CLI, 'hermes' = Hermes CLI). 기본값은 'agy'",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_self_improve_status",
      description:
        "현재 실행 중이거나 최근에 실행된 Antigravity CLI(agy) / Hermes 자기개선 에이전트가 지금 무엇을 하고 있는지 진행 상태와 최근 작업 로그를 확인합니다. 사용자가 'agy 지금 뭐해?', '에이지와이 상태 알려줘', '자기개선 다 됐어?' 등을 물어볼 때 호출하세요.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bot_status",
      description:
        "설아 봇의 현재 프로세스 상태(업타임, 메모리 사용량, PID, 목소리 설정, 자기개선 에이전트 상태, 최근 Git 변경 내역)를 조회합니다.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/**
 * HTML 엔티티 디코딩 및 태그 제거 헬퍼
 */
const stripHtml = (html: string): string => {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * 1. 실시간 웹 검색 (Google News 한국어 RSS + Wikipedia 한국어 API + DuckDuckGo HTML)
 */
export const performWebSearch = async (query: string): Promise<string> => {
  const trimmed = query.trim();
  if (!trimmed) {
    return "검색어가 비어 있습니다.";
  }

  console.log(`[Tools:web_search] 검색 실행: "${trimmed}"`);
  const results: string[] = [];

  // (A) Google News 한국어 RSS 검색 (최신 뉴스 및 실시간 이슈 파악에 강점)
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(trimmed)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(rssUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
      for (const match of items) {
        const itemXml = match[1] || "";
        const title = stripHtml(
          itemXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "",
        );
        const pubDate = stripHtml(
          itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "",
        );
        if (title) {
          results.push(`[뉴스] ${title}${pubDate ? ` (${pubDate})` : ""}`);
        }
      }
    }
  } catch (err) {
    console.warn("[Tools:web_search] Google News RSS 조회 실패:", err);
  }

  // (B) 한국어 위키백과 요약 검색 (인물, 개념, 정보 확인)
  try {
    const wikiUrl = `https://ko.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(trimmed)}&utf8=&format=json&srlimit=3`;
    const res = await fetch(wikiUrl, {
      headers: { "User-Agent": "SeolaDiscordBot/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        query?: { search?: { title: string; snippet: string }[] };
      };
      const items = data.query?.search || [];
      for (const item of items) {
        results.push(`[위키백과: ${item.title}] ${stripHtml(item.snippet)}`);
      }
    }
  } catch (err) {
    console.warn("[Tools:web_search] Wikipedia 조회 실패:", err);
  }

  // (C) DuckDuckGo HTML 검색 결과 추출
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(ddgUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const snippets = [
        ...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g),
      ].slice(0, 4);
      for (const match of snippets) {
        const text = stripHtml(match[1] || "");
        if (text) {
          results.push(`[웹검색] ${text}`);
        }
      }
    }
  } catch (err) {
    console.warn("[Tools:web_search] DuckDuckGo 조회 실패:", err);
  }

  if (results.length === 0) {
    return `'${trimmed}'에 대한 검색 결과를 찾지 못했습니다.`;
  }

  return `검색어 '${trimmed}' 결과:\n` + results.slice(0, 8).join("\n");
};

/**
 * 2. 자기 프로세스 재시작 (tsx watch 환경 및 일반 node 실행 환경 모두 지원)
 */
export const scheduleBotRestart = (reason = "사용자 요청"): string => {
  console.log(`[Tools:restart_bot] 프로세스 재시작 예약됨 (사유: ${reason})`);

  // 응답 메시지가 먼저 전송될 수 있도록 1.5초 후 재시작 트리거
  setTimeout(async () => {
    // 0) 재시작 전 모든 활성 음성 채널에서 안전하게 퇴장
    try {
      await leaveAllVoiceChannels();
    } catch (voiceErr) {
      console.warn("[Tools:restart_bot] 재시작 전 음성 퇴장 실패:", voiceErr);
    }

    try {
      // 1) tsx watch 모드로 실행 중이면 src/index.ts의 타임스탬프를 갱신하여 깔끔하게 핫 리스타트 유도
      const indexPath = path.resolve(process.cwd(), "src", "index.ts");
      if (fs.existsSync(indexPath)) {
        const now = new Date();
        fs.utimesSync(indexPath, now, now);
      }
    } catch (err) {
      console.error("[Tools:restart_bot] 파일 touch 실패:", err);
    }

    // 2) 일반 `node src/index.ts` 실행인 경우 현재 프로세스가 포트(3000)를 완전히 반납한 뒤(1.2초 후) 새 프로세스가 기동되도록 셸 지연 스폰
    setTimeout(() => {
      console.log(
        "[Tools:restart_bot] 현재 프로세스를 종료하고 1.2초 뒤 새 프로세스를 기동합니다.",
      );
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'sleep 1.2 && exec "$@"',
          "sh",
          process.execPath,
          ...process.execArgv,
          ...process.argv.slice(1),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      process.exit(0);
    }, 500);
  }, 1500);

  return `프로세스 재시작이 예약되었습니다 (사유: ${reason}). 약 1~2초 후 재시작됩니다.`;
};

/**
 * 시스템에서 실행 가능한 CLI 바이너리 경로 확인
 */
const resolveCliBinary = async (
  engine: "agy" | "hermes",
): Promise<{ bin: string; actualEngine: "agy" | "hermes"; fallbackNote?: string }> => {
  const candidates =
    engine === "hermes"
      ? [
          process.env.HERMES_BIN,
          "/opt/homebrew/bin/hermes",
          path.join(process.env.HOME || "", ".local/bin/hermes"),
          "hermes",
        ]
      : [
          process.env.AGY_BIN,
          "/opt/homebrew/bin/agy",
          "/usr/local/bin/agy",
          "agy",
        ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith("/") && fs.existsSync(candidate)) {
      return { bin: candidate, actualEngine: engine };
    }
    try {
      const { stdout } = await execFileAsync("which", [candidate]);
      if (stdout.trim()) {
        return { bin: stdout.trim(), actualEngine: engine };
      }
    } catch {
      // 다음 후보 확인
    }
  }

  // hermes를 요청했으나 설치되어 있지 않은 경우 Antigravity CLI(agy)로 자동 폴백
  if (engine === "hermes" && fs.existsSync("/opt/homebrew/bin/agy")) {
    return {
      bin: "/opt/homebrew/bin/agy",
      actualEngine: "agy",
      fallbackNote:
        "시스템에 Hermes CLI가 설치되어 있지 않아 Antigravity CLI(agy)로 대체 실행합니다.",
    };
  }

  throw new Error(
    `${engine} CLI 실행 파일을 찾을 수 없습니다. PATH 또는 설치 상태를 확인해주세요.`,
  );
};

/**
 * 자기개선 작업 완료 후 미커밋/미푸시 변경사항이 남아 있다면 자동으로 git add / commit / push 수행
 */
export const syncChangesToGit = async (
  instruction: string,
): Promise<string> => {
  const cwd = process.cwd();
  try {
    const { stdout: statusOut } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd },
    );

    const hasUncommitted = statusOut.trim().length > 0;
    if (hasUncommitted) {
      await execFileAsync("git", ["add", "-A"], { cwd });
      const summary = instruction.replace(/\s+/g, " ").trim().slice(0, 60);
      const commitMsg = `chore(self-improve): ${summary || "자기개선 변경사항 반영"}`;
      await execFileAsync("git", ["commit", "-m", commitMsg], { cwd });
    }

    // 현재 브랜치의 미푸시 커밋 여부 확인 후 push 실행
    let unpushedCount = 0;
    try {
      const { stdout: countOut } = await execFileAsync(
        "git",
        ["rev-list", "--count", "@{u}..HEAD"],
        { cwd },
      );
      unpushedCount = Number(countOut.trim() || 0);
    } catch {
      // upstream 미설정 시에도 push 시도
      unpushedCount = hasUncommitted ? 1 : 0;
    }

    if (hasUncommitted || unpushedCount > 0) {
      await execFileAsync("git", ["push"], { cwd });
    }

    const { stdout: lastCommit } = await execFileAsync(
      "git",
      ["log", "-1", "--oneline"],
      { cwd },
    );
    return `✅ Git 동기화 완료 (${lastCommit.trim()})`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Tools:self_improve] Git 자동 푸시 중 오류:", message);
    return `⚠️ Git 자동 푸시 실패: ${message.slice(0, 200)}`;
  }
};

/**
 * 3. Antigravity CLI (agy) 또는 Hermes CLI를 호출하여 설아 자신의 코드 수정 / 자기개선 수행
 */
export const runSelfImprovement = async (params: {
  instruction: string;
  engine?: "agy" | "hermes";
  channel?: SendableChannels | null;
}): Promise<string> => {
  const { instruction, engine = "agy", channel } = params;
  const resolved = await resolveCliBinary(engine);

  const fullPrompt = [
    "당신은 디스코드 봇 '설아(Seola)' 프로젝트를 자기개선하는 에이전트입니다.",
    `작업 디렉터리: ${process.cwd()}`,
    `사용자 요청 사항: ${instruction}`,
    "요청 사항을 반영하여 필요한 코드를 안전하게 수정하고, TypeScript 타입 에러(`node ./node_modules/typescript/bin/tsc --noEmit`)가 없는지 확인한 뒤, 변경된 모든 파일을 `git add -A && git commit && git push`로 원격 저장소에 반영하고 변경 사항을 한국어로 간결하게 요약해주세요.",
  ].join("\n");

  const args =
    resolved.actualEngine === "agy"
      ? [
          "-p",
          fullPrompt,
          "--mode",
          "auto",
          "--dangerously-skip-permissions",
        ]
      : [fullPrompt];

  console.log(
    `[Tools:self_improve] ${resolved.actualEngine} 실행 시작: ${resolved.bin} ${args.join(" ")}`,
  );

  // 비동기 백그라운드 태스크로 실행하고 완료 시 자동 Git 푸시 보장 및 디스코드 채널에 결과 보고
  const child = spawn(resolved.bin, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const jobId = nextJobId++;
  const jobState: SelfImprovementJobState = {
    id: jobId,
    engine: resolved.actualEngine,
    instruction,
    pid: child.pid,
    status: "running",
    startedAt: new Date(),
    lastOutputSnippet: "에이전트 프로세스 시작됨 (코드 분석 중...)",
  };
  activeSelfImprovementJobs.set(jobId, jobState);

  let stdout = "";
  let stderr = "";

  const updateSnippet = () => {
    const combined = (stdout.trim() || stderr.trim()).replace(/\s+/g, " ");
    if (combined) {
      jobState.lastOutputSnippet = combined.slice(-300);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    updateSnippet();
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    updateSnippet();
  });

  child.on("close", async (code) => {
    console.log(`[Tools:self_improve] ${resolved.actualEngine} 종료 (code=${code})`);

    let gitSyncReport = "";
    if (code === 0) {
      gitSyncReport = await syncChangesToGit(instruction);
    }

    jobState.status = code === 0 ? "completed" : "failed";
    jobState.finishedAt = new Date();
    jobState.exitCode = code;
    if (gitSyncReport) {
      jobState.gitSyncReport = gitSyncReport;
    }
    updateSnippet();

    activeSelfImprovementJobs.delete(jobId);
    recentSelfImprovementJobs.unshift(jobState);
    if (recentSelfImprovementJobs.length > 5) {
      recentSelfImprovementJobs.pop();
    }

    if (!channel) return;

    const rawOutput = (stdout.trim() || stderr.trim() || "(출력 없음)").slice(
      -1500,
    );
    const statusHeader =
      code === 0
        ? `✨ **자기개선 완료 (${resolved.actualEngine}, 작업 #${jobId})**`
        : `⚠️ **자기개선 작업 종료 (코드: ${code}, 엔진: ${resolved.actualEngine}, 작업 #${jobId})**`;

    const lines = [
      statusHeader,
      `> **요청**: ${instruction}`,
      ...(gitSyncReport ? [`> **Git**: ${gitSyncReport}`] : []),
      `\`\`\`\n${rawOutput}\n\`\`\``,
    ];

    await channel
      .send(lines.join("\n"))
      .catch((err) =>
        console.error("[Tools:self_improve] 결과 메시지 전송 실패:", err),
      );
  });

  return [
    resolved.fallbackNote ? `(${resolved.fallbackNote})` : "",
    `${resolved.actualEngine} 에이전트에 자기개선 작업(#${jobId})을 요청했습니다 (요청: "${instruction}").`,
    "백그라운드에서 코드 수정 및 Git 자동 푸시까지 진행하며, 작업 중에는 언제든 '설아야 agy 지금 뭐해?'라고 물어보시면 진행 상황을 알려드릴게요!",
  ]
    .filter(Boolean)
    .join(" ");
};

/**
 * 로컬 Antigravity CLI (~/.gemini/antigravity-cli/brain) 트랜스크립트에서 가장 최근 세션의 작업 내역 추출
 */
const inspectLatestAgyTranscript = (): string | null => {
  try {
    const homeDir = process.env.HOME || "";
    const brainDir = path.join(homeDir, ".gemini", "antigravity-cli", "brain");
    if (!fs.existsSync(brainDir)) return null;

    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let latestTranscriptPath: string | null = null;
    let latestMtimeMs = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(
        brainDir,
        entry.name,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate);
        if (stat.mtimeMs > latestMtimeMs) {
          latestMtimeMs = stat.mtimeMs;
          latestTranscriptPath = candidate;
        }
      }
    }

    if (!latestTranscriptPath) return null;

    const content = fs.readFileSync(latestTranscriptPath, "utf-8");
    const lines = content.trim().split("\n").slice(-30);

    let lastUserRequest = "";
    const recentActions: string[] = [];
    let lastModelStatus = "";

    for (const line of lines) {
      try {
        const step = JSON.parse(line) as {
          type?: string;
          status?: string;
          content?: string;
          tool_calls?: { name?: string; args?: Record<string, string> }[];
        };

        if (step.type === "USER_INPUT" && step.content) {
          const match = step.content.match(
            /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/,
          );
          const extracted = (match?.[1] || step.content).trim();
          if (extracted) {
            lastUserRequest = extracted.replace(/\s+/g, " ").slice(0, 120);
          }
        }

        if (step.type === "PLANNER_RESPONSE") {
          lastModelStatus = step.status || "";
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              const toolName = tc.name || "tool";
              const summary =
                tc.args?.["toolSummary"] ||
                tc.args?.["Path"] ||
                tc.args?.["CommandLine"] ||
                "";
              const cleanSummary = summary.replace(/^"|"$/g, "").slice(0, 80);
              recentActions.push(
                cleanSummary ? `${toolName}(${cleanSummary})` : toolName,
              );
            }
          }
        }
      } catch {
        // 개별 JSON 파싱 실패 무시
      }
    }

    const elapsedSec = Math.max(
      0,
      Math.floor((Date.now() - latestMtimeMs) / 1000),
    );
    const timeAgo =
      elapsedSec < 60
        ? `${elapsedSec}초 전 갱신`
        : `${Math.floor(elapsedSec / 60)}분 전 갱신`;

    const summaryLines = [
      `[Antigravity CLI 최근 세션 활동 (${timeAgo}, 상태: ${lastModelStatus || "진행 중"})]`,
    ];
    if (lastUserRequest) {
      summaryLines.push(`- 현재 목표/요청: "${lastUserRequest}"`);
    }
    if (recentActions.length > 0) {
      summaryLines.push(
        `- 최근 수행 도구: ${recentActions.slice(-4).join(" → ")}`,
      );
    }
    return summaryLines.join("\n");
  } catch {
    return null;
  }
};

/**
 * 4. Antigravity CLI (agy) / Hermes 자기개선 에이전트 현재 작업 상태 조회
 */
export const getSelfImproveStatusReport = async (): Promise<string> => {
  const sections: string[] = [];

  // (1) 설아 봇 내부에서 실행 중인 자기개선 작업 확인
  if (activeSelfImprovementJobs.size > 0) {
    const runningLines: string[] = ["🔄 [현재 실행 중인 자기개선 작업]"];
    for (const job of activeSelfImprovementJobs.values()) {
      const elapsedSec = Math.floor(
        (Date.now() - job.startedAt.getTime()) / 1000,
      );
      runningLines.push(
        `- 작업 #${job.id} (${job.engine}, PID: ${job.pid ?? "N/A"}, ${elapsedSec}초 경과)`,
        `  · 지시사항: "${job.instruction}"`,
        `  · 최근 출력: ${job.lastOutputSnippet}`,
      );
    }
    sections.push(runningLines.join("\n"));
  } else {
    sections.push(
      "ℹ️ 현재 설아 봇이 직접 백그라운드로 실행 중인 자기개선 작업은 없습니다.",
    );
  }

  // (2) 최근 완료/종료된 자기개선 작업 이력 확인
  if (recentSelfImprovementJobs.length > 0) {
    const latest = recentSelfImprovementJobs[0]!;
    const durationSec = latest.finishedAt
      ? Math.floor(
          (latest.finishedAt.getTime() - latest.startedAt.getTime()) / 1000,
        )
      : 0;
    sections.push(
      [
        `✅ [가장 최근 완료된 자기개선 작업 (#${latest.id})]`,
        `- 상태: ${latest.status === "completed" ? "성공" : `실패(코드 ${latest.exitCode})`} (${durationSec}초 소요)`,
        `- 지시사항: "${latest.instruction}"`,
        ...(latest.gitSyncReport ? [`- Git 동기화: ${latest.gitSyncReport}`] : []),
        `- 결과 요약: ${latest.lastOutputSnippet}`,
      ].join("\n"),
    );
  }

  // (3) 로컬 Antigravity CLI (agy) 트랜스크립트 기반 실시간 활동 내역
  const transcriptReport = inspectLatestAgyTranscript();
  if (transcriptReport) {
    sections.push(transcriptReport);
  }

  // (4) 작업 디렉터리 실시간 Git 변경 파일 확인
  try {
    const { stdout: gitStatus } = await execFileAsync("git", ["status", "-s"], {
      cwd: process.cwd(),
    });
    const { stdout: gitLastCommit } = await execFileAsync(
      "git",
      ["log", "-1", "--oneline"],
      { cwd: process.cwd() },
    );
    sections.push(
      [
        `📂 [프로젝트 코드 변경 상태]`,
        `- 현재 수정 중인 파일: ${gitStatus.trim() ? gitStatus.trim().replace(/\n/g, ", ") : "없음 (모두 커밋됨)"}`,
        `- 최근 커밋: ${gitLastCommit.trim() || "없음"}`,
      ].join("\n"),
    );
  } catch {
    // Git 조회 실패 시 생략
  }

  return sections.join("\n\n");
};

/**
 * 4. 봇 상태 조회
 */
export const getBotStatusReport = async (): Promise<string> => {
  const uptimeSec = Math.floor(process.uptime());
  const mins = Math.floor(uptimeSec / 60);
  const secs = uptimeSec % 60;
  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const voicePreset = getCurrentVoicePreset();

  let gitInfo = "";
  try {
    const { stdout } = await execFileAsync("git", ["status", "-s"], {
      cwd: process.cwd(),
    });
    gitInfo = stdout.trim() || "변경사항 없음 (Clean)";
  } catch {
    gitInfo = "조회 불가";
  }

  return [
    `- 프로세스 PID: ${process.pid}`,
    `- 실행 시간(Uptime): ${mins}분 ${secs}초`,
    `- 메모리 사용량(RSS): ${memMb} MB`,
    `- 현재 TTS 목소리: ${voicePreset.label} (${voicePreset.id})`,
    `- 실행 중인 자기개선(agy/hermes) 작업 수: ${activeSelfImprovementJobs.size}개`,
    `- 작업 디렉터리 Git 상태: ${gitInfo}`,
  ].join("\n");
};

/**
 * Tool 이름과 인자를 받아 실제 함수를 실행하는 디스패처
 */
export const executeSeolaTool = async (
  toolName: string,
  rawArgs: string | Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> => {
  let parsedArgs: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      parsedArgs = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      parsedArgs = {};
    }
  } else {
    parsedArgs = rawArgs;
  }

  switch (toolName) {
    case "web_search": {
      const query = String(parsedArgs["query"] || "").trim();
      return await performWebSearch(query);
    }

    case "restart_bot": {
      const reason = String(parsedArgs["reason"] || "사용자 대화 요청");
      context.onRestartRequested?.(reason);
      return scheduleBotRestart(reason);
    }

    case "self_improve": {
      const instruction = String(parsedArgs["instruction"] || "").trim();
      if (!instruction) {
        return "자기개선 지시사항(instruction)이 비어 있습니다.";
      }
      const engine =
        parsedArgs["engine"] === "hermes" ? "hermes" : ("agy" as const);
      return await runSelfImprovement({
        instruction,
        engine,
        ...(context.channel !== undefined ? { channel: context.channel } : {}),
      });
    }

    case "get_self_improve_status": {
      return await getSelfImproveStatusReport();
    }

    case "get_bot_status": {
      return await getBotStatusReport();
    }

    default:
      return `알 수 없는 도구입니다: ${toolName}`;
  }
};

/**
 * Function Calling을 지원하지 않는 로컬 LLM 모델을 위한 자연어 의도 기반 폴백 감지기
 */
export const detectFallbackToolIntent = (
  message: string,
): {
  name:
    | "web_search"
    | "restart_bot"
    | "self_improve"
    | "get_self_improve_status"
    | "get_bot_status";
  args: Record<string, unknown>;
} | null => {
  const text = message.trim();

  // 1. 재시작 요청 감지 (STT 오인식 '제시작', '되시작', '브로스에서' 포함)
  if (
    /(?:프로세스|브로스에서|봇|서버|시스템)?\s*(?:재시작|제시작|되시작|리부팅|리스타트|다시\s*켜|껐다\s*켜)\s*(?:해\s*줘|해|줄래|하자)?/i.test(
      text,
    )
  ) {
    return {
      name: "restart_bot",
      args: { reason: text },
    };
  }

  // 2. 자기개선(agy / hermes) 현재 작업/진행 상태 질문 감지 (자기개선 실행보다 먼저 체크)
  //    (Whisper STT에서 agy가 'aji', 'azi', '에이지와이', '아지', '애지', '에이자이' 등으로 오인식되는 경우도 포함)
  if (
    /(?:agy|aji|azi|antigravity|안티그래비티|에이지와이|에이지아이|아지|애지|에지|hermes|헤르메스|자기\s*개선|코드\s*수정|작업)/i.test(
      text,
    ) &&
    /(?:지금\s*뭐|무슨\s*작업|무슨\s*일|뭐\s*하고|뭐\s*해|뭐\s*하냐|상태|진행\s*상황|어디까지|다\s*됐|끝났|중이야|하고\s*있어)/i.test(
      text,
    )
  ) {
    return {
      name: "get_self_improve_status",
      args: {},
    };
  }

  // 3. 자기개선 (agy / hermes / 코드 수정) 실행 요청 감지
  if (
    /(?:agy|aji|azi|antigravity|안티그래비티|에이지와이|에이지아이|아지|애지|hermes|헤르메스|자기\s*개선|스스로\s*개선|내\s*코드\s*수정|네\s*코드\s*수정|봇\s*코드\s*수정|기능\s*추가해|(?:stt|tts)\s*성능\s*(?:좀\s*)?개선)/i.test(
      text,
    )
  ) {
    const engine = /hermes|헤르메스/i.test(text) ? "hermes" : "agy";
    return {
      name: "self_improve",
      args: { instruction: text, engine },
    };
  }

  // 4. 검색 요청 감지 ("~ 검색해줘", "~ 찾아봐줘")
  const searchMatch = text.match(
    /^(.+?)\s*(?:검색해\s*줘|검색해\s*봐|검색해|찾아봐\s*줘|찾아줘|알아봐\s*줘)$/i,
  );
  if (searchMatch?.[1]) {
    return {
      name: "web_search",
      args: { query: searchMatch[1].trim() },
    };
  }

  // 5. 상태 확인 요청 감지
  if (
    /^(?:현재\s*)?(?:봇\s*상태|시스템\s*상태|메모리\s*상태|프로세스\s*상태|상태\s*확인)\s*(?:알려줘|보여줘|어때)?\??$/i.test(
      text,
    )
  ) {
    return {
      name: "get_bot_status",
      args: {},
    };
  }

  return null;
};
