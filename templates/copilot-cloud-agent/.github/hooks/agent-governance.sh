#!/bin/sh

# Required in the repository/organization secret environment:
#   AGENT_GOVERNANCE_URL=https://your-control-plane.example.com
# Optional:
#   AGENT_GOVERNANCE_TOKEN=<bearer token>
#   AGENT_GOVERNANCE_FAIL_MODE=open|closed (default: open)
#   AGENT_GOVERNANCE_TIMEOUT_SEC=110

TIMEOUT="${AGENT_GOVERNANCE_TIMEOUT_SEC:-110}"
body=$(cat)

is_pre_tool_use=0
printf '%s' "$body" | grep -E '"hookEventName"[[:space:]]*:[[:space:]]*"preToolUse"|"hook_event_name"[[:space:]]*:[[:space:]]*"PreToolUse"|"toolName"[[:space:]]*:|"tool_name"[[:space:]]*:' >/dev/null 2>&1 && is_pre_tool_use=1

decision() {
  printf '{"permissionDecision":"%s","permissionDecisionReason":"%s"}\n' "$1" "$2"
}

if [ -z "$AGENT_GOVERNANCE_URL" ]; then
  if [ "$is_pre_tool_use" -eq 1 ] && [ "${AGENT_GOVERNANCE_FAIL_MODE:-open}" = "closed" ]; then
    decision "deny" "governance service unreachable"
  elif [ "$is_pre_tool_use" -eq 1 ]; then
    decision "allow" "governance service unreachable; fail-open"
  fi
  exit 0
fi

url="${AGENT_GOVERNANCE_URL%/}/hooks/copilot-cloud-agent"
if [ -n "$AGENT_GOVERNANCE_TOKEN" ]; then
  response=$(printf '%s' "$body" | curl -sS --max-time "$TIMEOUT" -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $AGENT_GOVERNANCE_TOKEN" --data-binary @- "$url" 2>/dev/null)
else
  response=$(printf '%s' "$body" | curl -sS --max-time "$TIMEOUT" -X POST -H 'Content-Type: application/json' --data-binary @- "$url" 2>/dev/null)
fi
status=$?

if [ "$is_pre_tool_use" -eq 1 ]; then
  if [ "$status" -eq 0 ] && [ -n "$response" ]; then
    printf '%s\n' "$response" | tr -d '\r'
  elif [ "${AGENT_GOVERNANCE_FAIL_MODE:-open}" = "closed" ]; then
    decision "deny" "governance service unreachable"
  else
    decision "allow" "governance service unreachable; fail-open"
  fi
fi

exit 0
