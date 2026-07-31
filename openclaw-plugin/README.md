# @fozikio/cortex — OpenClaw plugin

Persistent memory and typed cognition for OpenClaw agents. 60 cortex tools over
MCP, running locally on SQLite and Ollama.

```bash
openclaw plugins install clawhub:@fozikio/cortex
openclaw plugins enable cortex
openclaw gateway restart
```

Installing plugin code requires a Gateway restart. Verify it actually
registered — `plugins list` reads cold config and does not prove the running
Gateway imported it:

```bash
openclaw plugins inspect cortex --runtime --json
```

## What this package is

A thin plugin. The cortex MCP server is contributed **declaratively**, through
the `mcpServers` block in `openclaw.plugin.json`, so `index.mjs` registers
nothing at runtime. The engine itself is the
[`@fozikio/cortex-engine`](https://www.npmjs.com/package/@fozikio/cortex-engine)
dependency.

The entry module still has to exist. OpenClaw's rule is explicit:

> Runtime loading stays strict: installed plugins still need
> `openclaw.plugin.json` and `package.json` `openclaw.extensions`. OpenClaw
> never executes plugin code to infer missing manifest data.

There is no manifest-only exemption, and `package-openclaw-entry-missing` is
enforced at publish time rather than being advisory.

`index.mjs` is plain ESM rather than TypeScript compiled to `dist/`. Declaring
`runtimeExtensions` obliges the built artifact to exist — a declared but
missing artifact fails install with a packaging error instead of falling back
to source. A single `.mjs` with nothing to build cannot drift out of sync with
its own build output.

## Configuration

Under `plugins.entries.cortex.config`:

| Key | Default | Notes |
|---|---|---|
| `sqlitePath` | engine default | Absolute path to the store |
| `ollamaUrl` | `http://localhost:11434` | Embeddings + local LLM |
| `nliUrl` | `http://127.0.0.1:11435` | Optional contradiction adjudication |
| `namespace` | `default` | Keeps unrelated agents' memories apart |

**Point `sqlitePath` at the store you actually mean.** A wrong or empty path
does not error — it produces a store that answers every query with zero results
and reads as a healthy empty system rather than a misconfiguration. That exact
failure hid a live misconfiguration in the reference deployment: every health
check reported `total: 0` against a 112 KB decoy while the real store held
thousands of memories.

`nliUrl` is optional. Without it, `contradict()` falls back to the LLM — slower
and less decisive, but not broken.

## Requirements

Ollama on `:11434` with an embedding model and a local LLM. `fozikio up` starts
what is missing and waits until each endpoint answers; `fozikio doctor`
diagnoses an install that will not come up.

Ollama is treated as shared infrastructure: cortex ensures it is up and never
stops it, so it is safe alongside other agents using the same daemon.

## Source

[github.com/Fozikio/cortex-engine](https://github.com/Fozikio/cortex-engine) ·
MIT · the plugin manifest lives in `openclaw-plugin/`.
