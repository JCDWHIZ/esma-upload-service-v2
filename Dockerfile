# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
ARG TARGETARCH

WORKDIR /app

# Enable corepack so pnpm is available without a separate install step.
RUN corepack enable

# Tune network resilience for pnpm fetches inside Docker / QEMU
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MAINTIMEOUT=60000 \
    NPM_CONFIG_NETWORK_CONCURRENCY=8

# Install all dependencies (including devDependencies for the build).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store,sharing=locked pnpm install --frozen-lockfile

# Copy source and compile TypeScript.
COPY tsconfig*.json ./
COPY src/ ./src/

RUN pnpm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ARG TARGETARCH

WORKDIR /app

ENV NODE_ENV=production

# Enable corepack for pnpm at runtime.
RUN corepack enable

# Tune network resilience for runtime install
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MAINTIMEOUT=60000 \
    NPM_CONFIG_NETWORK_CONCURRENCY=8

# Install production-only dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/root/.local/share/pnpm/store,sharing=locked pnpm install --frozen-lockfile --prod

# Copy compiled output from the build stage.
COPY --from=build /app/dist ./dist

# Create the staging directory and give the non-root node user ownership.
# STAGING_DIR in .env.example defaults to /tmp/esma-staging.
RUN mkdir -p /tmp/esma-staging && chown node:node /tmp/esma-staging

# Never run as root in production.
USER node

# The API listens on PORT (default 7030 in config).
EXPOSE 7030

# Liveness probe: a fast node one-liner hitting /uploads/health/live.
# --start-period gives the app time to boot before the first check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "\
    const http = require('http'); \
    const port = process.env.PORT || 7030; \
    http.get('http://localhost:' + port + '/uploads/health/live', (r) => { \
      process.exit(r.statusCode === 200 ? 0 : 1); \
    }).on('error', () => process.exit(1)); \
  "

CMD ["node", "dist/main.js"]
