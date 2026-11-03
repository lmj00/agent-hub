# Dependency-free Node test image. Project dependencies must be built into a
# reviewed image before execution; verification has no network access.
FROM node:24.22.1-bookworm-slim
WORKDIR /workspace
USER node
