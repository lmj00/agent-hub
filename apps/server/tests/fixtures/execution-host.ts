import { createContainerExecutor } from "../../src/modules/execution/execution-process.js";
const [image, home, workspace, runId] = process.argv.slice(2) as [string, string, string, string];
await createContainerExecutor(image, home).analyze({
  instruction: "wait", model: "fixture", workspace, runId, signal: new AbortController().signal,
}, event => process.send?.(event));
