// gstack selects repository-relative files. Each package owns its runner and
// working directory; browser specs must never be sent to Vitest.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  { prefix: "apps/server/tests/", pattern: /\.test\.ts$/, package: "@agent-hub/server", command: ["vitest", "run"], files: [] },
  { prefix: "apps/web/tests/", pattern: /\.test\.ts$/, package: "@agent-hub/web", command: ["vitest", "run"], files: [] },
  { prefix: "apps/web/e2e/", pattern: /\.spec\.ts$/, package: "@agent-hub/web", command: ["playwright", "test"], files: [] },
];
const files = [...new Set(process.argv.slice(2))];
if (!files.length) throw new Error("No test files selected");
for (const file of files) {
  const group = groups.find(group => file.startsWith(group.prefix) && group.pattern.test(file));
  if (!group || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsupported test file: ${file}`);
  group.files.push(file.split("/").slice(2).join("/"));
}
function run(args) {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit", timeout: 600000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["--filter", "@agent-hub/contracts", "build"]);
for (const group of groups) {
  if (!group.files.length) continue;
  if (group.package === "@agent-hub/web" && group.prefix.endsWith("e2e/")) run(["build"]);
  run(["--filter", group.package, "exec", ...group.command, ...group.files]);
}
