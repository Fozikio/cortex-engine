# fozikio CLI — Service Supervision & Interactive Experience

**Date:** 2026-07-30
**Status:** Approved — implementation in progress
**Scope:** `@fozikio/cortex-engine` — `src/cli/`, `src/services/`, `src/bin/`

---

## Problem

`fozikio` today is 14 flat commands dispatched by a `switch` in `src/bin/cli.ts`. It manages
cortex *data* well and cortex *runtime* not at all.

The default install path — `fozikio init` with `--embed ollama --llm ollama`, plus NLI
adjudication on `:11435` — depends on **two long-lived daemons that nothing supervises**:

| Daemon | Port | Current management |
| --- | --- | --- |
| Ollama (embeddings + LLM) | 11434 | None. Started by hand. |
| NLI cross-encoder | 11435 | `fozikio nli` — **foreground only**, blocks the terminal, no detach, no PID, no restart. |

Both die silently. When either is down, every semantic cortex tool (`query`, `observe`,
`wonder`, `dream`) fails while `ops`/`threads`/`journal` keep working — a partial failure
that reads as "cortex is fine" until a query returns nothing. This has recurred repeatedly
in operational logs; NLI additionally dies on every reboot.

Secondary problems in the same surface:

- **10 duplicated `parseArgs()` implementations**, one per `*-cmd.ts` file.
- **No color, no TTY detection, no interactivity** — zero `styleText` / `isTTY` / ANSI in `src/`.
- **`health` is a misnomer** — it reports memory/FSRS health, not system health. There is no
  command that answers "is my install working?"
- **No `doctor`, no `update`, no `status`.**

## Goals

1. `fozikio` supervises its own runtime dependencies: start, stop, restart, probe, log, auto-restart.
2. One command (`doctor`) diagnoses a broken install and prescribes the exact fix.
3. Bare `fozikio` on a TTY is a live dashboard worth leaving open.
4. Every command is scriptable: `--json`, correct exit codes, degrades cleanly when piped.
5. **No new runtime dependencies.** No `engines` bump.
6. Every existing command keeps working unchanged.

## Non-Goals

- Supervising the cortex MCP server. It is a **stdio** server spawned per-session by the MCP
  client (`.mcp.json` → `node .../dist/mcp/index.js`). It has no daemon lifecycle to manage.
  The dashboard displays it as informational only.
- Managing remote/cloud backends (Firestore, Vertex, hosted LLM providers). Those have no
  local process.
- Automatic boot registration. `service install --boot` exists but is never invoked implicitly.

---

## Architecture

### Layout

```
src/
├── bin/
│   ├── cli.ts                  # thin entry: delegates to cli/router
│   └── *-cmd.ts                # existing command files — stay put (see note)
├── cli/                        # NEW — CLI framework
│   ├── router.ts               # noun-verb dispatch + alias table
│   ├── args.ts                 # util.parseArgs wrapper + shared global flags
│   ├── help.ts                 # help generated from the command tree
│   ├── ui/
│   │   ├── color.ts            # styleText shim; TTY / NO_COLOR / FORCE_COLOR
│   │   ├── symbols.ts          # ✓ ✗ ⚠ ● with ASCII fallback
│   │   ├── box.ts              # box-drawing (extracted from health-cmd.ts)
│   │   ├── table.ts            # aligned columns, width-aware
│   │   ├── spinner.ts          # TTY-only; no-op when piped
│   │   ├── prompt.ts           # readline/promises confirm + input
│   │   ├── select.ts           # raw-mode arrow-key menu
│   │   └── screen.ts           # alt-screen, cursor, resize, guaranteed restore
│   └── tui/
│       ├── dashboard.ts        # render loop + key handling
│       └── panels/             # services, memory, vitals, logs
└── services/                   # NEW — supervision library (not CLI-only)
    ├── registry.ts             # ServiceDef for ollama, nli
    ├── paths.ts                # ~/.fozikio/{run,logs}
    ├── probe.ts                # HTTP health checks
    ├── supervisor.ts           # spawn/detach/stop/restart, PID lifecycle
    └── watchdog.ts             # probe loop, backoff, circuit breaker, sigil notify
```

`src/services/` sits outside `src/cli/` deliberately: the supervisor is consumed by the TUI,
by `up`/`down`, and (later) by `serve` to start dependencies before the MCP server boots. It
is shared runtime, not presentation.

**The existing `src/bin/*-cmd.ts` files are not relocated.** An earlier draft moved them under
`src/bin/commands/`; that was dropped. The gain is cosmetic, while the cost is a 20-file rename
that buries the real diff, rewrites every relative import in those files, and changes emitted
paths — `package.json` `scripts.docs:tools` points at `dist/bin/generate-tools-doc.js`, and the
`bin` field at `dist/bin/cli.js`. Both units are purely additive as a result: `src/cli/` and
`src/services/` are new, and existing command files are touched only where they adopt the
shared arg parser and UI helpers.

