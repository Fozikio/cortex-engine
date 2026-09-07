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

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Rebuild native addons in the runtime stage
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 8080
# The image exists to serve the REST API (EXPOSE 8080 / docker-compose maps 8080).
# Without --rest this starts the stdio MCP server, which binds no port.
# HOST/PORT are read by serve.js; 0.0.0.0 is required to be reachable outside the container.
ENV HOST=0.0.0.0
CMD ["node", "dist/bin/serve.js", "--rest"]
