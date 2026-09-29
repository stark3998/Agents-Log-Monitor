from __future__ import annotations

import re
from typing import Any

import yaml

from .af_adapter import AgentRunner, default_runner
from .config import Settings
from .monitor_client import MonitorClient


def extract_yaml(text: str) -> str:
    match = re.search(r"```(?:yaml|yml)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
    return (match.group(1) if match else text).strip()


def lane_id_for_agent(agent_id: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", agent_id.lower()).strip("-") + "-lane"


DRAFTER_INSTRUCTIONS = """You draft governance lane YAML for AI assistants.
Return a short rationale followed by a fenced yaml block. The lane must use mode: observe,
status is not part of the lane, and rules must use LaneCondition fields only:
category, tool, mcpServer, risk, path, domain, command, detector, tainted, description."""


class LaneDrafter:
    def __init__(self, settings: Settings, monitor: MonitorClient, runner: AgentRunner | None = None) -> None:
        self.settings = settings
        self.monitor = monitor
        self.runner = runner or default_runner(settings)

    async def draft(self, agent_id: str, *, description: str | None = None, system_prompt: str | None = None) -> dict[str, Any]:
        agent = await self.monitor.get_agent(agent_id) or {"id": agent_id}
        decisions = (await self.monitor.list_decisions(agentId=agent_id, limit=200)).get("items", [])
        baseline = self._baseline(decisions)
        prompt = self._prompt(agent, baseline, description, system_prompt)
        text = await self.runner.run(prompt, model=self.settings.drafter_deployment, instructions=DRAFTER_INSTRUCTIONS)
        yaml_text = extract_yaml(text)
        validation = await self.monitor.validate_lane(yaml_text=yaml_text)
        if not validation.get("ok"):
            repair_prompt = (
                f"The monitor rejected this lane YAML with errors {validation.get('errors')}.\n"
                f"Repair the YAML only.\n\n{yaml_text}"
            )
            yaml_text = extract_yaml(await self.runner.run(repair_prompt, model=self.settings.drafter_deployment, instructions=DRAFTER_INSTRUCTIONS))
            validation = await self.monitor.validate_lane(yaml_text=yaml_text)
        if not validation.get("ok"):
            return {"lane": None, "rationale": text, "simulation": None, "validation": validation}
        simulation = await self.monitor.simulate_lane(yaml_text=yaml_text, agentId=agent_id, limit=200)
        lane_record = await self.monitor.create_lane(yaml_text=yaml_text, status="proposed")
        return {"lane": lane_record, "rationale": self._rationale(text), "simulation": simulation}

    def _baseline(self, decisions: list[dict[str, Any]]) -> dict[str, Any]:
        tools = sorted({d.get("toolName") for d in decisions if d.get("toolName")})
        categories = sorted({d.get("category") for d in decisions if d.get("category")})
        stages = sorted({d.get("stage") for d in decisions if d.get("stage")})
        hosts = sorted({h for d in decisions for h in re.findall(r"(?:https?://)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})", d.get("reason", ""))})
        return {"tools": tools[:50], "categories": categories, "hosts": hosts[:50], "stages": stages[:30], "samples": decisions[:20]}

    def _prompt(self, agent: dict[str, Any], baseline: dict[str, Any], description: str | None, system_prompt: str | None) -> str:
        lane_id = lane_id_for_agent(str(agent.get("id", "agent")))
        skeleton = {
            "id": lane_id,
            "version": 1,
            "name": f"{agent.get('name') or agent.get('id')} lane",
            "appliesTo": {"agents": [agent.get("id")]},
            "purpose": description or agent.get("purpose") or "Describe the assistant's intended work.",
            "dos": [],
            "never": [],
            "rules": {"deny": [], "allow": [], "judge": [], "approve": []},
            "mode": "observe",
            "failMode": {"default": "closed", "READ": "open"},
            "approval": {"channels": ["dashboard"], "timeoutSec": 300},
            "judge": {"model": "fast", "escalateBelow": 0.7, "humanBelow": 0.45, "dataPolicy": "redacted"},
            "limits": {"actionsPerMin": 30, "loopThreshold": 5},
            "promptShields": {"enabled": True, "scan": ["READ", "NETWORK"], "taintTtlActions": 5},
            "alerts": {"high": ["teams"], "critical": ["teams"]},
            "meta": {"createdBy": "agentgov-intel", "source": "ai-draft"},
        }
        return (
            f"Agent registry record:\n{agent}\n\nRecent activity baseline:\n{baseline}\n\n"
            f"Optional system prompt:\n{system_prompt or ''}\n\n"
            "Draft YAML following this shape and grounded in observed activity:\n"
            f"{yaml.safe_dump(skeleton, sort_keys=False)}"
        )

    def _rationale(self, text: str) -> str:
        return re.sub(r"```(?:yaml|yml)?\s*.*?```", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
