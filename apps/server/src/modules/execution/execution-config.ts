import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function loadExecutionConfig(file: string) {
  const configPath = resolve(file);
  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution config must be an object");
  const config = value as Record<string, unknown>;
  if (typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.model)) throw new Error("An explicit model is required");
  if (typeof config.codexHome !== "string" || !config.codexHome.trim()) throw new Error("codexHome is required");
  const codexHome = realpathSync(resolve(dirname(configPath), config.codexHome));
  const prohibited = ["config.toml", "AGENTS.md", ".agents", "plugins", "rules", "hooks.json"];
  // Codex는 첫 실행에 기본 스킬을 skills/.system에 설치합니다. 이 생성물은 허용하되 사용자 스킬은 거부합니다.
  const skillsPath = resolve(codexHome, "skills");
  const hasUserSkills = existsSync(skillsPath) && readdirSync(skillsPath).some(name => name !== ".system");
  if (hasUserSkills || readdirSync(codexHome).some(name => prohibited.includes(name) || name.endsWith(".config.toml"))) {
    throw new Error("Use a dedicated Codex home with ChatGPT login only; user config, skills, plugins and hooks are not supported yet");
  }
  const auth: unknown = JSON.parse(readFileSync(resolve(codexHome, "auth.json"), "utf8"));
  if (!auth || typeof auth !== "object" || !("auth_mode" in auth) || auth.auth_mode !== "chatgpt") {
    throw new Error("Log in with ChatGPT in the dedicated Codex home first");
  }
  const timeoutMs = config.timeoutMs ?? 300000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) {
    throw new Error("timeoutMs must be an integer between 1000 and 1800000");
  }
  if (!config.workspaces || typeof config.workspaces !== "object" || Array.isArray(config.workspaces)) throw new Error("workspaces must map keys to prepared directories");
  const workspaces = new Map<string, string>();
  for (const [key, path] of Object.entries(config.workspaces)) {
    if (typeof path !== "string" || !path.trim()) throw new Error("Workspace paths must be non-empty strings");
    const workspace = realpathSync(resolve(dirname(configPath), path));
    if (!statSync(workspace).isDirectory() || dirname(workspace) === workspace || isWithin(workspace, codexHome)) {
      throw new Error("Workspace must be a prepared directory separate from authentication storage");
    }
    // 프로젝트 설정이 실행 정책을 덮어쓰지 않도록 확인합니다.
    for (let parent = workspace; ; parent = dirname(parent)) {
      if (existsSync(resolve(parent, ".codex", "config.toml"))) throw new Error("Prepared workspace must not inherit project Codex config");
      if (existsSync(resolve(parent, ".git"))) break;
      if (parent === dirname(parent)) break;
    }
    workspaces.set(key, workspace);
  }
  return { model: config.model, codexHome, timeoutMs, workspaces };
}
