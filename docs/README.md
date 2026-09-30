# Documentation

This folder documents Agent Logs Monitor: a monitoring and governance platform for AI agents. It covers endpoint coding
agents (Claude Code, GitHub Copilot CLI, VS Code agent mode, Copilot cloud agent), agents running in **Microsoft Foundry**
and **Copilot Studio**, and applications that call Foundry models directly.

Start with the guides in the first table. They describe the whole system and link to the reference pages for detail.

## Guides

| Guide | What it covers |
|---|---|
| [Application architecture](architecture/application.md) | Components (monitor server, governance plane, MCP gateway, web UI, intelligence service, monitoring fleet, SDKs), deployment modes, data stores, request flows, security model, repository layout, ports |
| [Agent architecture](architecture/agents.md) | The platform's own agents and detectors: Fleet Commander and specialists, the deterministic detector pipeline, session state, the real-time gate, the PDP judge, Guardian, Drafter and Chat |
| [Data sources](data-sources.md) | Every source the platform ingests: endpoint agents, Foundry, Copilot Studio, Azure activity and network, Defender, Purview, Entra, direct inference. For each: content, collection method, permissions, latency and the detections it powers |
| [Scan methodology: rules vs Jev vs LLM](scan-methodology.md) | The layered evaluation model, where each engine runs, the Jev vs LLM comparison, shadow mode, benchmarks and promotion criteria |
| [Installation](installation.md) | Local setup of every component, configuration via `.env`, hooks, verification and troubleshooting |
| [Cloud configuration](cloud-configuration.md) | Azure, Entra, Foundry, Log Analytics, Power Platform, Microsoft 365 and GitHub configuration; least-privilege RBAC; Terraform/CI deployment; the lab reference setup |
| [Dashboard](dashboard.md) | A tour of the web UI pages |

## Reference

### Governance plane (inline enforcement)

| Page | What it covers |
|---|---|
| [Governance](governance.md) | Lanes, checkpoints, the decision pipeline, modes, fail modes |
| [Lanes](lanes.md) | Lane schema, rule conditions, defaults, rollout workflow |
| [Policies](policies.md) | Reusable policies and presets, simulation, permissions |
| [Data classifiers](classifiers.md) | 96 classifiers, precision, configuration |
| [Endpoint posture](posture.md) | Posture checks, findings lifecycle, one-click fixes |
| [Hook surfaces](governance-surfaces.md) | Claude Code, Copilot CLI, Copilot cloud agent, VS Code adapters |
| [Governance API](governance-api.md) | `/v1` PDP API, `/api/gov` admin API, WebSocket, MCP contracts |
| [MCP server](mcp.md) / [MCP gateway](mcp-gateway.md) | Querying the monitor from MCP clients; governing any MCP client |
| [Intelligence service](intelligence.md) | Guardian investigator, lane drafter, Ask chat, Jev triage |
| [Cloud mode](cloud-mode.md) | Cosmos DB, Redis, audit chain, device enrollment and sync |
| [Security and authentication](security-auth.md) | Entra app registrations, roles, local trust model, threat model |

### Monitoring fleet (Foundry, Copilot Studio, direct inference)

| Page | What it covers |
|---|---|
| [Fleet](fleet.md) | Detector reference, alert taxonomy, charters, LLM usage, configuration reference, lab validation results, roadmap |
| [Fleet sources](fleet-sources.md) | Per-source KQL and APIs, latency, required roles and consents, known gaps |
| [Real-time hooks](fleet-realtime-hooks.md) | Copilot Studio threat detection webhook, Foundry MCP approval, Agent Framework middleware |
| [APIM AI gateway](apim-ai-gateway.md) | Future phase: content capture for direct model inference |

### Analysis and evaluation

| Page | What it covers |
|---|---|
| [Log ingestion](log-ingestion.md) | How endpoint sources are polled or pushed, the `NormalizedEvent` schema, adding a source |
| [Analytics](analytics.md) | Tool classification, sensitive-data detectors, risk rules, severity, redaction, rules tuning |
| [TypeSafe Jev](jev.md) | Jev shadow mode: enabling it, reading results, offline benchmark, promotion criteria |
| [Evaluation datasets](../eval/README.md) | Judge, injection and triage cases; running the comparison |

### Elsewhere in the repository

| Page | What it covers |
|---|---|
| [Infrastructure](../infra/README.md) | Terraform control plane, bootstrap, variables, GitHub Actions deploy |
| [SIEM content](../infra/sentinel/README.md) | Azure Monitor / Sentinel rules and the AgentMon Fleet workbook |
| [Copilot Studio lab setup](../infra/lab/COPILOT-STUDIO-SETUP.md) | Manual Copilot Studio and Power Platform steps (next phase) |
| [Python SDK](../packages/sdk-python/README.md) / [TypeScript SDK](../packages/sdk-ts/README.md) | Governance clients and framework integrations, including the fleet middleware |

## Reading paths

| If you are… | Read |
|---|---|
| Evaluating the platform | [README](../README.md) → [Application architecture](architecture/application.md) → [Data sources](data-sources.md) |
| Installing it on a workstation | [Installation](installation.md) → [Governance](governance.md) → [Hook surfaces](governance-surfaces.md) |
| Monitoring Foundry or Copilot Studio agents | [Cloud configuration](cloud-configuration.md) → [Data sources](data-sources.md) → [Fleet](fleet.md) → [Real-time hooks](fleet-realtime-hooks.md) |
| Tuning detections | [Agent architecture](architecture/agents.md) → [Scan methodology](scan-methodology.md) → [Fleet](fleet.md) → [Analytics](analytics.md) |
| Deploying to Azure | [Cloud configuration](cloud-configuration.md) → [Infrastructure](../infra/README.md) → [Cloud mode](cloud-mode.md) → [Security and authentication](security-auth.md) |
| Running a SOC workflow | [Dashboard](dashboard.md) → [SIEM content](../infra/sentinel/README.md) → [Fleet](fleet.md#alert-taxonomy) |

## Glossary

| Term | Meaning |
|---|---|
| **Lane** | An endpoint agent's governance contract: purpose, allowed actions, never-rules, mode (`observe`/`enforce`). See [lanes.md](lanes.md). |
| **PDP** | Policy Decision Point in the governance plane; returns allow / deny / ask / approval for each checkpoint. |
| **Checkpoint** | A point in an agent's run where the PDP is consulted (for example `pre_tool`). |
| **Charter** | A monitored Foundry or Copilot Studio agent's purpose, use cases, allowed and forbidden capabilities and destinations. It's derived by gpt-5.5 and overridable in `fleet/charters/*.yaml`. |
| **Capability** | A normalized effect of an action (for example `net_egress`, `cred_access`, `exec_code`, `exfil`) used to compare actions with charters. |
| **Canonical event** | The fleet's normalized event (OpenTelemetry GenAI-aligned) produced by every collector. |
| **Denial ledger** | Per-session record of blocked or refused actions, split into agent and user actors; used for workaround and persistence detection. |
| **Taint** | Session state set when tool output contains prompt-injection indicators; later risky actions are judged against it. |
| **Observe / enforce** | Observe logs and alerts would-deny decisions; enforce blocks. Both lanes and fleet charters default to observe. |
| **Shadow mode** | Running an alternative evaluator (TypeSafe Jev) beside the authoritative one and recording agreement, without affecting decisions. |
| **Fleet Commander** | The fleet's Agent Framework orchestrator that delegates to specialist agents. |
| **OWASP LLM / ASI / ATLAS** | OWASP Top 10 for LLM applications, OWASP Top 10 for Agentic Applications, and MITRE ATLAS, used to classify alerts. |
