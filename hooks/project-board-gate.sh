#!/usr/bin/env bash
# ============================================================================
# project-board-gate.sh — PreToolUse hook (Bash + MCP tools)
# ============================================================================
# Production gate for tracked repos. Configurable requirements before push:
#   - Board update (gh issue/project commands)
#   - Ops logging (ops_append via cortex MCP)
#
# Config: .claude/state/project-boards.json
# State:  .claude/state/push-gate-state.txt (session-scoped)
#
# The hook does two things depending on what's happening:
#   1. On board/ops actions → records them in state file
#   2. On git push → checks state file, blocks if requirements unmet
# ============================================================================

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CONFIG_FILE="$PROJECT_DIR/.claude/state/project-boards.json"
STATE_FILE="$PROJECT_DIR/.claude/state/push-gate-state.txt"

# No config = no gate
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{}'
  exit 0
fi

# Read config
CONFIG=$(python3 -c "
import json, sys
c = json.load(open('$CONFIG_FILE'))
print(json.dumps({
  'enabled': c.get('enabled', True),
  'strength': c.get('strength', 'block'),
  'require_board': c.get('on_push', {}).get('require_board_update', True),
  'require_ops': c.get('on_push', {}).get('require_ops_log', False),
  'ops_message': c.get('on_push', {}).get('require_ops_log_message', ''),
  'repos': {k: v for k, v in c.get('repos', {}).items()}
}))
" 2>/dev/null || echo '{"enabled":true,"strength":"block","require_board":true,"require_ops":false,"repos":{}}')

ENABLED=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['enabled'])" 2>/dev/null || echo "True")
STRENGTH=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['strength'])" 2>/dev/null || echo "block")
REQUIRE_BOARD=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['require_board'])" 2>/dev/null || echo "True")
REQUIRE_OPS=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['require_ops'])" 2>/dev/null || echo "False")
OPS_MESSAGE=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['ops_message'])" 2>/dev/null || echo "")

if [[ "$ENABLED" == "False" || "$STRENGTH" == "off" ]]; then
  echo '{}'
  exit 0
fi

# Read input
INPUT=$(cat)

# Detect tool context
TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")

# ═══════════════════════════════════════════════════════════════════════════
# TRACK: MCP ops_append calls → mark ops logged
# ═══════════════════════════════════════════════════════════════════════════
if [[ "$TOOL_NAME" == "mcp__cortex__ops_append" ]]; then
  mkdir -p "$(dirname "$STATE_FILE")"
  echo "ops_logged" >> "$STATE_FILE" 2>/dev/null
  echo '{}'
  exit 0
fi

# Only process Bash commands from here
if [[ "$TOOL_NAME" != "Bash" && -n "$TOOL_NAME" ]]; then
  echo '{}'
  exit 0
fi

COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# ═══════════════════════════════════════════════════════════════════════════
# TRACK: gh board/issue commands → mark board updated for detected repo
# ═══════════════════════════════════════════════════════════════════════════
if echo "$COMMAND" | grep -qE 'gh\s+(project\s+item|issue\s+(create|comment|close|edit)|pr\s+create)'; then
  REPOS=$(echo "$CONFIG" | python3 -c "import json,sys; [print(r) for r in json.load(sys.stdin)['repos']]" 2>/dev/null || echo "")

  mkdir -p "$(dirname "$STATE_FILE")"
  for repo in $REPOS; do
    if echo "$COMMAND" | grep -qi "$repo"; then
      echo "board:$repo" >> "$STATE_FILE" 2>/dev/null
    fi
  done

  # Fallback: cwd-based detection
  CWD_REPO=$(basename "$(pwd)" 2>/dev/null || echo "")
  if echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); exit(0 if '$CWD_REPO' in c['repos'] else 1)" 2>/dev/null; then
    echo "board:$CWD_REPO" >> "$STATE_FILE" 2>/dev/null
  fi

  echo '{}'
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# GATE: git push/merge → check requirements
# ═══════════════════════════════════════════════════════════════════════════
IS_GIT_PUSH=false
if echo "$COMMAND" | grep -qE 'git\s+push'; then
  IS_GIT_PUSH=true
