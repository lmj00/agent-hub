import { spawn } from "node:child_process";
import { gitEnv, gitOptions, type SourceGit } from "../workspace/workspace-git.js";

// The shell waits for a parent acknowledgement before exec. Its PID is preserved
// by exec, so Git cannot start until that exact PID has been durably registered.
const startGate = 'IFS= read -r gate && [ "$gate" = start ] && exec "$@"';
export function createImportGit(lifecycle: {
  started(pid: number): void;
  closed(pid: number): void;
}): SourceGit {
  return async (source, args, signal) => {
    signal.throwIfAborted();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        "/bin/sh",
        ["-c", startGate, "agent-hub-import-git", "git", ...gitOptions, ...args],
        {
          cwd: source,
          env: gitEnv,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let failed = false,
        registered = false,
        bytes = 0;
      const output: Buffer[] = [];
      const stop = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, 5000);
      child.on("error", () => {
        failed = true;
      });
      child.stdin.on("error", stop);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 9 * 1048576) stop();
        else output.push(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        try {
          if (registered) lifecycle.closed(child.pid!);
          if (failed || code !== 0 || signal.aborted)
            reject(new Error("Unable to prepare imported Git source"));
          else resolve(Buffer.concat(output));
        } catch {
          reject(new Error("Unable to record imported Git termination"));
        }
      });
      signal.addEventListener("abort", stop, { once: true });
      try {
        if (!child.pid) return;
        lifecycle.started(child.pid);
        registered = true;
        signal.throwIfAborted();
        child.stdin.end("start\n");
      } catch {
        stop();
      }
    });
  };
}
