# TypeSafe Jev (shadow mode)

[TypeSafe](https://docs.typesafe.ai/introduction) **Jev** is a *System One* model. You send it a `state`
and a set of typed questions, and it returns structured answers:

| Type | What it returns |
|---|---|
| **Choice** | an option, with a probability for every option and a confidence |
| **Score** | a probability-weighted position on an ordered rubric, with a confidence |
| **Noul** | the probability that a yes/no statement is true |

All questions in a request run in parallel in one call, typically in about 100–150 ms. Jev does not
generate text, so it can't write a rationale.

The monitor runs Jev in **shadow mode only**. Jev never changes, delays or fails a governance
decision. Its answers are stored next to each authoritative decision so we can benchmark it against
the Foundry LLM judge, Prompt Shields, Guardian and the heuristic session severity, and decide later
whether it should take over any tier.

## Why Jev

| | Foundry LLM judge | Jev |
|---|---|---|
| Output | JSON coerced from generated text, plus one self-reported confidence | Typed answers by construction, with calibrated probabilities per question |
| Latency budget | 4 s fast tier (`gpt-4.1-mini`), 15 s escalation tier (`gpt-5`) | ~100–150 ms per call, whatever the number of questions |
| Cost | Per-token LLM pricing on input and output | $0.042 per million input tokens; output tokens are free |
| Explainability | Free-text rationale | Named signals (per never-rule probabilities, harm score) plus the lane clause it *selects* |
| Weaknesses | Slow, costly, can be argued with | Literal reading, weak on math, dates and indirection; adversarial text in `state` can move answers ([jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13)) |

Shadow mode protects against Jev's documented weak spots. Deterministic lane rules, the system
guard, Prompt Shields and the LLM judge stay authoritative.

## Where Jev runs

| Kind | Decision point | Jev questions | Compared against |
|---|---|---|---|
| `judge` | PDP pre-tool/spawn decisions (`src/governance/pdp.ts`) | One Noul per lane `never` rule, `within_purpose`, `serves_goal`, `follows_untrusted`, a `lane_clause` Choice and a `harm` Score (0–3) | The Foundry judge's final verdict, or the rules/fail-mode verdict when the judge didn't run |
| `injection` | `tool_result` on the categories the lane scans with Prompt Shields | `addresses_ai`, `override_instructions`, `credential_or_exfil`, `tool_execution`, `concealment`, plus a `severity` Score | Prompt Shields `attackDetected` |
| `session_score` | Background job over recently active sessions | `goal_drift`, `sensitive_data`, `destructiveness`, `external_egress` and `autonomy_risk` Scores, plus an `intent` Choice | Heuristic `scoreSession()` severity |
| `guardian_triage` | Intelligence service, for each Guardian trigger | `severity` Score, `incident_type` Choice, `needs_investigation` and `likely_false_positive` Nouls | The Guardian (LLM) investigation outcome |

### Fleet (enterprise monitoring agent)

The Python AgentMon Fleet (`fleet/`, enterprise monitoring of Foundry and Copilot Studio agents) runs
Jev next to its own checks and posts each comparison to `POST /api/gov/jev/shadow` with its
`FLEET_MONITOR_TOKEN` principal (the same `Agent` role it uses for `/api/gov/fleet/*`). The dashboard
groups these as the **Fleet ·** tabs.

| Kind | Decision point | Verdicts (strictness: low → high) | Compared against |
|---|---|---|---|
| `fleet_realtime` | Real-time tool-call gate | `allow` → `block` (`score` = risk 0–100) | The Fleet's deterministic risk score, or the gpt-4.1-mini triage when it ran |
| `fleet_intent` | Session intent scope | `in_scope` → `ambiguous` → `out_of_scope` | The Fleet's intent-scope classifier |
| `fleet_alignment` | Action vs the session's goal | `aligned` → `misaligned` | The Fleet's alignment check |
| `fleet_evasion` | Retry after a block — does it achieve the same effect? | `different` → `same` | The Fleet's same-effect adjudication |
| `fleet_injection` | Tool output / user prompt injection or jailbreak | `clean` → `review` → `attack` | The Fleet's injection / jailbreak detector |
| `fleet_code` | Script necessity and risk | `necessary` → `unnecessary` (`score` = risk 0–100) | The Fleet's code analysis |

Fleet questions and thresholds live in
[`fleet/src/agentmon_fleet/jev_questions.py`](../fleet/src/agentmon_fleet/jev_questions.py) (one
reviewable file), and the client and shadow reporter in
[`fleet/src/agentmon_fleet/jev.py`](../fleet/src/agentmon_fleet/jev.py). The summary's
`jevStricter` / `jevLooser` counts use the strictness order above (see `verdictRank` in
[`stats.ts`](../src/governance/jev/stats.ts)).

Why Jev matters most in the Fleet:

- **Real-time gate.** The Copilot Studio webhook has a 1,000 ms budget. Today the gate consults gpt-4.1-mini only for ambiguous
  scores, and turns off every other semantic check in real time. Jev (~150 ms) runs one battery on every pending
  tool call, alongside the deterministic detectors, so it adds no time to the verdict.
- **Coverage.** LLM analysis is capped at `FLEET_LLM_BUDGET_PER_CYCLE` (60) calls per cycle. Jev has its own budget,
  `FLEET_JEV_BUDGET_PER_CYCLE` (2,000), so intent, injection and jailbreak, alignment, evasion and code checks also run on events
  the LLM never looked at. Offline Fleet calls run on a bounded thread pool, off the detector thread.

Fleet settings (the shared `.env`): `TYPESAFE_API_KEY` (or `FLEET_TYPESAFE_API_KEY`), `FLEET_JEV_MODE=off|shadow`
(`shadow` when a key is set), `FLEET_JEV_MODEL` (pinned `jev-1.13.0`), `FLEET_JEV_TIMEOUT_S` (2.0),
`FLEET_JEV_REALTIME_TIMEOUT_S` (0.3), `FLEET_JEV_BUDGET_PER_CYCLE` (2000), `FLEET_JEV_SHADOW_POST` (true),
`FLEET_JEV_SHADOW_JSONL` (`fleet-jev-shadow.jsonl`). Content sent to TypeSafe goes through the Fleet's redaction
(secrets and PII) first.

### Questions and thresholds (monitor)

The monitor's questions and thresholds all live in
[`src/governance/jev/questions.ts`](../src/governance/jev/questions.ts), except the Guardian triage
questions, which are in `intelligence/src/agentgov_intel/jev_triage.py`. Keeping them together makes
them easy to review. Code turns the answers into a verdict in
[`combine.ts`](../src/governance/jev/combine.ts), following TypeSafe's guidance: ask narrow questions,
put them all in one call, and keep the policy in code.

There are two threshold policies, `strict` (the default) and `permissive`. They apply the same logic
at different thresholds. Select one with `JEV_POLICY`. The values are starting points; tune them
with the benchmark below before relying on them.

## Enabling it

Set a key in `.env` and restart:

```ini
TYPESAFE_API_KEY=ts_...
# JEV_MODEL=jev-1.13.0          # pinned; thresholds are tuned per version, and the jev-latest alias moves
# JEV_SHADOW_SCOPE=judge        # judge | governed (every pre_tool/spawn decision)
# JEV_SHADOW_SAMPLE_RATE=1
```

See the **TypeSafe Jev** section of [.env.example](../.env.example) for every setting: concurrency,
queue size, the injection and session toggles, retention, and Foundry prices for the cost comparison.

### Data egress

Shadow calls send decision context to `api.typesafe.ai`. That context is shaped exactly like what the
LLM judge receives:

- It follows each lane's `judge.dataPolicy`, which is `redacted` by default.
- Secrets are masked even under `full`.
- Injection shadows are skipped for lanes with `metadata-only`, because they need the tool output. They are also skipped for lanes that turned off Prompt Shields (`promptShields.enabled: false`).
- Session digests carry action summaries and counts, never raw payloads.

TypeSafe does not train on customer data. Zero data retention is available only on enterprise plans
([Legal](https://docs.typesafe.ai/legal)). With no key set, nothing leaves the machine.

### Safety of the hot path

Shadow work goes onto a bounded queue (`src/governance/jev/queue.ts`). Governance never waits for it.
Work over `JEV_MAX_QUEUE` is dropped and counted rather than buffered, and errors are recorded but
never raised. Because the queue is bounded, Jev's rate limits (40 requests/s, which can change)
can't pile up work in memory.

## Looking at the results

- **Dashboard → Jev vs LLM**: agreement rate, a confusion matrix of baseline vs Jev, latency
  percentiles, estimated cost, and counts of disagreements where Jev was stricter or looser. There's
  also a table of disagreements that links to each conversation, and the drawer shows the Jev shadow
  next to each judged decision.
- **API**:
  - `GET /api/gov/jev/summary?since=&until=&kind=`
  - `GET /api/gov/jev/shadow?kind=&sessionId=&agree=false&...`
  - `POST /api/gov/jev/shadow` (`PolicyAdmin` or `Agent`), used by the intelligence service and the AgentMon Fleet — accepts `kind: "guardian_triage"` and the `fleet_*` kinds only (`judge`/`injection`/`session_score` → 400; those records are written in-process). `id` and `createdAt` are always server-assigned (client values ignored) and stores are insert-only, so existing records cannot be overwritten via the API.
- **MCP**: the `jev_shadow_summary` tool.

Shadow records are non-authoritative. They sit outside the hash-chained audit log and are pruned
after `JEV_SHADOW_RETENTION_DAYS`, 30 by default.

## Offline benchmark

```powershell
npm run eval:compare -- --dataset judge --policy all --sweep
npm run eval:compare -- --dataset injection --repeat 3
```

This runs every configured provider (Foundry fast/escalation, Prompt Shields, Jev) over the labeled
datasets in [eval/](../eval/README.md). Jev is called once per case, and its answers are recombined
under each policy and each threshold in the sweep. The report is written to `eval/results/<timestamp>/`
and covers:

- accuracy and per-class precision, recall and F1
- deny (attack) recall and the false-allow rate
- escalation rate
- p50, p95 and p99 latency
- tokens and estimated cost
- calibration (Brier score and ECE)
- self-consistency across repeats
- agreement between providers
- per-tag breakdowns (adversarial, benign look-alike, taint)

For Guardian triage, run `python intelligence/scripts/eval_triage.py`.

## Promotion criteria (future)

Jev stays in shadow mode until **all** of these hold, on both the offline datasets and at least two
weeks of live shadow data:

1. Deny recall is at least the Foundry fast tier's, and the false-allow rate is no worse.
2. Jev agrees with the LLM judge on at least 90% of judged decisions, and the disagreements have
   been reviewed.
3. p95 latency is well below the fast judge timeout.
4. Adversarial cases perform at least as well as the Foundry fast tier.

The next step after that would be a cascade: Jev as the fast tier, low-confidence cases escalated to
the `gpt-5` tier, and humans below `humanBelow`. That keeps the LLM for the hard cases and for the
generative work: Guardian reports, lane drafting, chat and goal extraction.
