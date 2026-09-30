"""Offline benchmark for the Jev Guardian-triage questions (intelligence/src/agentgov_intel/jev_triage.py).

Usage (from intelligence/):
    .\\.venv\\Scripts\\python scripts/eval_triage.py [--cases ../eval/triage-cases.jsonl]
        [--concurrency 4] [--limit N] [--json [PATH]] [--show-misses]

Prints severity accuracy (exact and within one level), incident_type accuracy, investigate
precision/recall, p50/p95 latency and token totals. Exits 0 with a skip message when
TYPESAFE_API_KEY is not configured (the repo-root .env is honoured like the service).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve()
INTEL_ROOT = HERE.parents[1]
REPO_ROOT = INTEL_ROOT.parent
sys.path.insert(0, str(INTEL_ROOT / "src"))

from agentgov_intel.config import load_settings  # noqa: E402
from agentgov_intel.guardian import GuardianTrigger  # noqa: E402
from agentgov_intel.jev_triage import SEVERITY_LEVELS, TRIAGE_QUESTIONS_VERSION, JevTriage, TriageResult  # noqa: E402


def load_cases(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def to_trigger(case: dict[str, Any]) -> GuardianTrigger:
    t = case["trigger"]
    return GuardianTrigger(
        trigger=t["kind"],
        severity="medium",  # detector severity is never sent to Jev
        confidence=0.0,
        title=t.get("title") or t["kind"],
        agent_ids=list(t.get("agentIds") or []),
        session_ids=list(t.get("sessionIds") or []),
        decision_ids=[d["id"] for d in case.get("decisions", [])],
        summary=t.get("reason") or "",
    )


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = max(0, min(len(ordered) - 1, math.ceil(pct / 100.0 * len(ordered)) - 1))
    return ordered[k]


def score(cases: list[dict[str, Any]], results: list[TriageResult]) -> dict[str, Any]:
    n = len(cases)
    ok = [(c, r) for c, r in zip(cases, results) if r.ok]
    errors = n - len(ok)
    sev_exact = sum(r.severity == c["expected"]["severity"] for c, r in ok)
    sev_within = sum(
        abs(SEVERITY_LEVELS.index(r.severity) - SEVERITY_LEVELS.index(c["expected"]["severity"])) <= 1 for c, r in ok
    )
    type_acc = sum(r.incident_type == c["expected"]["incident_type"] for c, r in ok)
    tp = sum(bool(r.investigate) and c["expected"]["investigate"] for c, r in ok)
    fp = sum(bool(r.investigate) and not c["expected"]["investigate"] for c, r in ok)
    fn = sum((not r.investigate) and c["expected"]["investigate"] for c, r in ok)
    latencies = [r.latency_ms for r in results]
    in_tok = sum(r.input_tokens or 0 for r in results)
    out_tok = sum(r.output_tokens or 0 for r in results)
    denom = len(ok) or 1
    return {
        "cases": n,
        "errors": errors,
        "severityExact": round(sev_exact / denom, 4),
        "severityWithinOne": round(sev_within / denom, 4),
        "incidentTypeAccuracy": round(type_acc / denom, 4),
        "investigatePrecision": round(tp / (tp + fp), 4) if (tp + fp) else None,
        "investigateRecall": round(tp / (tp + fn), 4) if (tp + fn) else None,
        "latencyP50Ms": round(percentile(latencies, 50), 1),
        "latencyP95Ms": round(percentile(latencies, 95), 1),
        "inputTokens": in_tok,
        "outputTokens": out_tok,
        "avgInputTokens": round(in_tok / n, 1) if n else 0,
    }


async def run(args: argparse.Namespace) -> int:
    settings = load_settings()
    if not settings.typesafe_api_key:
        print("SKIP: TYPESAFE_API_KEY is not set; Jev triage eval not run.")
        return 0
    cases = load_cases(Path(args.cases))
    if args.limit:
        cases = cases[: args.limit]
    triager = JevTriage(settings)
    sem = asyncio.Semaphore(max(1, args.concurrency))

    async def one(case: dict[str, Any]) -> TriageResult:
        async with sem:
            return await triager.triage(to_trigger(case), case.get("decisions", []))

    started = time.perf_counter()
    try:
        results = await asyncio.gather(*(one(c) for c in cases))
    finally:
        await triager.aclose()
    wall = time.perf_counter() - started
    metrics = score(cases, list(results))
    model = next((r.model for r in results if r.ok), settings.jev_model)

    print(f"Jev guardian triage eval - model {model}, questions {TRIAGE_QUESTIONS_VERSION}, {len(cases)} cases, {wall:.1f}s wall")
    for key, value in metrics.items():
        print(f"  {key:<22} {value}")
    if args.show_misses:
        for case, r in zip(cases, results):
            exp = case["expected"]
            if r.error or r.severity != exp["severity"] or r.incident_type != exp["incident_type"] or r.investigate != exp["investigate"]:
                print(f"  MISS {case['id']}: expected {exp} got severity={r.severity} type={r.incident_type} "
                      f"investigate={r.investigate} error={r.error} | {r.rationale}")

    if args.json is not None:
        out = Path(args.json) if args.json else REPO_ROOT / "eval" / "results" / f"triage-{time.strftime('%Y%m%d-%H%M%S')}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "model": model,
            "questionsVersion": TRIAGE_QUESTIONS_VERSION,
            "metrics": metrics,
            "results": [{"id": c["id"], "expected": c["expected"], **asdict(r)} for c, r in zip(cases, results)],
        }
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"  wrote {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cases", default=str(REPO_ROOT / "eval" / "triage-cases.jsonl"))
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--json", nargs="?", const="", default=None, help="Write JSON results (default eval/results/triage-<ts>.json)")
    parser.add_argument("--show-misses", action="store_true")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
