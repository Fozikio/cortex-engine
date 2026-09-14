# Deploy cortex-engine on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/cortex-engine)

A hosted cortex REST server in a few minutes: one service built from this repo's `Dockerfile`, one
volume for the SQLite store, and an LLM API key. No Ollama, no Firestore.

The marketplace template at [railway.com/deploy/cortex-engine](https://railway.com/deploy/cortex-engine)
does the steps below for you: it wires the volume at `/data`, the health check, the public port, and the
variables (with a generated `CORTEX_API_TOKEN`); you supply the LLM key. The manual steps stay here for
anyone deploying from a fork.

## What you get

- `https://<your-service>.up.railway.app` serving the REST API (`/health`, `/api/...`) behind
  `CORTEX_API_TOKEN`.
- A SQLite store on a persistent volume — your agent's memory survives redeploys.
- Built-in embeddings (no external embedding service) and an OpenAI-compatible, Anthropic, Gemini or
  Kimi model for the LLM-backed tools (reflect, digest, dream, HyDE expansion).

## Steps

1. **New project → Deploy from GitHub repo** → pick your fork of `Fozikio/cortex-engine` (or this repo).
   Railway reads `railway.json` and builds the `Dockerfile`.
2. **Add a volume** to the service and mount it at `/data`.
3. **Set variables** on the service:

   | Variable | Value | Why |
   |---|---|---|
   | `CORTEX_API_TOKEN` | a long random string | The REST server refuses to start without a token. Clients send it as `x-cortex-token`. |
   | `CORTEX_SQLITE_PATH` | `/data/cortex.db` | Put the store on the volume, not in the image. |
   | `CORTEX_EMBED` | `built-in` | Local embeddings; nothing to provision. |
   | `CORTEX_LLM` | `openai` (or `anthropic`, `gemini`, `kimi`) | Picks the LLM provider without a config file. |
   | `OPENAI_API_KEY` | your key | Required for `openai`. Use the matching key variable for other providers. |
   | `RAILWAY_RUN_UID` | `0` | The image runs as the unprivileged `node` user; Railway mounts volumes root-owned, and this is Railway's documented fix. |

   Railway injects `PORT`; the image already listens on `0.0.0.0:$PORT`.

4. **Deploy.** The health check hits `/health` (no auth). First boot creates the store on the volume.
5. **Use it.** The instance speaks REST; send the token as `x-cortex-token`:

   ```bash
   curl -s https://<your-service>.up.railway.app/health
   curl -s -H "x-cortex-token: <token>" -H "content-type: application/json" \
     -X POST https://<your-service>.up.railway.app/api/observe \
     -d '{"text":"The deploy worked."}'
   ```

   MCP clients (Claude Code, Cursor) cannot point `.mcp.json` at this URL yet: the REST server exposes no MCP
   transport. That is tracked in [#92](https://github.com/Fozikio/cortex-engine/issues/92); until it lands, a
   hosted instance is for agents that call HTTP directly, or for the `cortex-telemetry` hook.

## Notes

- `CORTEX_STORE`, `CORTEX_EMBED`, `CORTEX_LLM` and `CORTEX_SQLITE_PATH` override any config file; they exist
  so containers can choose providers from the deploy panel. Unknown values are ignored with a warning in the
  logs, so check the first lines of the deploy log if a tool complains about Ollama.
- One volume per service, and Railway briefly stops the old deployment before the new one mounts the volume
  — expect a few seconds of downtime on redeploy.
- Free-plan volumes are 0.5 GB. A store with ~700 memories and ~3,500 edges is well under 100 MB.
- Ollama is still the default when a config file says so or when nothing is set; that default is for local
  development, not for hosting.
