FROM agent-hub-sandbox-test:local
# Freeze the actual runner from 2438e57 to test an old image/new server mix.
COPY apps/server/tests/fixtures/legacy-analysis-runner.ts.txt /app/apps/server/dist/modules/execution/legacy-analysis-runner.ts
# Only the paid SDK boundary is replaced; the legacy entrypoint stays unchanged.
COPY apps/server/tests/fixtures/legacy-sdk-counter.mjs /app/apps/server/dist/modules/execution/codex-executor.js
ENTRYPOINT ["node", "/app/apps/server/dist/modules/execution/legacy-analysis-runner.ts"]
