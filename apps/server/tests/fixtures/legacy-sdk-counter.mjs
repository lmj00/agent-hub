import { appendFileSync } from "node:fs";
export function createCodexExecutor() {
  return {
    async analyze() {
      appendFileSync("/codex-home/sdk-calls", "called\n");
      return { output: "Legacy SDK boundary reached", usage: null };
    },
  };
}
