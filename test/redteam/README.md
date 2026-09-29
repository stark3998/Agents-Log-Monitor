# Governance red-team scenario replay

This suite replays ordered governance decisions through `decide(req, opts)` with a fresh SQLite
store and deterministic mocks for the LLM judge and Prompt Shields.

## Adding a scenario

Add a JSON file under `test/redteam/scenarios/`. Each file is one session:

```json
{
  "id": "my-scenario",
  "description": "What behavior this protects",
  "laneYaml": "id: rt-my-scenario\nversion: 1\nmode: enforce\n...",
  "steps": [
    {
      "checkpoint": "pre_tool",
      "toolName": "Bash",
      "args": { "command": "npm test" },
      "expect": { "verdict": "allow", "stageIn": ["default"] }
    }
  ]
}
```

Steps may be ActionRequest-shaped (`checkpoint`, `toolName`, `args`, `text`, `result`) or Claude
Code hook payloads (`hook_event_name`, `tool_name`, `tool_input`, etc.); hook payloads are converted
with `toActionRequest`.

If `laneYaml` is omitted, the runner loads `lanes/coding-agent.yaml` and switches it to `enforce`.
Expectations assert the **effective** verdict, so observe-mode lanes can assert `deny` while also
checking `"actualVerdict": "allow"` and `"wouldDeny": true`.

Useful per-step controls:

- `"shieldAttack": true` makes the Prompt Shields mock taint that tool result.
- `"judge": { "verdict": "deny", "confidence": 0.9 }` enables the judge mock for that step.
- `"approvalDecision": "approved"` or `"denied"` resolves a pending human approval.
- `"deadlineMs": 30` can force approval expiry/fail-mode paths.

Run with:

```powershell
npm run eval:redteam
```
