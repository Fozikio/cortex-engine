# Tool-discovery patterns

**Status:** Draft for review
**Date:** 2026-05-16
**Owner:** idapixl
**Related specs:** [2026-05-16-concurrency-audit-design.md], [2026-05-16-store-migration-design.md]

## Problem

`cortex-engine` exposes 27+ tools through its MCP server. The Model Context Protocol's `tools/list` response carries `name`, `description`, `inputSchema` — nothing else. With 27 tools competing for an LLM's attention, the agent reliably picks wrong: `recall` vs `retrieve` vs `query` vs `wonder` is genuinely ambiguous from names alone, and the descriptions today are terse one-liners that don't disambiguate.

The audit reviewer framed this as the "cold start discovery problem." The MCP protocol won't help us add structured metadata in the near term, so we encode discoverability into the description itself, and back it with a typed metadata model that future surfaces (REST endpoint, dashboard, doc generator) can consume.

## Goals

1. Every tool has machine-readable category + "when to use" + optional "when not to use" metadata.
2. The MCP server emits descriptions composed from this metadata so the LLM has explicit triage guidance.
3. A `fozikio tools` CLI lists tools by category with their whenToUse blurbs.
4. A `/tools` REST endpoint exposes the full structured metadata for external dashboards.
5. An auto-generated `docs/tools-reference.md` exists as canonical user-facing documentation.
6. TypeScript enforces that all tools have the new metadata fields — compile fails if missing.

## Non-goals

- MCP-native tool grouping (B from the brainstorm). MCP SDK does not natively support categories on `tools/list`; we'd have to send a custom field that clients would ignore.
- Router tool (C from the brainstorm). Collapses 27 tools to one with a `verb` param; loses discoverability advantage that's the entire point of MCP.
- Runtime tool filtering based on session context. A future feature; out of scope for the first cut.

## Design

### Interface change — `ToolDefinition` extension

`src/mcp/tools.ts:106`:

```ts
export type ToolCategory =
  | 'memory'           // recall, retrieve, query, neighbors, wonder, speculate
  | 'consolidation'    // dream, digest, wander, ruminate, abstract
  | 'beliefs'          // believe, belief, validate, contradict
  | 'ops'              // ops-append, ops-query, ops-update
  | 'threads'          // thread-create, thread-update, thread-resolve, threads-list
  | 'journal'          // journal-read, journal-write, evolve, evolution-list
  | 'social'           // social-read, social-update, social-score, social-draft
  | 'content'          // content-create, content-list, content-update
  | 'graph'            // graph-report, link, suggest-links, suggest-tags
  | 'vitals'           // vitals-get, vitals-set
  | 'agents'           // agent-invoke, goal
  | 'maintenance'      // forget, find-duplicates, sleep-pressure, consolidation-status, retrieval-audit
  | 'meta';            // stats, observe, predict, surface, intention, notice, resolve, reflect, query-explain

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;          // NEW required
  whenToUse: string;               // NEW required — one sentence, agent-facing
  doNotUse?: string;               // NEW optional — disambiguators
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}
```

Making `category` and `whenToUse` *required* means TypeScript catches drift — every new tool must specify them.

### Description composition

In the MCP server's `ListTools` handler (`src/mcp/server.ts`), wrap tool definitions before emission:

```ts
function composeMcpDescription(tool: ToolDefinition): string {
  let out = `[${tool.category}] ${tool.description}`;
  out += `\n\nUse when: ${tool.whenToUse}`;
  if (tool.doNotUse) out += `\nDon't use when: ${tool.doNotUse}`;
  return out;
}
```

The `[category]` prefix lets an LLM scan for relevant tools by category before reading bodies. The `Use when` / `Don't use when` lines are the actual disambiguators.

### Description rewrite — full scope

All 27+ tool descriptions get rewritten in this PR. The current state varies from "Recall a memory by name" (too terse) to multi-paragraph blocks (too long). Target: 1-2 sentences explaining *what the tool returns*, followed by structured whenToUse/doNotUse.

