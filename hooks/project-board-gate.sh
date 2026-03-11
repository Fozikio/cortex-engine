#!/usr/bin/env bash
# ============================================================================
# project-board-gate.sh — PreToolUse hook (Bash)
# ============================================================================
# Production gate: blocks git push/merge to tracked repos unless the project
# board has been updated this session. Configurable via project-boards.json.
#
# Part of cortex-kit. Designed for production agents where project tracking
# is fundamental, not optional.
#
# Config: .claude/state/project-boards.json
# State:  .claude/state/board-updated-repos.txt (session-scoped, cleared on start)
#
# Strength levels (from config):
#   "block"   — prevents git push until board is updated (default)
#   "enforce" — strong warning, allows push
#   "off"     — disabled
#
# Installation:
#   1. Copy project-boards.json.example to .claude/state/project-boards.json
#   2. Edit repo→board mappings for your project
#   3. Register in settings.json as PreToolUse hook on Bash (timeout: 8)
#   4. Clear state file on SessionStart (add to session-lifecycle.sh)
# ============================================================================

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CONFIG_FILE="$PROJECT_DIR/.claude/state/project-boards.json"
STATE_FILE="$PROJECT_DIR/.claude/state/board-updated-repos.txt"

# No config = no gate
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{}'
  exit 0
fi

# Read config
ENABLED=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('enabled', True))" 2>/dev/null || echo "True")
STRENGTH=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('strength', 'block'))" 2>/dev/null || echo "block")

if [[ "$ENABLED" == "False" || "$STRENGTH" == "off" ]]; then
  echo '{}'
  exit 0
fi

# Read the command from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

# === GATE 1: Detect git push/merge to tracked repos ===
IS_GIT_PUSH=false
IS_GIT_MERGE=false
if echo "$COMMAND" | grep -qE 'git\s+push'; then
  IS_GIT_PUSH=true
fi
if echo "$COMMAND" | grep -qE 'git\s+merge'; then
  IS_GIT_MERGE=true
fi

# Not a tracked git command — check for board update commands
if [[ "$IS_GIT_PUSH" == "false" && "$IS_GIT_MERGE" == "false" ]]; then
  if echo "$COMMAND" | grep -qE 'gh\s+(project\s+item-edit|issue\s+(create|comment|close)|pr\s+create)'; then
    REPOS=$(python3 -c "
import json
c = json.load(open('$CONFIG_FILE'))
for r in c.get('repos', {}):
    print(r)
" 2>/dev/null || echo "")

    mkdir -p "$(dirname "$STATE_FILE")"
    for repo in $REPOS; do
      if echo "$COMMAND" | grep -qi "$repo"; then
        echo "$repo" >> "$STATE_FILE" 2>/dev/null
      fi
    done

    CWD_REPO=$(basename "$(pwd)" 2>/dev/null || echo "")
    if python3 -c "import json; c=json.load(open('$CONFIG_FILE')); exit(0 if '$CWD_REPO' in c.get('repos',{}) else 1)" 2>/dev/null; then
      echo "$CWD_REPO" >> "$STATE_FILE" 2>/dev/null
    fi
  fi

  echo '{}'
  exit 0
fi

# === Detect which tracked repo this targets ===
DETECTED_REPO=""
REPOS=$(python3 -c "
import json
c = json.load(open('$CONFIG_FILE'))
for r in c.get('repos', {}):
    print(r)
" 2>/dev/null || echo "")

for repo in $REPOS; do
  if echo "$COMMAND" | grep -qi "$repo"; then
    DETECTED_REPO="$repo"
    break
  fi
done

if [[ -z "$DETECTED_REPO" ]]; then
  CMD_DIR=$(echo "$COMMAND" | grep -oP 'cd\s+\K[^\s;&]+' | head -1 || echo "")
  if [[ -n "$CMD_DIR" ]]; then
    DIR_BASE=$(basename "$CMD_DIR" 2>/dev/null || echo "")
  else
    DIR_BASE=$(basename "$(pwd)" 2>/dev/null || echo "")
  fi

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

# === Check if board was updated this session ===
BOARD_UPDATED=false
if [[ -f "$STATE_FILE" ]] && grep -q "^${DETECTED_REPO}$" "$STATE_FILE" 2>/dev/null; then
  BOARD_UPDATED=true
fi

if [[ "$BOARD_UPDATED" == "true" ]]; then
  echo '{}'
  exit 0
fi

# === BLOCK or ENFORCE ===
BOARD_NUM=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['repos']['$DETECTED_REPO']['board_number'])" 2>/dev/null || echo "?")
BOARD_OWNER=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['repos']['$DETECTED_REPO']['board_owner'])" 2>/dev/null || echo "?")
REPO_DESC=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c['repos']['$DETECTED_REPO'].get('description',''))" 2>/dev/null || echo "")

MESSAGE="**[PROJECT BOARD GATE]** You are pushing to \`$DETECTED_REPO\` ($REPO_DESC) but haven't updated the project board this session.\n\n**Before pushing, update the board:**\n1. Check current board: \`gh project item-list $BOARD_NUM --owner $BOARD_OWNER\`\n2. Create or update the relevant issue: \`gh issue create/comment -R $BOARD_OWNER/$DETECTED_REPO\`\n3. Move board items to reflect current status\n4. Then retry your push\n\n**To skip (not recommended):** Set \`\"strength\": \"off\"\` in \`.claude/state/project-boards.json\`"

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
