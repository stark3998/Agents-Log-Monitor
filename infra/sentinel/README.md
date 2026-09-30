# AgentMon Fleet: SIEM content

Analytics rules and a workbook for the `AgentMonAlerts_CL` table. The fleet writes that table through the DCE/DCR stream `Custom-AgentMonAlerts` (see [docs/fleet.md](../../docs/fleet.md)).

| File | What it contains |
|---|---|
| `rules.json` | Seven scheduled rules. Each has KQL, a schedule, a severity and its tactics. |
| `workbook.json` | The "AgentMon Fleet" workbook. It shows severity tiles, alert types over time, OWASP Agentic and MITRE ATLAS breakdowns, the riskiest agents and sessions, evasion by actor, Defender for AI alerts and recent alerts. |
| `deploy-sentinel.ps1` | An idempotent deployment script that supports `-WhatIf`. |

## Rules

| Rule | Fires on |
|---|---|
| `agentmon-fleet-high-severity` | Any fleet alert with severity high or critical. |
| `agentmon-fleet-evasion` | `BLOCKED_ACTION_WORKAROUND`, `SOCIAL_ENGINEERING_USER` and `REPEATED_BLOCKED_ATTEMPTS`. |
| `agentmon-fleet-exfiltration` | `DATA_EXFILTRATION` and `UNAPPROVED_DESTINATION`. |
| `agentmon-fleet-injection-then-action` | `PROMPT_INJECTION_SUSPECTED` followed, within 30 minutes and in the same session, by a forbidden capability, exfiltration, goal drift, workaround or credential alert. |
| `agentmon-fleet-user-persistence-multi-agent` | One user raising persistence or jailbreak alerts on two or more agents within 24 hours. |
| `agentmon-fleet-telemetry-tampering` | `TELEMETRY_TAMPERING` and `SENSITIVE_CONTROL_PLANE_OP`. |
| `agentmon-fleet-shadow-inference-defender` | An unregistered or anomalous model caller on an account that also has a Defender for AI `AI.Azure_*` alert. This rule needs `SecurityAlert`, so it is deployed only with the Sentinel target. |

## Deploy

```powershell
# Workspaces without Sentinel: Azure Monitor log search alert rules plus the workbook
./deploy-sentinel.ps1 -ResourceGroup rg-agentmon-lab -Workspace law-agentmon-lab -Target monitor [-ActionGroupId <id>]

# Microsoft Sentinel: analytics rules (incidents grouped by SessionId) plus the workbook under Sentinel > Workbooks
./deploy-sentinel.ps1 -ResourceGroup rg-agentmon-lab -Workspace law-agentmon-lab -Target sentinel [-EnableSentinel]
```

`-EnableSentinel` onboards the workspace to Microsoft Sentinel. That is a billable workspace change, so it only happens when you pass the flag.

Sentinel rules use these settings:
- Alert names and descriptions come from the `Title` and `Summary` columns.
- Severity comes from the `SentinelSeverity` column.
- Entities are mapped as follows:
  - Account from `UserId`
  - IP from `CallerIp`
  - CloudApplication from `AgentName`
- The custom details are `SessionId`, `AgentName`, `AlertType`, `Platform`, `UserId`, the ATLAS columns and the OWASP columns. MITRE ATLAS ids are custom details because the Sentinel `techniques` field accepts only ATT&CK ids.

Lab status: the monitor-target rules and the workbook are deployed to `law-agentmon-lab`. Sentinel is not enabled on that workspace.
