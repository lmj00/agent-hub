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
  expect(options.config?.features).toMatchObject({ skip_host_skill_discovery: true, skill_search: false });
  expect(options.config?.forced_login_method).toBe("chatgpt");
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
  const result = await createCodexExecutor("/tmp/private-auth").analyze(request, event => events.push(event));
  expect(result).toEqual({ output: "Result [REDACTED]", usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } });
  expect(JSON.stringify(events)).not.toContain("secret command");
  expect(events[0]).toEqual({ kind: "thread.started", sessionId: "session" });
});

test("does not treat a partial agent message as success", async () => {
  fake.events = [{ type: "item.completed", item: { type: "agent_message", text: "Partial" } }];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "provider_error" });
});

test("classifies a failed turn without returning its raw error", async () => {
  fake.events = [{ type: "turn.failed", error: { message: "Usage limit reached: sk-fixture_secret" } }];
  await expect(createCodexExecutor("/tmp/private-auth").analyze(request, () => {})).rejects.toMatchObject({ code: "capacity", message: "capacity" });
  expect(classifyCodexError("401 Unauthorized").code).toBe("authentication");
  expect(classifyCodexError("model not supported").code).toBe("unsupported_settings");
});
