# Isolated configuration/startup checks, not the production deployment image.
FROM caddy:2.11.9 AS caddy
FROM node:24.22.1-bookworm-slim
WORKDIR /opt/agent-hub
RUN apt-get update && apt-get install -y --no-install-recommends systemd ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.16.1
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server/tsconfig*.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/migrations apps/server/migrations
COPY apps/server/skills apps/server/skills
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/index.html apps/web/
COPY apps/web/src apps/web/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
RUN pnpm build
COPY ops/agent-hub.service ops/server.env.example ops/Caddyfile ops/journald-agent-hub.conf ops/
COPY scripts/check-operations.mjs scripts/check-operations.mjs
# Satisfy a unit-file dependency for parsing only. This does not run a Docker daemon or systemd PID 1.
RUN printf '[Service]\nExecStart=/bin/true\n' > /etc/systemd/system/docker.service
USER node
ENTRYPOINT ["node", "/opt/agent-hub/scripts/check-operations.mjs"]