Quality bar examples for the memory cluster (highest LLM confusion area):

| tool | category | whenToUse | doNotUse |
|------|----------|-----------|----------|
| `query` | memory | The agent has a natural-language question and wants matching memories ranked by relevance. | The agent already knows the exact memory ID — use `retrieve` instead. |
| `recall` | memory | The agent remembers a memory's name or partial name and wants to fetch it by lookup. | The agent only has a topic — use `query` for semantic search. |
| `retrieve` | memory | The agent has a memory ID and wants the full record. | The agent only has a fuzzy reference — use `query` or `recall`. |
| `neighbors` | memory | The agent has a memory and wants linked/related memories via the graph. | The agent wants semantically similar memories — use `query`. |
| `wonder` | memory | The agent wants to surface low-confidence memories worth examining. | The agent is looking up known information — use `query`. |
| `speculate` | memory | The agent wants generated hypotheses connecting two or more memories. | The agent wants existing stored memories — use `query` or `neighbors`. |

Every other cluster gets the same treatment. The agent implementing this track will write a category guide as part of the PR to document the patterns.

### `fozikio tools` CLI

`src/bin/tools-cmd.ts`:

```
fozikio tools [options]

Options:
  --category <cat>     List only tools in this category
  --json               Emit JSON instead of formatted text
  --search <query>     Filter tools whose name/description/whenToUse contains <query>
```

Default output: tools grouped by category, with name + one-line description + whenToUse blurb.

### `/tools` REST endpoint

In `src/rest/server.ts`, add:

```
GET /tools         → { tools: ToolMetadata[] }
GET /tools/:name   → ToolMetadata
```

Where `ToolMetadata` is `Omit<ToolDefinition, 'handler'>`. This is what a future dashboard consumes.

### Auto-generated `docs/tools-reference.md`

A new build step (`npm run docs:tools`) runs `src/bin/generate-tools-doc.ts`:
- Imports `allTools` (the canonical aggregation from `src/mcp/tools.ts`).
- Emits a markdown file with sections per category, each tool as a subsection with name, description, whenToUse, doNotUse, JSON schema summary.
- Committed to the repo so PRs reflect tool changes in user docs.
- Optionally wired into a pre-commit hook (deferred — separate decision).

### Testing

New `src/mcp/tools.test.ts`:

- Imports the aggregated tool list; asserts every tool has `category`, `whenToUse`, non-empty.
- Asserts `category` is a valid `ToolCategory` enum value.
- Asserts no duplicate names.
- Asserts every tool's `whenToUse` differs from every other's `whenToUse` (catches copy-paste).
- Snapshot test for `composeMcpDescription` on a fixture tool.

## Error handling

Compile-time: TypeScript errors on any tool file missing `category` or `whenToUse` after the interface change. No runtime fallback — the spec is a hard cutover.

## Rollout

Single PR. The 27+ file rewrite is mechanical and the agent doing this track is the natural unit for batching. Each tool file gets:
1. Adds `category: 'foo'`, `whenToUse: '...'`, optional `doNotUse: '...'` to the exported tool object.
2. Rewrites the existing `description` to the new quality bar (1-2 sentences on *what the tool returns*).

The agent will produce a quick category-by-category quality review for the user before commit.

## Out of scope (this spec)

- MCP protocol extensions for native categories.
- Per-session tool filtering or dynamic tool exposure.
- Tool deprecation/versioning system.
- Multi-language tool descriptions.
- Cost/latency annotations per tool.

## Risk notes

- **Description length budget.** Some LLMs truncate or weight long descriptions poorly. The composed format adds ~30-100 chars per tool. We monitor with the doc generator's output and trim ruthlessly if any single tool exceeds 400 chars.
- **Drift between handler and metadata.** A tool's `whenToUse` can lie about behavior. We can't fully prevent this; the test that asserts whenToUse uniqueness is a weak proxy. Future work: integration tests that exercise each tool from its whenToUse description and verify the result shape.
