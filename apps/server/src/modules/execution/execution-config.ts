import { isWithin } from "../../shared/path-containment.js";
import { parseEffortPolicy } from "./effort-policy.js";
import { parseVerificationWorkspaces, validContainerImage } from "./verification-config.js";
import { parseAnalysisWorkflow } from "./analysis-workflow.js";
import { parseCapacityPolicy } from "./capacity-policy.js";
import { parseRetryPolicy } from "./retry-policy.js";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const executionConfigErrors = {
  AUTH_DIRECTORY_CHANGED: "Authentication directory changed; restart with reviewed configuration",
  WORKSPACE_CHANGED: "Workspace directory changed; restart with reviewed configuration",
  DATABASE_IN_WORKSPACE: "Application database must be outside the analysis workspace",
  SERVER_SECRET_IN_WORKSPACE: "Private server configuration must be outside the analysis workspace",
  CODEX_CONFIG_NOT_ALLOWED:
    "Use a dedicated Codex home with ChatGPT login only; user config, skills, plugins and hooks are not supported yet",
  CHATGPT_LOGIN_REQUIRED: "Log in with ChatGPT in the dedicated Codex home first",
  WORKSPACE_NOT_ALLOWED:
    "Workspace must be a prepared directory separate from authentication storage",
  PROJECT_CONFIG_NOT_ALLOWED: "Prepared workspace must not inherit project Codex config",
} as const;

export class ExecutionConfigError extends Error {
  constructor(public readonly code: keyof typeof executionConfigErrors) {
    super(executionConfigErrors[code]);
  }
}

export function loadExecutionConfig(file: string) {
  const configPath = resolve(file);
  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Execution config must be an object");
  const config = value as Record<string, unknown>;
  if (typeof config.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.model))
    throw new Error("An explicit model is required");
  if (typeof config.codexHome !== "string" || !config.codexHome.trim())
    throw new Error("codexHome is required");
  const codexHome = realpathSync(resolve(dirname(configPath), config.codexHome));
  validateCodexHome(codexHome);
  const timeoutMs = config.timeoutMs ?? 300000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 1800000
  ) {
    throw new Error("timeoutMs must be an integer between 1000 and 1800000");
  }
  if (
    !config.workspaces ||
    typeof config.workspaces !== "object" ||
    Array.isArray(config.workspaces)
  )
    throw new Error("workspaces must map keys to prepared directories");
  const workspaces = new Map<string, string>();
  for (const [key, path] of Object.entries(config.workspaces)) {
    if (typeof path !== "string" || !path.trim())
      throw new Error("Workspace paths must be non-empty strings");
    const workspace = realpathSync(resolve(dirname(configPath), path));
    validateWorkspace(workspace, codexHome);
    workspaces.set(key, workspace);
  }
  const containerImage = config.containerImage;
  if (containerImage !== undefined && !validContainerImage(containerImage)) {
    throw new Error("containerImage must be a local Docker image reference");
  }
  const automaticRecovery =
    config.automaticRecovery === undefined ? undefined : parseRetryPolicy(config.automaticRecovery);
  const verification =
    config.verification === undefined
      ? undefined
      : parseVerificationWorkspaces(config.verification, workspaces.keys());
  if (verification && !containerImage) throw new Error("Verification requires container execution");
  const capacity = automaticRecovery
    ? (config.automaticRecovery as Record<string, unknown>).capacity
    : false;
  return {
    model: config.model,
    codexHome,
    timeoutMs,
    workspaces,
    ...(verification ? { verification } : {}),
    ...(config.analysisWorkflow !== undefined
      ? { analysisWorkflow: parseAnalysisWorkflow(config.analysisWorkflow) }
      : {}),
    ...(config.effortPolicy !== undefined
      ? { effortPolicy: parseEffortPolicy(config.effortPolicy) }
      : {}),
    ...(automaticRecovery
      ? {
          automaticRecovery,
          ...(capacity === false
            ? {}
            : { capacityRecovery: parseCapacityPolicy(capacity === undefined ? {} : capacity) }),
        }
      : {}),
    ...(containerImage ? { containerImage: containerImage as string } : {}),
  };
}

export type ExecutionConfig = ReturnType<typeof loadExecutionConfig>;

// 오래 켜둔 서버에서도 호출 직전의 인증·폴더 상태를 다시 확인합니다. 설정 값 변경은 재시작 시 적용합니다.
export function validateExecutionEnvironment(
  config: ExecutionConfig,
  databasePath: string,
  protectedFiles: string[] = [],
) {
  const currentHome = realpathSync(config.codexHome);
  if (currentHome !== config.codexHome) throw new ExecutionConfigError("AUTH_DIRECTORY_CHANGED");
  validateCodexHome(config.codexHome);
  const database = realpathSync(databasePath);
  for (const workspace of config.workspaces.values()) {
    if (realpathSync(workspace) !== workspace) throw new ExecutionConfigError("WORKSPACE_CHANGED");
    validateWorkspace(workspace, config.codexHome);
    if (isWithin(workspace, database)) throw new ExecutionConfigError("DATABASE_IN_WORKSPACE");
    if (protectedFiles.some((file) => isWithin(workspace, realpathSync(file))))
      throw new ExecutionConfigError("SERVER_SECRET_IN_WORKSPACE");
  }
}

function validateCodexHome(codexHome: string) {
  const prohibited = ["config.toml", "AGENTS.md", ".agents", "rules", "hooks.json"];
  // Codex는 첫 실행에 기본 스킬을 skills/.system에 설치합니다. 이 생성물은 허용하되 사용자 스킬은 거부합니다.
  const skillsPath = resolve(codexHome, "skills");
  const hasUserSkills =
    existsSync(skillsPath) && readdirSync(skillsPath).some((name) => name !== ".system");
  // SDK가 계정 동기화로 만든 캐시는 설정과 구분합니다. 실행 시 플러그인 기능 자체를 끕니다.
  const pluginsPath = resolve(codexHome, "plugins");
  const hasPluginConfig =
    existsSync(pluginsPath) &&
    readdirSync(pluginsPath).some(
      (name) => !["cache", ".remote-plugin-install-staging"].includes(name),
    );
  if (
    hasUserSkills ||
    hasPluginConfig ||
    readdirSync(codexHome).some(
      (name) => prohibited.includes(name) || name.endsWith(".config.toml"),
    )
  ) {
    throw new ExecutionConfigError("CODEX_CONFIG_NOT_ALLOWED");
  }
  const auth: unknown = JSON.parse(readFileSync(resolve(codexHome, "auth.json"), "utf8"));
  if (!auth || typeof auth !== "object" || !("auth_mode" in auth) || auth.auth_mode !== "chatgpt") {
    throw new ExecutionConfigError("CHATGPT_LOGIN_REQUIRED");
  }
}

function validateWorkspace(workspace: string, codexHome: string) {
  if (
    !statSync(workspace).isDirectory() ||
    dirname(workspace) === workspace ||
    isWithin(workspace, codexHome)
  ) {
    throw new ExecutionConfigError("WORKSPACE_NOT_ALLOWED");
  }
  // 프로젝트 설정이 실행 정책을 덮어쓰지 않도록 확인합니다.
  for (let parent = workspace; ; parent = dirname(parent)) {
    if (existsSync(resolve(parent, ".codex", "config.toml")))
      throw new ExecutionConfigError("PROJECT_CONFIG_NOT_ALLOWED");
    if (existsSync(resolve(parent, ".git"))) break;
    if (parent === dirname(parent)) break;
  }
}
