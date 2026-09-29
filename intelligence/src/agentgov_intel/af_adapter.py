from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from typing import Any, Protocol

from .config import Settings
from .tools import MonitorMCPToolFactory


class AgentRunner(Protocol):
    async def run(self, prompt: str, *, model: str, instructions: str, tools: Iterable[str] = ()) -> str: ...
    def stream(self, prompt: str, *, model: str, instructions: str, tools: Iterable[str] = ()) -> AsyncIterator[Any]: ...


def _text_from_result(result: Any) -> str:
    if isinstance(result, str):
        return result
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text
    messages = getattr(result, "messages", None)
    if messages:
        last = messages[-1]
        text = getattr(last, "text", None) or getattr(last, "content", None)
        if isinstance(text, str):
            return text
    return str(result)


class MicrosoftAgentFrameworkRunner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._credential: Any | None = None
        self._tool_factory = MonitorMCPToolFactory(settings)

    async def aclose(self) -> None:
        if self._credential is not None:
            await self._credential.close()

    def _get_credential(self) -> Any:
        if self._credential is None:
            from azure.identity.aio import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        return self._credential

    def _client(self, model: str) -> Any:
        # Agent Framework 1.19 exposes OpenAIChatClient for Azure OpenAI-compatible
        # deployments and FoundryChatClient for project endpoints. Some older docs
        # refer to AzureOpenAIChatClient / AzureAIAgentClient, so keep compatible
        # probes but prefer the installed 1.x names.
        errors: list[Exception] = []
        endpoint = self.settings.azure_openai_endpoint or self.settings.foundry_project_endpoint
        client_types: list[Any] = []
        if self.settings.foundry_project_endpoint and not self.settings.azure_openai_endpoint:
            try:
                from agent_framework_foundry import FoundryChatClient

                return FoundryChatClient(
                    project_endpoint=self.settings.foundry_project_endpoint,
                    model=model,
                    credential=self._get_credential(),
                )
            except Exception as exc:  # pragma: no cover - depends on Azure env/package
                errors.append(exc)
        for mod_name, attr in (
            ("agent_framework.azure", "AzureOpenAIChatClient"),
            ("agent_framework_openai", "AzureOpenAIChatClient"),
            ("agent_framework.openai", "OpenAIChatClient"),
            ("agent_framework_openai", "OpenAIChatClient"),
        ):
            try:
                mod = __import__(mod_name, fromlist=[attr])
                client_types.append(getattr(mod, attr))
            except Exception as exc:  # pragma: no cover - depends on installed AF version
                errors.append(exc)
        for cls in client_types:
            for kwargs in (
                {"credential": self._get_credential(), "azure_endpoint": endpoint, "model": model},
                {"credential": self._get_credential(), "endpoint": endpoint, "deployment_name": model},
                {"credential": self._get_credential(), "endpoint": endpoint, "model": model},
                {"model": model},
            ):
                try:
                    return cls(**{k: v for k, v in kwargs.items() if v})
                except TypeError as exc:
                    errors.append(exc)
        raise RuntimeError("Unable to create Microsoft Agent Framework chat client") from (errors[-1] if errors else None)

    def _agent(self, *, model: str, instructions: str, tools: Iterable[str]) -> Any:
        from agent_framework import Agent

        mcp_tools = tuple(tools)
        tool = None
        if mcp_tools:
            tool = self._tool_factory.streamable_http_tool(
                name="monitor",
                description="Governance monitor MCP tools",
                allowed_tools=mcp_tools,
            )
        return Agent(client=self._client(model), name="agentgov-intelligence", instructions=instructions, tools=tool)

    async def run(self, prompt: str, *, model: str, instructions: str, tools: Iterable[str] = ()) -> str:
        agent = self._agent(model=model, instructions=instructions, tools=tools)
        async with agent:
            result = await agent.run(prompt)
        return _text_from_result(result)

    async def stream(self, prompt: str, *, model: str, instructions: str, tools: Iterable[str] = ()) -> AsyncIterator[Any]:
        agent = self._agent(model=model, instructions=instructions, tools=tools)
        async with agent:
            async for chunk in agent.run(prompt, stream=True):
                yield chunk


def default_runner(settings: Settings) -> MicrosoftAgentFrameworkRunner:
    return MicrosoftAgentFrameworkRunner(settings)
