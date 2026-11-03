FROM agent-hub-sandbox-test:local
COPY apps/server/tests/fixtures/development-runner.mjs /development-runner.mjs
ENTRYPOINT ["node", "/development-runner.mjs"]
