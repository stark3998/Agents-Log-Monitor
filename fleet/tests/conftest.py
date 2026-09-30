from __future__ import annotations

import itertools
from datetime import datetime, timedelta, timezone

import pytest

from agentmon_fleet.config import Settings
from agentmon_fleet.detectors.base import Context
from agentmon_fleet.models import AgentProfile, Capability, CanonicalEvent, EventKind, Platform, UseCase
from agentmon_fleet.state import State

T0 = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
_ids = itertools.count()


@pytest.fixture
def settings() -> Settings:
    # typesafe_api_key pinned off so a TYPESAFE_API_KEY in the developer's shell never enables Jev (network) in tests.
    return Settings(_env_file=None, llm_enabled=False, known_callers=[], alerts_jsonl=None, monitor_url=None,
                    alerts_dce=None, alerts_dcr_id=None, law_workspace_id=None, dataverse_org_url=None,
                    foundry_project_endpoint=None, subscription_id=None, storage_account=None,
                    typesafe_api_key=None, jev_shadow_jsonl=None)


@pytest.fixture
def state() -> State:
    s = State(":memory:")
    yield s
    s.close()


@pytest.fixture
def ctx(settings: Settings, state: State) -> Context:
    return Context(settings=settings, state=state, llm=None)


def ev(kind: EventKind, *, at: int = 0, session: str = "s1", agent: str = "agentmon-data-analyst",
       platform: Platform = Platform.FOUNDRY, **kw) -> CanonicalEvent:
    return CanonicalEvent(id=f"e{next(_ids)}", platform=platform, source=kw.pop("source", "test"), kind=kind,
                          occurred_at=T0 + timedelta(seconds=at), agent_id=agent, agent_name=agent, session_id=session,
                          user_id=kw.pop("user_id", "u1"), **kw)


def profile(name: str = "agentmon-data-analyst", allowed=None, forbidden=None, dests=None,
            platform: Platform = Platform.FOUNDRY) -> AgentProfile:
    return AgentProfile(
        agent_key=f"{platform}:{name}", platform=platform, agent_id=name, name=name, purpose="Analyse uploaded CSV data",
        use_cases=[UseCase(id="describe", description="Descriptive statistics over uploaded data",
                           expected_capabilities=[Capability.EXEC_CODE, Capability.READ_DATA])],
        allowed_capabilities=allowed or [Capability.EXEC_CODE, Capability.READ_DATA, Capability.WRITE_DATA,
                                         Capability.MODEL_INFERENCE, Capability.KNOWLEDGE],
        forbidden_capabilities=forbidden or [Capability.NET_EGRESS, Capability.CRED_ACCESS, Capability.EXFIL,
                                             Capability.PERSISTENCE, Capability.DEFENSE_EVASION],
        allowed_destinations=dests or [], derived_by="manual")
