import { buildApp } from "../../src/app.js";
import { loadExecutionConfig } from "../../src/modules/execution/execution-config.js";
import { createConfiguredExecutor } from "../../src/modules/execution/execution-process.js";

const [databasePath, configPath] = process.argv.slice(2) as [string, string];
const config = loadExecutionConfig(configPath);
const executor = createConfiguredExecutor(config);
const app = buildApp({ databasePath, execution: { config, executor: {
  ...executor,
  analyze(request, onEvent) {
    return executor.analyze(request, event => { onEvent(event); process.send?.(event); });
  },
} } });
await app.listen({ host: "127.0.0.1", port: 0 });
