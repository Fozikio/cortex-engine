"""NLI cross-encoder service for cortex-engine contradiction adjudication.

Serves the wire contract expected by LocalNLIProvider (src/providers/nli-http.ts):

    POST /classify  {"premise": "...", "hypothesis": "..."}
        -> {"label": "contradiction|entailment|neutral",
            "scores": {"contradiction": f, "entailment": f, "neutral": f}}
    POST /batch     {"pairs": [{"premise": "...", "hypothesis": "..."}, ...]}
        -> {"results": [<classify result>, ...]}
    GET  /health    -> {"status": "ok", "model": "..."}

Defaults match the TypeScript client: 127.0.0.1:11435,
cross-encoder/nli-roberta-base (~125M params, CPU-friendly).

Environment overrides: NLI_MODEL, NLI_HOST, NLI_PORT.

Usage:
    pip install -r requirements.txt
    python serve.py
"""

import math
import os

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

MODEL_NAME = os.environ.get("NLI_MODEL", "cross-encoder/nli-roberta-base")
HOST = os.environ.get("NLI_HOST", "127.0.0.1")
PORT = int(os.environ.get("NLI_PORT", "11435"))

app = FastAPI(title="cortex-engine NLI service", version="1.0.0")

print(f"[nli-service] loading {MODEL_NAME} (first run downloads the model)...")
model = CrossEncoder(MODEL_NAME)
# cross-encoder/nli-* models define id2label; read it rather than assuming
# an output order so swapping NLI_MODEL for another NLI cross-encoder works.
id2label = model.config.id2label
labels = [id2label[i].lower() for i in range(len(id2label))]
print(f"[nli-service] ready — labels: {labels}")


class Pair(BaseModel):
    premise: str
    hypothesis: str


class BatchRequest(BaseModel):
    pairs: list[Pair]


def softmax(logits: list[float]) -> list[float]:
    peak = max(logits)
    exps = [math.exp(x - peak) for x in logits]
    total = sum(exps)
    return [e / total for e in exps]


def classify_pairs(pairs: list[Pair]) -> list[dict]:
    logits = model.predict(
        [(p.premise, p.hypothesis) for p in pairs],
        apply_softmax=False,
    )
    results = []
    for row in logits:
        probs = softmax([float(x) for x in row])
        scores = dict(zip(labels, probs))
        results.append({
            "label": max(scores, key=scores.get),
            "scores": scores,
        })
    return results


@app.post("/classify")
def classify(pair: Pair) -> dict:
    return classify_pairs([pair])[0]


@app.post("/batch")
def batch(request: BatchRequest) -> dict:
    return {"results": classify_pairs(request.pairs)}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
