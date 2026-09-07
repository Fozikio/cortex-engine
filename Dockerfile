FROM node:24-slim AS builder
LABEL org.opencontainers.image.source=https://github.com/Fozikio/cortex-engine
WORKDIR /app

# better-sqlite3 is a native addon — needs python and build tools to compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production dependencies are compiled in their own stage that still has the
# toolchain, so the runtime image can copy the built node_modules and never
# install a compiler at all. Purging the toolchain in a later RUN would not
# help: image layers are additive, so the packages would still ship inside
# the earlier layer even after being removed.
FROM node:24-slim AS prod-deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# No python3/make/g++ here. The compiled addon arrives prebuilt from
# prod-deps; both stages share the same base image, so the binary matches.
COPY package.json package-lock.json* ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# The SQLite store defaults to a relative ./cortex.db (core/config.ts), which
# resolves to /app at runtime — so /app must be writable by the running user.
# Without this chown, dropping to `node` turns the default configuration into
# a startup failure.
RUN chown -R node:node /app

# Drop root. node:24-slim ships an unprivileged `node` user (uid 1000).
USER node

EXPOSE 8080
# The image exists to serve the REST API (EXPOSE 8080 / docker-compose maps 8080).
# Without --rest this starts the stdio MCP server, which binds no port.
# HOST/PORT are read by serve.js; 0.0.0.0 is required to be reachable outside the container.
ENV HOST=0.0.0.0
CMD ["node", "dist/bin/serve.js", "--rest"]