fi

if [[ "$IS_GIT_PUSH" == "false" ]]; then
  echo '{}'
  exit 0
fi

# Detect which tracked repo
DETECTED_REPO=""
REPOS=$(echo "$CONFIG" | python3 -c "import json,sys; [print(r) for r in json.load(sys.stdin)['repos']]" 2>/dev/null || echo "")

for repo in $REPOS; do
  if echo "$COMMAND" | grep -qi "$repo"; then
    DETECTED_REPO="$repo"
    break
  fi
done

if [[ -z "$DETECTED_REPO" ]]; then
  CMD_DIR=$(echo "$COMMAND" | sed -n 's/.*cd[[:space:]]\+\([^[:space:];&]*\).*/\1/p' | head -1 2>/dev/null || echo "")
  DIR_BASE=$(basename "${CMD_DIR:-$(pwd)}" 2>/dev/null || echo "")

  for repo in $REPOS; do
    if [[ "$DIR_BASE" == "$repo" ]]; then
      DETECTED_REPO="$repo"
      break
    fi
  done
fi

# Not a tracked repo — allow
if [[ -z "$DETECTED_REPO" ]]; then
  echo '{}'
  exit 0
fi

# === Check requirements ===
MISSING=""

if [[ "$REQUIRE_BOARD" == "True" ]]; then
  if ! grep -q "^board:${DETECTED_REPO}$" "$STATE_FILE" 2>/dev/null; then
    BOARD_NUM=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['repos']['$DETECTED_REPO']['board_number'])" 2>/dev/null || echo "?")
    BOARD_OWNER=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['repos']['$DETECTED_REPO']['board_owner'])" 2>/dev/null || echo "?")
    MISSING="${MISSING}\\n**Board update required:**\\n"
    MISSING="${MISSING}1. Check board: \`gh project item-list $BOARD_NUM --owner $BOARD_OWNER\`\\n"
    MISSING="${MISSING}2. Update issue: \`gh issue create/comment -R $BOARD_OWNER/$DETECTED_REPO\`\\n"
    MISSING="${MISSING}3. Move items to reflect current status\\n"
  fi
fi

if [[ "$REQUIRE_OPS" == "True" ]]; then
  if ! grep -q "^ops_logged$" "$STATE_FILE" 2>/dev/null; then
    MISSING="${MISSING}\\n**Ops log required:**\\n"
    if [[ -n "$OPS_MESSAGE" ]]; then
      MISSING="${MISSING}${OPS_MESSAGE}\\n"
    else
      MISSING="${MISSING}Call \`ops_append()\` to log what you're pushing and why.\\n"
    fi
    MISSING="${MISSING}\`mcp__cortex__ops_append({ content: \"Pushing: [what changed]\", project: \"$DETECTED_REPO\" })\`\\n"
  fi
fi

# All requirements met — allow
if [[ -z "$MISSING" ]]; then
  echo '{}'
  exit 0
fi

REPO_DESC=$(echo "$CONFIG" | python3 -c "import json,sys; print(json.load(sys.stdin)['repos']['$DETECTED_REPO'].get('description',''))" 2>/dev/null || echo "")
MESSAGE="**[PUSH GATE]** Pushing to \`$DETECTED_REPO\` ($REPO_DESC) — requirements not met:\\n${MISSING}\\nComplete the above, then retry your push.\\n\\n*Config: \`.claude/state/project-boards.json\` — set \`strength\` to \`off\` to disable.*"

if [[ "$STRENGTH" == "block" ]]; then
  HOOK_EVENT=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hook_event_name','PreToolUse'))" 2>/dev/null || echo "PreToolUse")
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "$HOOK_EVENT",
    "permissionDecision": "deny"
  },
  "systemMessage": "$MESSAGE"
}
EOF
else
  cat <<EOF
{
  "systemMessage": "$MESSAGE"
}
EOF
fi