### Command surface

```
fozikio                          TUI when stdout.isTTY, else help
fozikio up [--watch]             start all → wait healthy → report
fozikio down                     stop all
fozikio status [--json]          one-shot status; exit 0 healthy, 1 degraded
fozikio doctor [--fix] [--json]  diagnose + prescribe
fozikio service <verb> [id]      start|stop|restart|status|logs|install
fozikio update [--json]          installed vs npm latest across @fozikio/*
fozikio memory <sub>             health|vitals|report|wander|maintain|digest|anomalies
fozikio agent <sub>              add|list|generate-mcp
fozikio serve|init|config|migrate|tools|nli     unchanged
```

**Aliases (hidden, no deprecation warning):** every current top-level verb maps to its new
path — `health`→`memory health`, `vitals`→`memory vitals`, `anomalies`, `report`, `maintain`,
`wander`, `digest`. Cron seeds in the operator workspace invoke these directly; warnings would
only pollute cron logs. They are permanent, not transitional.

`nli` stays top-level *and* becomes `service start nli --foreground`. The existing foreground
behavior is preserved exactly, because `fozikio nli` is referenced in external docs.

### Service registry

```ts
export type ServiceId = 'ollama' | 'nli';

export interface ServiceDef {
  id: ServiceId;
  label: string;
  /** Resolve the launch command, or throw a PreflightError with a fix hint. */
  command(opts: ServiceOpts): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv };
  /** HTTP endpoint proving the service actually answers. */
  probe: { url: string; timeoutMs: number };
  /** How long to wait post-spawn before declaring failure. */
  readyTimeoutMs: number;
  /** Checks that must pass before a spawn is attempted. */
  preflight(opts: ServiceOpts): Promise<Diagnostic[]>;
}
```

One registry backs `doctor`, `status`, `up`, `service`, and the dashboard. Adding a third
service is one entry, not four code paths.

**Binary resolution** — `ollama`: `FOZIKIO_OLLAMA_BIN` → `OLLAMA_URL` (remote; supervision
skipped, probe only) → `ollama` on `PATH` → diagnostic with install URL. Never a hardcoded
path; the bundled runtime in the operator's workspace is environment-specific and must not
be assumed by a published package.

### Core rule: the probe is the source of truth

> A service is **up** iff its probe succeeds. PID liveness is diagnostic detail, never the verdict.

This is the single most important decision in the design and it comes directly from the
observed failure mode: the Ollama process stays alive while `:11434` stops answering. A
PID-based check reports green through exactly that failure. Therefore:

- `status` probes first; the PID file is consulted only to explain *why* something is down
  ("no process" vs "process 4821 alive but not responding").
- A process that is alive but failing its probe is reported **unhealthy**, and `restart`
  will kill and respawn it.

### Process lifecycle

**Spawn** — `detached: true`, `windowsHide: true`, `stdio: ['ignore', logFd, logFd]`,
then `unref()`. Logs append to `~/.fozikio/logs/<id>.log` with size-based rotation at 8 MB
(one `.1` generation kept).

**PID records** — `~/.fozikio/run/<id>.json` holding `{ pid, startedAt, cmd, port }`.
PID reuse is real, so a record is trusted only when the PID is alive **and** the probe
answers on the recorded port. A stale record is removed rather than reported.

**Stop** — platform-split, because `detached: true` on Windows does not create a POSIX
process group and `process.kill(-pid)` is not portable:

| Platform | Stop sequence |
| --- | --- |
| win32 | `taskkill /pid <n> /T /F` |
| posix | `process.kill(-pid, 'SIGTERM')` → 5s grace → `SIGKILL` |

**Ready-wait** — after spawn, poll the probe every 250 ms up to `readyTimeoutMs`
(ollama 15 s; NLI 180 s — first start downloads a model). On timeout, the last 20 log lines
are surfaced instead of a bare "failed".

### Watchdog

`fozikio up --watch` (also reachable as `service start --watch`):

- Probe interval 10 s.
- On failure: restart with exponential backoff — 2s, 4s, 8s, 16s, 30s cap.
- Circuit breaker: 5 consecutive failed restarts → stop trying, report loudly, exit non-zero.
- **Notify via sigil on the 3rd restart within a window.** A watchdog that silently restarts
  a daemon forty times is concealing a fault, not fixing it. Notification is best-effort and
  never blocks supervision; sigil being absent is not an error.

`service install --boot` registers a Task Scheduler entry (win32) or user unit/launch agent
(posix). Explicit invocation only — it modifies state outside the workspace.

### Zero-dependency UI

`package.json` declares `engines: { node: ">=20" }`. `util.styleText` landed in **20.12**, so
a direct import breaks users on 20.0–20.11. `ui/color.ts` therefore:

1. Uses `util.styleText` when present.
2. Falls back to a minimal ANSI SGR map.
3. Enables color when `stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'`;
   `FORCE_COLOR` overrides; `--no-color` overrides everything.

