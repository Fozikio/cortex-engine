/**
 * namespace-resolver.ts — shared namespace resolution for fozikio CLI commands.
 *
 * Resolves the effective namespace prefix that CLI commands should use when
 * reading from or writing to the cortex store. Priority order:
 *
 *   1. Explicit --namespace <ns> flag on the command line
 *   2. The namespace marked `default: true` in the config (set by
 *      loadConfig(cwd, agentName) when --agent is passed)
 *   3. Empty string (= the legacy default namespace)
 *
 * Before this resolver existed, every CLI subcommand silently ignored the
 * agent.yaml default_namespace and --namespace flag, causing fozikio health,
 * vitals, anomalies, and maintain to read empty tables on any workspace that
 * used a non-default namespace.
 */

import type { CortexConfig } from '../core/config.js';

export interface NamespaceArgs {
  /** Value of --namespace <ns> flag, or null if not provided. */
  namespace: string | null;
  /** Value of --agent <name> flag, or null if not provided. */
  agentName: string | null;
}

/**
 * Parse --namespace <ns> and --agent <name> from args. Other arg parsing is
 * left to each command; this only handles the namespace-related flags so the
 * shared helper can be called early.
 */
export function parseNamespaceArgs(args: string[]): NamespaceArgs {
  let namespace: string | null = null;
  let agentName: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--namespace' && args[i + 1]) {
      namespace = args[++i];
    } else if (args[i] === '--agent' && args[i + 1]) {
      agentName = args[++i];
    }
  }

  return { namespace, agentName };
}

/**
 * Resolve the effective namespace prefix from CLI args and config.
 *
 * The returned string is the value to pass to SqliteCortexStore /
 * FirestoreCortexStore constructors (or to createStore's namespace param).
 * An empty string targets the legacy un-prefixed tables; any non-empty value
 * targets tables prefixed with `${namespace}_`.
 */
export function resolveNamespace(args: NamespaceArgs, config: CortexConfig): string {
  if (args.namespace !== null) return args.namespace;

  // Look for the namespace marked default: true in config. loadConfig sets
  // this when called with an agentName matching an entry in the agents block.
  for (const [name, ns] of Object.entries(config.namespaces ?? {})) {
    if (ns.default === true) {
      // The literal name 'default' maps to empty-string prefix (legacy).
      if (name === 'default') return '';
      // Use collections_prefix verbatim if set — must match the literal value
      // the MCP server passes to SqliteCortexStore (src/mcp/server.ts), since
      // both paths feed into the same `${this.ns}_${name}` table-name builder
      // in src/stores/sqlite.ts. Stripping a trailing underscore here would
      // make CLI read a different table than MCP wrote to. See test
      // 'uses collections_prefix verbatim'.
      if (ns.collections_prefix) {
        return ns.collections_prefix;
      }
      return name;
    }
  }

  return '';
}

/**
 * Human-readable label for stderr logging. Empty string is rendered as
 * '(default)' so users can tell whether namespace resolution actually picked
 * up their agent config.
 */
export function namespaceLabel(namespace: string): string {
  return namespace || '(default)';
}
