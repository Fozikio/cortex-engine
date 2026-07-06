# NLI service

Local cross-encoder service that powers cortex-engine's contradiction
adjudication (`contradict` tool and observe-time implicit-conflict detection).
See [docs/nli-adjudication.md](../../docs/nli-adjudication.md) for how the
engine uses it.

## Quickstart

```bash
cd scripts/nli-service
python -m venv .venv
# Windows: .venv\Scripts\activate    POSIX: source .venv/bin/activate
pip install -r requirements.txt
python serve.py
```

First run downloads `cross-encoder/nli-roberta-base` (~500 MB with weights and
tokenizer) from Hugging Face. The model is CPU-friendly: single-pair latency is
tens of milliseconds on a modern laptop.

Then enable it in cortex-engine, either in `.fozikio/config.yaml`:

```yaml
nli:
  enabled: true
  # url: http://127.0.0.1:11435   # default
```

or via environment variable (no config change needed):

```bash
CORTEX_NLI_URL=http://127.0.0.1:11435 npm run serve
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `NLI_MODEL` | `cross-encoder/nli-roberta-base` | Any Hugging Face NLI cross-encoder |
| `NLI_HOST` | `127.0.0.1` | Bind address (keep loopback — no auth) |
| `NLI_PORT` | `11435` | Port; must match `nli.url` / `CORTEX_NLI_URL` |

Larger models (e.g. `cross-encoder/nli-deberta-v3-base`) trade latency for
accuracy and drop in via `NLI_MODEL` — the service reads the label order from
the model config, so any NLI cross-encoder with
contradiction/entailment/neutral labels works.

## Wire contract

Matches `LocalNLIProvider` (`src/providers/nli-http.ts`):

- `POST /classify` `{"premise", "hypothesis"}` → `{"label", "scores": {"contradiction", "entailment", "neutral"}}`
- `POST /batch` `{"pairs": [...]}` → `{"results": [...]}`
- `GET /health` → `{"status": "ok", "model"}`

The engine degrades gracefully when this service is down: adjudication falls
back to the configured LLM, and observe-time conflict checks are skipped.
