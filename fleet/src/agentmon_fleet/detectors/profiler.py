"""Profiler: derives each agent's charter (purpose, use cases, allowed/forbidden capabilities) from its definition."""
from __future__ import annotations

import fnmatch
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from ..llm import untrusted
from ..models import AgentProfile, Capability, UseCase, utcnow
from ..normalize.capabilities import tool_capabilities
from .base import Context

log = logging.getLogger(__name__)

HIGH_RISK = [Capability.CRED_ACCESS, Capability.PERSISTENCE, Capability.PRIV_ESC, Capability.DEFENSE_EVASION,
             Capability.DESTRUCTIVE, Capability.EXFIL, Capability.DOWNLOAD_EXEC, Capability.IDENTITY_ADMIN]
ALWAYS_ALLOWED = [Capability.MODEL_INFERENCE, Capability.KNOWLEDGE, Capability.UNKNOWN]
CHARTER_DIR = Path(__file__).resolve().parents[3] / "charters"


class _UseCase(BaseModel):
    id: str
    description: str
    expected_capabilities: list[Capability] = Field(default_factory=list)


class CharterDraft(BaseModel):
    purpose: str = Field(description="One sentence describing what the agent is for")
    use_cases: list[_UseCase] = Field(description="3-8 concrete tasks the agent is designed to perform")
    allowed_capabilities: list[Capability]
    forbidden_capabilities: list[Capability]
    allowed_destinations: list[str] = Field(description="Hostnames/domains the agent legitimately needs; empty if none")
    out_of_scope: list[str] = Field(description="Requests or actions that are clearly outside this agent's job")


PROFILER_SYSTEM = """You are the Profiler in an AI-agent security monitoring fleet. Given an agent's definition
(name, description, system instructions, tools, knowledge), write its security charter: what it is for, the concrete
use cases it serves, which capabilities those use cases need, which capabilities it must never exercise, the network
destinations it legitimately needs, and what is out of scope. Be conservative: a capability is allowed only if a tool or
instruction clearly requires it. Code execution for data analysis does NOT imply credential access, persistence,
privilege escalation, destructive actions, defense evasion or data exfiltration."""


def heuristic_charter(p: AgentProfile) -> AgentProfile:
    allowed: list[Capability] = list(ALWAYS_ALLOWED)
    for t in p.tools:
        for c in tool_capabilities(t.get("name"), t.get("type"), t.get("description")):
            if c not in allowed:
                allowed.append(c)
    if Capability.EXEC_CODE in allowed:
        # Sandboxed code for analysis usually reads/writes scratch files.
        allowed += [c for c in (Capability.READ_DATA, Capability.WRITE_DATA) if c not in allowed]
    p.allowed_capabilities = allowed
    p.forbidden_capabilities = [c for c in HIGH_RISK if c not in allowed]
    p.purpose = p.purpose or (p.description or p.instructions[:240] or p.name)
    return p


def charter_dir() -> Path:
    from ..config import get_settings
    configured = get_settings().charter_dir
    return Path(configured) if configured else CHARTER_DIR


def _load_overrides() -> list[dict]:
    root = charter_dir()
    if not root.is_dir():
        return []
    docs = []
    for f in sorted(root.glob("*.y*ml")):
        try:
            d = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            docs.extend(d if isinstance(d, list) else [d])
        except yaml.YAMLError as exc:
            log.warning("bad charter %s: %s", f, exc)
    return docs


def apply_overrides(p: AgentProfile, overrides: list[dict]) -> AgentProfile:
    """YAML charters (fleet/charters/*.yaml) take precedence over derived fields. Match by name glob or agent id."""
    for o in overrides:
        pattern = str(o.get("match", "")).lower()
        if not pattern or not (fnmatch.fnmatch(p.name.lower(), pattern) or pattern == (p.agent_id or "").lower()):
            continue
        if o.get("platform") and o["platform"] != p.platform.value:
            continue
        for fld in ("purpose", "allowed_destinations", "out_of_scope", "block_threshold"):
            if o.get(fld) is not None:
                setattr(p, fld, o[fld])
        if "enforce" in o:
            p.enforce = bool(o["enforce"])
        if o.get("allowed_capabilities"):
            p.allowed_capabilities = [Capability(c) for c in o["allowed_capabilities"]]
        if o.get("forbidden_capabilities"):
            p.forbidden_capabilities = [Capability(c) for c in o["forbidden_capabilities"]]
        if o.get("use_cases"):
            p.use_cases = [UseCase(**u) for u in o["use_cases"]]
        p.derived_by = "llm+manual" if p.derived_by.startswith("llm") else "manual"
    return p


class Profiler:
    """Keeps agent charters current. LLM drafting only runs when an agent's definition hash changes."""

    name = "profiler"

    def __init__(self) -> None:
        self.overrides = _load_overrides()

    def refresh(self, incoming: list[AgentProfile], ctx: Context) -> list[AgentProfile]:
        changed: list[AgentProfile] = []
        self.overrides = _load_overrides()
        todo: list[tuple[AgentProfile, AgentProfile | None, object | None]] = []
        for p in {q.agent_key: q for q in incoming}.values():
            prev = ctx.state.get_profile(p.agent_key)
            if prev and prev.definition_hash == p.definition_hash and prev.derived_by in ("llm", "manual", "llm+manual"):
                base = prev.model_copy(deep=True)
                base.enforce = None  # enforce comes only from YAML charters; re-derive it every cycle
                cur = apply_overrides(base, self.overrides)
                if cur.model_dump(exclude={"updated_at"}) != prev.model_dump(exclude={"updated_at"}):
                    ctx.state.put_profile(cur)
                ctx.profiles[p.agent_key] = cur
                continue
            p = heuristic_charter(p)
            llm = ctx.take_llm() if (p.instructions or p.tools or p.description) else None
            todo.append((p, prev, llm))

        def draft(item: tuple[AgentProfile, AgentProfile | None, object | None]) -> CharterDraft | None:
            p, _, llm = item
            if llm is None:
                return None
            try:
                return llm.structured(PROFILER_SYSTEM, untrusted({  # type: ignore[attr-defined]
                    "name": p.name, "platform": p.platform.value, "description": p.description,
                    "instructions": p.instructions[:6000], "tools": p.tools[:40], "knowledge": p.knowledge[:20]}),
                    CharterDraft, effort="low")
            except Exception as exc:
                log.warning("profiler LLM failed for %s: %s", p.name, exc)
                return None

        # Charter drafts are independent per agent: draft them concurrently (a fresh fleet may see dozens of agents).
        with ThreadPoolExecutor(max_workers=6) as pool:
            drafts = list(pool.map(draft, todo))
        for (p, prev, _), d in zip(todo, drafts):
            if d is not None:
                p.purpose = d.purpose
                p.use_cases = [UseCase(**u.model_dump()) for u in d.use_cases]
                tool_caps = set(p.allowed_capabilities)
                p.allowed_capabilities = sorted(tool_caps | set(d.allowed_capabilities), key=str)
                p.forbidden_capabilities = sorted(
                    (set(p.forbidden_capabilities) | set(d.forbidden_capabilities)) - tool_caps, key=str)
                p.allowed_destinations = d.allowed_destinations
                p.out_of_scope = d.out_of_scope
                p.derived_by = "llm"
            p = apply_overrides(p, self.overrides)
            p.updated_at = utcnow()
            ctx.state.put_profile(p)
            ctx.profiles[p.agent_key] = p
            if prev and prev.definition_hash != p.definition_hash:
                changed.append(p)
        return changed
