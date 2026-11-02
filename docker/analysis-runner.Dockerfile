FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server/tsconfig*.json apps/server/
COPY apps/server/src apps/server/src
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
RUN pnpm --filter @agent-hub/server... build

FROM node:24.22.1-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/packages/contracts ./packages/contracts
COPY docker/install-codex-runtime.mjs ./apps/server/install-codex-runtime.mjs
RUN node ./apps/server/install-codex-runtime.mjs && rm ./apps/server/install-codex-runtime.mjs
ENV PATH="/usr/local/lib/codex/codex-path:${PATH}"
USER node
ENTRYPOINT ["node", "/app/apps/server/dist/modules/execution/analysis-runner.js"]
