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

A **manifest-only** plugin. It ships `openclaw.plugin.json` and no runtime
module: its whole job is to contribute the cortex MCP server and expose config
for where the store and daemons live. The engine itself is the
[`@fozikio/cortex-engine`](https://www.npmjs.com/package/@fozikio/cortex-engine)
dependency.

> `clawhub package validate` reports one P2 warning here,
> `package-openclaw-entry-missing`, and that is expected. The fix for it is to
> declare `openclaw.extensions` / `openclaw.runtimeExtensions`, which are
> entrypoints for plugins that ship runtime JavaScript. This plugin has none.
> Declaring an entrypoint that does not exist would turn a truthful warning
> into a broken load.

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
