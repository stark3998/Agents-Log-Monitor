"""Tool → capability mapping. Works across Foundry built-in tools, function/OpenAPI/MCP tools and Copilot Studio actions."""
from __future__ import annotations

import re

from ..models import Capability

# Built-in tool types (Foundry / OpenAI Responses / Copilot Studio) with their inherent capabilities.
BUILTIN_TOOL_CAPS: dict[str, list[Capability]] = {
    "code_interpreter": [Capability.EXEC_CODE],
    "code_interpreter_call": [Capability.EXEC_CODE],
    "file_search": [Capability.KNOWLEDGE],
    "file_search_call": [Capability.KNOWLEDGE],
    "bing_grounding": [Capability.SEARCH, Capability.NET_EGRESS],
    "bing_custom_search": [Capability.SEARCH, Capability.NET_EGRESS],
    "web_search": [Capability.SEARCH, Capability.NET_EGRESS],
    "web_search_preview": [Capability.SEARCH, Capability.NET_EGRESS],
    "web_search_call": [Capability.SEARCH, Capability.NET_EGRESS],
    "azure_ai_search": [Capability.KNOWLEDGE],
    "sharepoint_grounding": [Capability.KNOWLEDGE],
    "fabric_dataagent": [Capability.KNOWLEDGE, Capability.READ_DATA],
    "browser_automation": [Capability.NET_EGRESS, Capability.EXEC_CODE],
    "computer_use_preview": [Capability.EXEC_CODE, Capability.NET_EGRESS],
    "image_generation": [Capability.MODEL_INFERENCE],
    "a2a": [Capability.AGENT_DELEGATION],
    "connected_agent": [Capability.AGENT_DELEGATION],
    "openapi": [Capability.NET_EGRESS],
    "azure_function": [Capability.EXEC_CODE],
    "mcp": [Capability.NET_EGRESS],
    "mcp_call": [Capability.NET_EGRESS],
    # Copilot Studio
    "searchandsummarizecontent": [Capability.KNOWLEDGE],
    "universalsearchtool": [Capability.KNOWLEDGE],
    "generativeanswers": [Capability.KNOWLEDGE],
    "httprequest": [Capability.NET_EGRESS],
    "invokeflowaction": [Capability.EXEC_CODE],
    "invokeconnectoraction": [Capability.NET_EGRESS],
}

# Keyword heuristics over tool name and description; every matching rule contributes.
_NAME_RULES: list[tuple[re.Pattern[str], list[Capability]]] = [
    (re.compile(r"(?i)(secret|password|credential|token|key_?vault|api_?key|certificate)"), [Capability.CRED_ACCESS]),
    (re.compile(r"(?i)(role_?assign|grant_|add_?member|reset_?password|create_?user|disable_?mfa|permission)"),
     [Capability.IDENTITY_ADMIN]),
    (re.compile(r"(?i)(shell|bash|powershell|terminal|run_?command|exec(ute)?_?(command|script)|cmd\b)"),
     [Capability.EXEC_SHELL]),
    (re.compile(r"(?i)(run_?code|execute_?code|python|eval_?code|notebook|sandbox)"), [Capability.EXEC_CODE]),
    (re.compile(r"(?i)(send_?(mail|email|message|sms|teams)|post_?message|notify|reply_?to|forward)"),
     [Capability.SEND_MESSAGE]),
    (re.compile(r"(?i)(delete|remove|drop|purge|destroy|wipe|truncate)"), [Capability.DELETE_DATA]),
    (re.compile(r"(?i)(create|update|write|insert|upsert|set_|patch|modify|upload|save|add_|approve|submit|transfer|pay)"),
     [Capability.WRITE_DATA]),
    (re.compile(r"(?i)(get|list|read|fetch|search|query|lookup|find|retrieve|show|describe|download|detect|analy[sz]e|"
                r"check|audit|assess|compare|summar|report|status|history|inspect|evaluate|validate)"),
     [Capability.READ_DATA]),
    (re.compile(r"(?i)(http|url|web|browse|request|api_?call|webhook)"), [Capability.NET_EGRESS]),
    (re.compile(r"(?i)(deploy|provision|vm_|resource_?group|subscription|terraform|kubectl|scale)"),
     [Capability.CLOUD_ADMIN]),
    (re.compile(r"(?i)(agent|delegate|handoff|sub_?agent)"), [Capability.AGENT_DELEGATION]),
]


def tool_capabilities(name: str | None, tool_type: str | None = None, description: str | None = None) -> list[Capability]:
    caps: list[Capability] = []
    for key in filter(None, [(tool_type or "").lower(), (name or "").lower()]):
        for k, v in BUILTIN_TOOL_CAPS.items():
            if key == k or key.endswith("." + k) or key.startswith(k + "_call"):
                caps.extend(v)
    if not caps:
        # Split camelCase / dotted names so "cr3e5_agent.action.SendEmail" matches send_email.
        hay = re.sub(r"([a-z])([A-Z])", r"\1_\2", f"{name or ''}").replace(".", "_").replace("-", "_")
        for rx, v in _NAME_RULES:
            if rx.search(hay):
                caps.extend(v)
        if not caps and description:
            for rx, v in _NAME_RULES:
                if rx.search(description[:300]):
                    caps.extend(v)
                    break
    seen: list[Capability] = []
    for c in caps or [Capability.UNKNOWN]:
        if c not in seen:
            seen.append(c)
    return seen
