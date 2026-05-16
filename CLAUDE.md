# cortex-engine

Portable cognitive engine for AI agents. Published as `@fozikio/cortex-engine` on npm.

## Commands

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm run test         # vitest (requires --experimental-vm-modules)
npm run serve        # Start MCP server (node dist/bin/serve.js)
```

## Architecture

```
src/
├── bin/            # CLI entry points (serve.js, cortex-engine CLI)
├── bridges/        # Cross-namespace bridging
├── core/           # Config, types, utilities
├── engines/        # Cognitive processing, memory consolidation, FSRS, dream pipeline
├── mcp/            # MCP server with 27+ cognitive tools
├── namespace/      # Multi-namespace management
├── plugins/        # Plugin system
├── providers/      # LLM/embedding providers (Anthropic, OpenAI, Vertex, HuggingFace)
├── rest/           # REST API server
├── stores/         # Storage backends
│   ├── sqlite.ts   # Local SQLite (better-sqlite3)
│   └── firestore.ts # Cloud Firestore
├── tools/          # Tool definitions
├── triggers/       # Event triggers
└── index.ts        # Main entry + re-exports
```

## Key Exports

- `.` — Core engine, types, tools
- `./stores/sqlite` — SQLite storage backend
- `./stores/firestore` — Firestore storage backend
- `./mcp` — MCP server
- `./rest` — REST API

## Critical Rules

- ESM only (`"type": "module"`) — all imports need `.js` extensions
- Target: ES2022, Module: NodeNext
- Strict TypeScript — `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- LLM/embedding providers are peer dependencies (optional) — don't add them as direct deps
- SQLite via `better-sqlite3` (native addon) — needs rebuild on Node version changes
