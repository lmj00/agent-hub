import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { executionOwner } from "../../db/schema.js";

export function assertExecutionOwner(db: Pick<ReturnType<typeof openDatabase>["db"], "select">, ownerToken?: string) {
  const owner = db.select().from(executionOwner).get();
  if (ownerToken ? owner?.token !== ownerToken : owner !== undefined) {
    throw new Error("Execution ownership has changed or belongs to another process");
  }
}

// 존재 여부만 확인합니다. PID 일치를 같은 실행의 증거로 삼거나 다른 프로세스를 종료하지 않습니다.
function processMayExist(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function acquireExecutionOwner(
  db: ReturnType<typeof openDatabase>["db"],
  processInfo = { hostname: hostname(), pid: process.pid, mayExist: processMayExist },
) {
  const token = randomUUID();
  db.transaction((tx) => {
    const previous = tx.select().from(executionOwner).get();
    if (previous && (previous.hostname !== processInfo.hostname || processInfo.mayExist(previous.pid))) {
      throw new Error("An execution process already owns this database, or its termination cannot be confirmed");
    }
    // 부모 프로세스가 없어도 Run은 유지합니다. 자식의 종료가 불명확하면 신규 실행은 계속 보류합니다.
    tx.insert(executionOwner).values({ slot: 1, token, hostname: processInfo.hostname, pid: processInfo.pid })
      .onConflictDoUpdate({ target: executionOwner.slot, set: { token, hostname: processInfo.hostname, pid: processInfo.pid } }).run();
  }, { behavior: "immediate" });
  return {
    token,
    release() {
      db.delete(executionOwner).where(and(eq(executionOwner.slot, 1), eq(executionOwner.token, token))).run();
    },
  };
}
