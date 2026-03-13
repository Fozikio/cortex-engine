# cortex-engine

Cognitive engine for AI agents — semantic memory, observations, embeddings, dream consolidation. Cloud Run service + MCP tools.

## What It Does

`cortex-engine` is a portable TypeScript service that gives AI agents persistent, structured memory. It handles:

- **Semantic memory graph** — store and retrieve observations as interconnected nodes
- **Embeddings** — vector representations via pluggable providers (OpenAI, Vertex AI, Anthropic)
- **Dream consolidation** — background process that reinforces and connects memories over time
- **FSRS scheduling** — spaced-repetition scheduling for memory retention
- **MCP server** — exposes cognitive tools (`query`, `observe`, `believe`, `wander`, etc.) over the Model Context Protocol

Runs as a standalone Cloud Run service or embedded in any Node.js environment.

## Architecture

| Module | Role |
|--------|------|
| `core` | Foundational types, config, and shared utilities |
| `engines` | Cognitive processing: memory consolidation, FSRS, graph traversal |
| `stores` | Persistence layer — SQLite (local) and Firestore (cloud) |
| `mcp` | MCP server and tool definitions |
| `cognitive` | Higher-order cognitive operations (dream, wander, validate) |
| `triggers` | Scheduled and event-driven triggers |
| `bridges` | Adapters for external services and APIs |
| `providers` | Embedding provider implementations |
| `bin` | Entry points: `serve.js` (HTTP + MCP), `cli.js` (admin CLI) |

## Getting Started

```bash
git clone https://github.com/fozikio/cortex-engine.git
cd cortex-engine
npm install
npm run build
npm run serve
```

Requires Node.js 20 or later.

### Development

```bash
npm run dev       # tsc --watch
npm test          # vitest run
npm run test:watch
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CORTEX_API_TOKEN` | Yes | Authentication token for the HTTP API |

Additional variables are required depending on which providers you enable (Firestore, Vertex AI, OpenAI, etc.). See `docs/` for provider-specific configuration.

## Related Projects

- [idapixl/idapixl-cortex](https://github.com/idapixl/idapixl-cortex) — private production instance of cortex-engine, deployed on Cloud Run
- [fozikio/dashboard](https://github.com/fozikio/dashboard) — agent workspace dashboard backed by cortex-engine

## License

MIT — see [LICENSE](LICENSE)
