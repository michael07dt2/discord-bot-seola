import fs from "fs";
import path from "path";

const PID_FILE = path.resolve(process.cwd(), ".seola-bot.pid");

/**
 * 특정 PID의 프로세스가 현재 OS 상에서 실제로 살아있는지 확인
 */
export const isProcessRunning = (pid: number): boolean => {
  try {
    // signal 0은 실제로 시그널을 보내지 않고 프로세스 존재 여부와 권한만 확인
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM은 프로세스가 존재하지만 권한이 다른 경우(여전히 실행 중임)
    return err.code === "EPERM";
  }
};

/**
 * 봇 실행 시 이미 실행 중인 프로세스가 있는지 검사하고 PID 락을 획득
 * - 이미 실행 중인 경우: 콘솔에 안내 후 중복 실행 방지를 위해 종료 (단, 강제 재시작 플래그가 있으면 기존 프로세스 종료)
 */
export const checkAndAcquireProcessLock = (options?: {
  killExisting?: boolean;
}): { success: boolean; pid: number } => {
  const currentPid = process.pid;
  const shouldKillExisting =
    options?.killExisting ||
    process.argv.includes("--force") ||
    process.argv.includes("--restart") ||
    process.env.AUTO_KILL_EXISTING === "true" ||
    process.env.RESTARTING === "true";

  if (fs.existsSync(PID_FILE)) {
    try {
      const content = fs.readFileSync(PID_FILE, "utf-8").trim();
      const existingPid = parseInt(content, 10);

      if (!Number.isNaN(existingPid) && existingPid !== currentPid) {
        if (isProcessRunning(existingPid)) {
          if (shouldKillExisting) {
            console.log(
              `[ProcessLock] 🔄 기존에 실행 중이던 프로세스(PID: ${existingPid})를 감지했습니다. 종료를 요청합니다...`,
            );
            try {
              process.kill(existingPid, "SIGTERM");
              // 1.5초 정도 프로세스 종료 대기
              let waitedMs = 0;
              while (isProcessRunning(existingPid) && waitedMs < 2000) {
                const start = Date.now();
                while (Date.now() - start < 100) {} // busy wait short period
                waitedMs += 100;
              }
              if (isProcessRunning(existingPid)) {
                process.kill(existingPid, "SIGKILL");
              }
              console.log(
                `[ProcessLock] ✅ 기존 프로세스(PID: ${existingPid})가 안전하게 종료되었습니다.`,
              );
            } catch (killErr) {
              console.warn(
                `[ProcessLock] 기존 프로세스 종료 중 예외 발생:`,
                killErr,
              );
            }
          } else {
            console.error(
              `\n❌ [ProcessLock] 오류: 이미 Seola 봇 프로세스가 실행 중입니다! (PID: ${existingPid})`,
            );
            console.error(
              `[ProcessLock] 중복 실행으로 인한 포트 충돌 및 디스코드 세션 유실을 방지하기 위해 기동을 중단합니다.`,
            );
            console.error(
              `[ProcessLock] 기존 프로세스를 재시작하려면 '--restart' 플래그를 붙이거나 기존 PID를 종료해주세요.\n`,
            );
            return { success: false, pid: existingPid };
          }
        } else {
          console.log(
            `[ProcessLock] ℹ️ 이전 비정상 종료된 찌꺼기 PID(${existingPid})를 감지하여 정리합니다.`,
          );
        }
      }
    } catch (readErr) {
      console.warn("[ProcessLock] PID 파일 읽기 오류:", readErr);
    }
  }

  // 현재 PID를 파일에 기록
  try {
    fs.writeFileSync(PID_FILE, String(currentPid), "utf-8");
    console.log(`[ProcessLock] 🔒 단일 인스턴스 락 획득 완료 (PID: ${currentPid})`);
  } catch (err) {
    console.error("[ProcessLock] PID 파일 기록 실패:", err);
  }

  return { success: true, pid: currentPid };
};

/**
 * 프로세스 종료 시 PID 파일 삭제
 */
export const releaseProcessLock = (): void => {
  try {
    if (fs.existsSync(PID_FILE)) {
      const content = fs.readFileSync(PID_FILE, "utf-8").trim();
      const filePid = parseInt(content, 10);
      // 내가 생성한 파일일 때만 삭제
      if (filePid === process.pid) {
        fs.unlinkSync(PID_FILE);
        console.log(`[ProcessLock] 🔓 단일 인스턴스 락 해제 완료 (PID: ${process.pid})`);
      }
    }
  } catch (err) {
    // 무시
  }
};
