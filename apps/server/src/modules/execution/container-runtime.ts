import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { AnalysisRequest, ExecutionIdentity } from "./analysis.js";

const exec = promisify(execFile);
const tokenLabel = "io.agent-hub.execution-token";
// Resolve from the module, so source and dist use the same versioned policy asset.
export const containerSeccompProfilePath = fileURLToPath(new URL("../../../security/codex-seccomp.json", import.meta.url));
const verificationRunnerPath = fileURLToPath(new URL("../../../runtime/verification-runner.mjs", import.meta.url));

export async function containerSecurityOptions(signal?: AbortSignal): Promise<string[]> {
  const features: unknown = JSON.parse(await docker(["info", "--format", "{{json .SecurityOptions}}"], signal));
  if (!Array.isArray(features) || features.some(value => typeof value !== "string")) throw new Error("Container security features unavailable");
  return [
    "--security-opt", `seccomp=${containerSeccompProfilePath}`,
    ...(features.includes("name=apparmor") ? ["--security-opt", "apparmor=agent-hub-codex-v1"] : []),
  ];
}

async function docker(args: string[], signal?: AbortSignal) {
  // Docker 오류 원문에는 호스트 경로가 포함될 수 있어 호출자에게 고정 오류만 전달합니다.
  try {
    // Preparation shares the Run's deadline and cancellation signal. A separate
    // short timeout is only for termination observation, not cold container setup.
    return (await exec("docker", args, { timeout: signal ? 0 : 2500, signal, killSignal: "SIGKILL", maxBuffer: 256 * 1024 })).stdout.trim();
  } catch { throw new Error("Container runtime command failed"); }
}

async function engineId(signal?: AbortSignal) {
  const id = await docker(["info", "--format", "{{.ID}}"], signal);
  if (!id || id.length > 200) throw new Error("Container runtime identity unavailable");
  return id;
}

async function verificationImageId(image: string, signal: AbortSignal) {
  const images = JSON.parse(await docker(["image", "inspect", image], signal));
  const selected = images?.[0];
  if (!Array.isArray(images) || images.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(selected?.Id) || !selected.Config ||
      (selected.Config.Volumes && Object.keys(selected.Config.Volumes).length))
    throw new Error("Verification image must not declare persistent volumes");
  // Pin the inspected image so a tag cannot change between validation and create.
  return selected.Id as string;
}

export async function prepareContainer(image: string, codexHome: string, request: AnalysisRequest): Promise<ExecutionIdentity> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (!uid || gid === undefined) throw new Error("Container execution requires a non-root Unix user");
  if ([request.workspace, ...(request.verification ? [verificationRunnerPath] : [codexHome])].some(path => /[,\r\n]/.test(path))) throw new Error("Unsupported container mount path");
  const engine = await engineId(request.signal);
  const security = await containerSecurityOptions(request.signal);
  const testImage = request.verification ? await verificationImageId(request.verification.config.image, request.signal) : undefined;
  const token = randomUUID();
  const id = await docker([
    "create", "--pull", "never", "--interactive", "--init", "--restart", "no", "--log-driver", "none",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128",
    ...security,
    "--memory", "768m", "--cpus", "1", "--user", `${uid}:${gid}`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
    "--tmpfs", `/home/runner:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`,
    ...(request.verification ? [
      "--network", "none", "--no-healthcheck",
      "--mount", `type=bind,src=${verificationRunnerPath},dst=/hub-test/runner.mjs,readonly`,
    ] : ["--mount", `type=bind,src=${codexHome},dst=/codex-home`, "--env", "CODEX_HOME=/codex-home"]),
    ...(request.development ? [
      "--mount", `type=bind,src=${request.workspace},dst=/input,readonly`,
      "--tmpfs", `/workspace:rw,nosuid,nodev,size=32m,nr_inodes=4096,uid=${uid},gid=${gid},mode=0700`,
    ] : ["--mount", `type=bind,src=${request.workspace},dst=/workspace,readonly`]),
    "--env", "HOME=/home/runner", "--workdir", "/workspace",
    "--label", `${tokenLabel}=${token}`, "--label", `io.agent-hub.run=${request.runId}`,
    ...(testImage ? ["--entrypoint", "node", testImage, "/hub-test/runner.mjs"] : [image]),
  ], request.signal);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Container identity unavailable");
  return { kind: "docker", containerId: id, token, engineId: engine };
}

