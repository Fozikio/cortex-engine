/**
 * OpenClaw plugin entry for cortex.
 *
 * The cortex MCP server is contributed DECLARATIVELY, via the `mcpServers`
 * block in openclaw.plugin.json. OpenClaw reads that manifest without
 * executing plugin code, so there is genuinely no runtime registration to do
 * here.
 *
 * This file still has to exist. `package.json` must declare
 * `openclaw.extensions`, and OpenClaw never executes plugin code to infer
 * missing manifest data - a plugin without an entry is rejected at publish
 * time, not merely warned about. Treating the validator's
 * `package-openclaw-entry-missing` finding as advisory was wrong.
 *
 * Deliberately plain ESM rather than TypeScript compiled to dist/: declaring
 * `runtimeExtensions` obliges the built artifact to exist, and a declared but
 * missing artifact fails install with a packaging error instead of falling
 * back to source. A single .mjs with nothing to build cannot drift out of sync
 * with its own build output.
 *
 * Keep this module side-effect free at import time. OpenClaw may evaluate it
 * during non-activating discovery loads, so no clients, sockets, subprocesses
 * or credential reads at top level.
 */

/** @type {{id: string, name: string, description: string, register: (api: unknown) => void}} */
export default {
  id: 'cortex',
  name: 'Cortex',
  description:
    'Persistent memory and typed cognition for OpenClaw agents. 60 cortex tools over MCP, running locally on SQLite and Ollama.',
  register() {
    // Intentionally empty. Capabilities arrive through the manifest's
    // mcpServers entry; there is nothing to register imperatively.
  },
};
