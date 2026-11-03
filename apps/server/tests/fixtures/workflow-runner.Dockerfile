FROM agent-hub-sandbox-test:local
COPY apps/server/tests/fixtures/workflow-runner.mjs /app/workflow-runner.mjs
ENTRYPOINT ["node", "/app/workflow-runner.mjs"]
