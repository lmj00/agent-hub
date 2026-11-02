import { expect, test, vi } from "vitest";
const fake = vi.hoisted(() => ({ events: [] as unknown[], start: vi.fn(), run: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class {
  startThread(options: unknown) {
    fake.start(options);
    return { async runStreamed(prompt: unknown, options: unknown) {
      fake.run(prompt, options);
      return { events: (async function* () { for (const event of fake.events) yield event; })() };
    } };
  }
} }));
import { codexOptions, createCodexExecutor, threadOptions } from "../src/modules/execution/codex-executor.js";
import { type AnalysisEvent, classifyCodexError } from "../src/modules/execution/analysis.js";

const request = { instruction: "Analyze", workspace: "/tmp/prepared", model: "test-model", signal: new AbortController().signal };

test("uses explicit ChatGPT auth, scoped read-only permissions, medium effort and no API-key inheritance", () => {
  const options = codexOptions("/tmp/private-auth", request.workspace);
  expect(Object.keys(options.env!).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
  expect(options.env?.HOME).toBe("/tmp/private-auth");
  expect(options.config?.features).toMatchObject({
    skip_host_skill_discovery: true, skill_search: false,
    plugins: false, remote_plugin: false, plugin_discovery_prefetch: false,
  });
  expect(options.config?.forced_login_method).toBe("chatgpt");
  expect(options.config?.shell_environment_policy).toEqual({ inherit: "none", set: { PATH: options.env?.PATH } });
  expect(options.configOverrides?.[0]).toContain('":root"="deny"');
  expect(options.configOverrides?.[0]).toContain('"/tmp/prepared"="read"');
  expect(options.configOverrides?.[0]).toContain('"/tmp/private-auth"="deny"');
  expect(threadOptions(request)).toMatchObject({ modelReasoningEffort: "medium", approvalPolicy: "never", webSearchMode: "disabled" });
  expect(threadOptions(request)).not.toHaveProperty("sandboxMode");
});

test("maps progress without saving command arguments or reasoning and waits for completion", async () => {
  fake.events = [
    { type: "thread.started", thread_id: "session" },
    { type: "item.completed", item: { type: "command_execution", command: "secret command", aggregated_output: "private output" } },
    { type: "item.completed", item: { type: "agent_message", text: "Result sk-fixture_secret" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } },
  ];
  const events: AnalysisEvent[] = [];
  const result = await createCodexExecutor("/tmp/private-auth").analyze(request, event => { events.push(event); });
  expect(result).toEqual({ output: "Result [REDACTED]", usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } });
  expect(JSON.stringify(events)).not.toContain("secret command");
  expect(events[0]).toEqual({ kind: "thread.started", sessionId: "session" });
});

test("does not treat a partial agent message as success", async () => {
  fake.events = [{ type: "item.completed", item: { type: "agent_message", text: "Partial" } }];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "provider_error" });
});

test.each([
  "bwrap: execvp /app/private-runtime/codex: No such file or directory",
  "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
  "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
])("does not mark a broken sandbox runtime as successful analysis: %s", async (message) => {
  fake.events = [
    { type: "item.completed", item: { type: "command_execution", exit_code: 1, aggregated_output: message } },
    { type: "item.completed", item: { type: "agent_message", text: "Could not read project files." } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "unsupported_settings" });
  const options = codexOptions("/codex-home", "/workspace", "/usr/local/lib/codex/bin/codex");
  expect(classifyCodexError(message)).toMatchObject({ code: "unsupported_settings", message: "unsupported_settings" });
  expect(options.codexPathOverride).toBe("/usr/local/lib/codex/bin/codex");
  expect(options.configOverrides?.[0]).toContain('"/codex-home"="deny"');
});

test("classifies a failed turn without returning its raw error", async () => {
  fake.events = [{ type: "turn.failed", error: { message: "Usage limit reached: sk-fixture_secret" } }];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "capacity", message: "capacity" });
  expect(classifyCodexError("401 Unauthorized").code).toBe("authentication");
  expect(classifyCodexError("model not supported").code).toBe("unsupported_settings");
});

test("accepts only explicit, timezone-qualified provider retry times", () => {
  expect(classifyCodexError("Usage limit reached. Try again at 2030-01-01T09:00:00+09:00").retryAt).toEqual(new Date("2030-01-01T00:00:00Z"));
  for (const message of ["quota reached", "quota: try again at 09:00", "quota: try again tomorrow", "quota: retry at 2030-02-30T00:00:00Z"]) {
    expect(classifyCodexError(message).retryAt).toBeNull();
  }
  expect(classifyCodexError("Authentication failed. Retry at 2030-01-01T00:00:00Z").retryAt).toBeNull();
});

test("a reconnected completed turn succeeds but does not erase a forbidden tool invocation", async () => {
  fake.events = [
    { type: "error", message: "Reconnecting... connection failed" },
    { type: "item.completed", item: { type: "agent_message", text: "Recovered report" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).resolves.toMatchObject({ output: "Recovered report" });
  fake.events.unshift({ type: "item.completed", item: { type: "file_change", status: "completed" } });
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "unsupported_settings" });
});

test("passes the chosen effort to the actual SDK thread options", async () => {
  for (const effort of ["medium", "high", "xhigh"] as const) {
    fake.events = [
      { type: "thread.started", thread_id: "effort-fixture" },
      { type: "item.completed", item: { type: "agent_message", text: "Result" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ];
    await createCodexExecutor("/tmp/private-auth").analyze({ ...request, effort }, () => {});
    expect(fake.start).toHaveBeenLastCalledWith(expect.objectContaining({ modelReasoningEffort: effort }));
  }
});