`engines` stays `>=20`. No new dependency, no breaking bump, and the package's zero-vulnerability
install property is preserved.

`util.parseArgs` (stable since Node 20.0) replaces all 10 hand-rolled parsers.

### TUI

Bare `fozikio` with `stdout.isTTY`:

```
┌ fozikio ─────────────────────────── cortex-engine 1.3.0 ┐
│  SERVICES                                                │
│   ● ollama      :11434   up 4h 12m   qwen3-embed, 14b    │
│   ● nli         :11435   up 4h 09m   nli-roberta-base    │
│   ○ cortex mcp  stdio    spawned per session             │
│                                                          │
│  MEMORY                        VITALS                    │
│   665 memories                  curiosity     ▓▓▓▓▓░     │
│   5 unprocessed                 connection    ▓▓▓░░░     │
│   sleep pressure ▓▓▓▓░░ 0.62    creative_e…   ▓▓▓▓▓▓     │
│                                                          │
│  [s] start/stop  [r] restart  [l] logs  [d] doctor       │
│  [D] dream       [q] quit                                │
└──────────────────────────────────────────────────────────┘
```

- **Terminal restoration is guaranteed** on every exit path — normal return, `q`, SIGINT,
  SIGTERM, and `uncaughtException` — via a single `restore()` registered once. Raw mode
  suppresses SIGINT, so `\x03` is handled manually. A CLI that leaves the terminal in
  alt-screen with a hidden cursor is a defect, not a rough edge.
- Full repaint on a 1 s tick. No diffing — over-engineering at this size.
- Probes run on an **independent 3 s timer** so the render loop never blocks on network I/O.
- `process.stdout.on('resize')` → repaint. Below 80 columns, panels stack; below 60, the
  vitals panel drops.
- Store reads (memory counts, vitals) are cached 5 s to keep SQLite off the render path.

### Output contract

| Condition | Behavior |
| --- | --- |
| `stdout.isTTY` | Color, symbols, spinners, interactive prompts |
| Piped / redirected | Plain text, no ANSI, no spinner frames, prompts fail rather than hang |
| `--json` | Machine-readable only; nothing else on stdout; diagnostics to stderr |
| `--yes` | Assume yes for all confirmations (cron-safe) |

**Exit codes:** `0` healthy/success · `1` degraded or failed · `2` usage error.
`status` and `doctor` exit `1` when anything is unhealthy so cron can branch on it.

---

## Testing

Unit tests (vitest, alongside existing `*.test.ts`):

- `cli/args` — flag parsing, global flags, unknown-flag errors.
- `cli/ui/color` — TTY on/off, `NO_COLOR`, `FORCE_COLOR`, `--no-color`, missing `styleText`.
- `cli/router` — alias resolution, every legacy verb still routes.
- `services/registry` — binary resolution order, preflight diagnostics.
- `services/supervisor` — PID record read/write, stale-record rejection, platform stop-command
  selection (asserted on the generated command, not by killing real processes).
- `services/watchdog` — backoff schedule, circuit-breaker trip, notify-on-3rd (fake timers).

Probe/spawn integration is covered against a local HTTP stub, not real Ollama.

### CI gap this PR must close

Current CI is a **single job running `npx tsc` on `ubuntu-latest`**. `npm test` never runs,
despite vitest being configured and test files existing. For a feature whose principal risk is
Windows process detachment, `taskkill` semantics, and PID reuse, that gate is blind — and the
project's stated Production tier calls for CI as a hard merge gate.

This PR adds to `.github/workflows/ci.yml`:

- an `npm test` step, and
- a `windows-latest` leg alongside `ubuntu-latest`.

---

## Build order

Each unit is independently mergeable and leaves the CLI working.

| # | Unit | Delivers |
| --- | --- | --- |
| 1 | `cli/args`, `cli/ui`, `cli/router`, aliases | Color, symbols, unified parsing. No behavior change. |
| 2 | `services/` + `service`, `up`, `down`, `status` | Real supervision. Closes the outage problem. |
| 3 | `doctor`, `update` | Prescriptive diagnosis. |
| 4 | `cli/tui` | Bare `fozikio` dashboard. |
| 5 | CI hardening | `npm test` + windows leg. |

## Risks

| Risk | Mitigation |
| --- | --- |
| Windows detach/kill behaves differently than assumed | Platform-split stop; windows CI leg; command-shape asserted in tests |
| A regression breaks a cron-invoked legacy command | Alias table covered by tests asserting every legacy verb routes |
| TUI leaves terminal corrupted | Single `restore()` on all exit paths incl. `uncaughtException`; manual `\x03` |
| NLI first-start timeout looks like a crash | 180 s ready window + tail of log surfaced on timeout |
| Probe blocks the render loop | Probes on an independent timer; store reads cached 5 s |
| Scope creep into engine internals | `services/` and `cli/` are additive; existing command files move but do not change |
