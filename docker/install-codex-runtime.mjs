import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The SDK's pnpm path lives under /app, which the model's filesystem policy hides.
// Keep the complete pinned native package in the readable system runtime instead.
const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
const cliRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
const target = { arm64: "aarch64", x64: "x86_64" }[process.arch];
if (process.platform !== "linux" || !target) throw new Error("Unsupported container architecture");
const nativePackage = cliRequire.resolve(`@openai/codex-linux-${process.arch}/package.json`);
cpSync(join(dirname(nativePackage), "vendor", `${target}-unknown-linux-musl`), "/usr/local/lib/codex", { recursive: true });
