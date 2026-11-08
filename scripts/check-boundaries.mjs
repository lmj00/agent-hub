// Structural checks for authored source imports; this is not a runtime sandbox.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
const modules = "apps/server/src/modules/";
const goalOperations = new Set([
  "goal-execution-store",
  "goal-plan-policy",
  "prepared-input-store",
  "planning-store",
  "plan-application",
  "planning-cancellation",
  "revalidate-goal-work",
  "development-journal",
  "change-application",
  "goal-verification",
]);
const executionOperations = new Set([
  "analysis",
  "analysis-workflow",
  "development-workflow",
  "verification-config",
  "run-task",
  "execution-owner",
  "execution-record-store",
  "runtime-skill-store",
  "workflow-step-store",
  "retry-policy",
  "retry-state-store",
]);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
function violation(source, target, specifier) {
  if (source.startsWith("packages/contracts/src/")) {
    if (target.startsWith("apps/") || specifier.startsWith("@agent-hub/"))
      return "contracts must not depend on applications";
    if (!source.endsWith("/index.ts") && target === "packages/contracts/src/index.js")
      return "contracts internals must not import the public barrel";
  }
  if (source.startsWith("apps/web/src/")) {
    if (target.startsWith("apps/server/") || specifier.startsWith("@agent-hub/server"))
      return "web must not import server implementation";
    if (
      source.startsWith("apps/web/src/shared/") &&
      target.startsWith("apps/web/src/") &&
      !target.startsWith("apps/web/src/shared/")
    )
      return "shared web code must not depend on features";
  }
  if (
    source.startsWith("apps/server/src/shared/") &&
    target.startsWith("apps/server/src/") &&
    !target.startsWith("apps/server/src/shared/")
  )
    return "shared server code must not depend on features";
  if (
    source.startsWith(modules + "workspace/") &&
    target.startsWith("apps/server/src/") &&
    !target.startsWith(modules + "workspace/") &&
    !target.startsWith("apps/server/src/shared/")
  )
    return "workspace must not depend on goal, execution or DB orchestration";
  for (const [from, to, allowed] of [
    ["goals", "execution", executionOperations],
    ["execution", "goals", goalOperations],
  ]) {
    if (source.startsWith(modules + from + "/") && target.startsWith(modules + to + "/")) {
      const name = target.slice((modules + to + "/").length).replace(/\.(?:js|ts)$/, "");
      if (!allowed.has(name)) return `${from} must use documented ${to} operations`;
    }
  }
  return null;
}

const failures = [];
let count = 0;
for (const directory of ["apps/server/src", "apps/web/src", "packages/contracts/src"]) {
  for (const path of files(join(root, directory))) {
    count++;
    const source = relative(root, path).replaceAll("\\", "/");
    // Include type imports, re-exports, side-effect imports and literal dynamic imports.
    const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const imports = text.matchAll(
      /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"']+)["']/g,
    );
    for (const match of imports) {
      const specifier = match[1];
      const target = specifier.startsWith(".")
        ? relative(root, resolve(dirname(path), specifier)).replaceAll("\\", "/")
        : specifier;
      const reason = violation(source, target, specifier);
      if (reason) failures.push(`${source} -> ${specifier}: ${reason}`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`Module boundaries passed (${count} source files)`);