type ContainerState = { Status: string; Running: boolean; Restarting: boolean; Pid: number; ExitCode: number; OOMKilled: boolean };

async function inspectOwned(identity: ExecutionIdentity): Promise<ContainerState & { imageId: string }> {
  if (identity.kind !== "docker" || !/^[a-f0-9]{64}$/.test(identity.containerId) || !identity.token) throw new Error("Invalid execution identity");
  if (await engineId() !== identity.engineId) throw new Error("Container runtime identity changed");
  const data = JSON.parse(await docker(["inspect", "--type", "container", identity.containerId])) as Array<{
    Id: string;
    Image: string;
    Config: { Labels: Record<string, string> };
    HostConfig: { PidMode: string; Privileged: boolean; RestartPolicy: { Name: string } };
    State: ContainerState;
  }>;
  const info = data[0];
  if (data.length !== 1 || info?.Id !== identity.containerId || info.Config.Labels?.[tokenLabel] !== identity.token
    || info.HostConfig.PidMode !== "" || info.HostConfig.Privileged || info.HostConfig.RestartPolicy.Name !== "no") {
    throw new Error("Container execution identity does not match");
  }
  return { ...info.State, imageId: info.Image };
}

// Test stdout is never authoritative. Read the exit status from the owned
// container, after the attached process has exited and all processes are gone.
export async function readContainerExit(identity: ExecutionIdentity) {
  const state = await inspectOwned(identity);
  if (state.Status !== "exited" || state.Running || state.Restarting || state.Pid !== 0 ||
      !Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255 || typeof state.OOMKilled !== "boolean" ||
      !/^sha256:[a-f0-9]{64}$/.test(state.imageId)) throw new Error("Container exit status is unconfirmed");
  return { exitCode: state.ExitCode, oomKilled: state.OOMKilled, imageId: state.imageId };
}

// 저장된 전체 ID·실행 토큰·Docker 엔진을 대조한 뒤 이 실행만 중단합니다.
// 컨테이너가 사라졌거나 엔진에 연결할 수 없으면 종료의 증거로 사용하지 않습니다.
export async function stopAndConfirmContainer(identity: ExecutionIdentity): Promise<Date | null> {
  try {
    let state = await inspectOwned(identity);
    if (state.Status === "created" && !state.Running && state.Pid === 0) {
      // 시작 요청이 Docker에 도착하는 중일 수 있습니다. created 조회만으로는
      // 종료를 확정하지 않고 ID를 제거해 뒤늦은 start 자체를 불가능하게 합니다.
      // 동시에 시작됐다면 강제 삭제하지 않으므로 rm이 실패하고 보류합니다.
      await docker(["rm", identity.containerId]);
      return new Date();
    }
    if (state.Running || state.Restarting) {
      await docker(["stop", "--time", "1", identity.containerId]);
      state = await inspectOwned(identity);
    }
    return !state.Running && !state.Restarting && state.Pid === 0 && state.Status === "exited" ? new Date() : null;
  } catch { return null; }
}

export function attachContainer(identity: ExecutionIdentity): ChildProcess {
  return spawn("docker", ["start", "--attach", "--interactive", identity.containerId], { stdio: ["pipe", "pipe", "pipe"] });
}

// 종료 근거가 DB에 기록된 뒤에만 호출합니다. 삭제 실패는 다음 실행의 안전성에 영향을 주지 않습니다.
export async function removeFinishedContainer(identity: ExecutionIdentity) {
  try {
    const state = await inspectOwned(identity);
    if (!state.Running && !state.Restarting && state.Pid === 0) await docker(["rm", identity.containerId]);
  } catch { /* 실행 이력에 ID를 보존해 나중에 정리할 수 있습니다. */ }
}
