#!/bin/sh

PORT="${AGENT_MONITOR_PORT:-4317}"
TIMEOUT="${AGENT_GOVERNANCE_TIMEOUT_SEC:-110}"
SURFACE="${AGENT_GOVERNANCE_SURFACE:-copilot-cli}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    --timeout|-t) TIMEOUT="$2"; shift 2 ;;
    --surface|-s) SURFACE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

body=$(cat)

is_pre_tool_use=0
printf '%s' "$body" | grep -E '"hook_event_name"[[:space:]]*:[[:space:]]*"PreToolUse"|"hookEventName"[[:space:]]*:[[:space:]]*"preToolUse"|"hookEventName"[[:space:]]*:[[:space:]]*"PreToolUse"' >/dev/null 2>&1 && is_pre_tool_use=1
if [ "$is_pre_tool_use" -eq 0 ]; then
  printf '%s' "$body" | grep -E '"tool_name"[[:space:]]*:|"toolName"[[:space:]]*:' >/dev/null 2>&1 && is_pre_tool_use=1
fi

decision() {
  printf '{"permissionDecision":"%s","permissionDecisionReason":"%s"}\n' "$1" "$2"
}

auto_fail_mode() {
  tool=$(printf '%s' "$body" | sed -nE 's/.*"(tool_name|toolName|name)"[[:space:]]*:[[:space:]]*"([^"]+)".*/\2/p' | head -n 1 | tr '[:upper:]' '[:lower:]')
  case "$tool" in
    view|read|grep|glob|ls|search) printf 'open' ;;
    *) printf 'closed' ;;
  esac
}

if [ -n "$AGENT_MONITOR_URL" ]; then
  case "$AGENT_MONITOR_URL" in
    */hooks/*) url="${AGENT_MONITOR_URL%/}" ;;
    *) url="${AGENT_MONITOR_URL%/}/hooks/$SURFACE" ;;
  esac
else
  url="http://127.0.0.1:$PORT/hooks/$SURFACE"
fi

if [ -n "$AGENT_GOVERNANCE_TOKEN" ]; then
  response=$(printf '%s' "$body" | curl -sS --max-time "$TIMEOUT" -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $AGENT_GOVERNANCE_TOKEN" --data-binary @- "$url" 2>/dev/null)
else
  response=$(printf '%s' "$body" | curl -sS --max-time "$TIMEOUT" -X POST -H 'Content-Type: application/json' --data-binary @- "$url" 2>/dev/null)
fi
status=$?

if [ "$is_pre_tool_use" -eq 1 ]; then
  if [ "$status" -eq 0 ] && [ -n "$response" ]; then
    printf '%s\n' "$response" | tr -d '\r'
  else
    fail_mode="${AGENT_GOVERNANCE_FAIL_MODE:-auto}"
    [ "$fail_mode" = "auto" ] && fail_mode="$(auto_fail_mode)"
    if [ "$fail_mode" = "closed" ]; then
      decision "deny" "governance service unreachable"
    else
      decision "allow" "governance service unreachable; fail-open"
    fi
  fi
fi

exit 0
