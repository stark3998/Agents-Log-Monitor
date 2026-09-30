"""agentmon-fleet command line."""
from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any


def _print(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="agentmon-fleet", description="Monitoring fleet for Foundry & Copilot Studio agents")
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--state", help="State DB path (overrides FLEET_STATE_DB)")
    ap.add_argument("--no-llm", action="store_true", help="Deterministic detectors only")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("discover", help="List Foundry accounts/projects in scope")
    c = sub.add_parser("collect", help="Run collectors once and store events (no detection)")
    c.add_argument("--source", action="append", help="law | foundry | dataverse | storage | purview | entra | defender")
    r = sub.add_parser("run", help="Run monitoring cycles")
    r.add_argument("--once", action="store_true")
    r.add_argument("--interval", type=int)
    r.add_argument("--console", action="store_true", help="Print alerts to the console")
    r.add_argument("--agentic", action="store_true", help="Fleet Commander deep-dives new high/critical incidents")
    r.add_argument("--source", action="append")
    sub.add_parser("profiles", help="Show agent charters")
    a = sub.add_parser("alerts", help="Show recent alerts")
    a.add_argument("--limit", type=int, default=50)
    a.add_argument("--json", action="store_true")
    sub.add_parser("incidents", help="Show incidents")
    s = sub.add_parser("sessions", help="Show session intent ledgers")
    s.add_argument("--limit", type=int, default=20)
    sub.add_parser("stats", help="State counters and inference inventory")
    h = sub.add_parser("hooks", help="Serve real-time hook endpoints (Copilot Studio webhook, /evaluate)")
    h.add_argument("--host", default="127.0.0.1")
    h.add_argument("--port", type=int, default=8787)
    q = sub.add_parser("ask", help="Ask the Fleet Commander a question")
    q.add_argument("question", nargs="+")
    inv = sub.add_parser("investigate", help="Deep investigation of a session by the Fleet Commander")
    inv.add_argument("session_id")
    sc = sub.add_parser("scenarios", help="Adversarial scenario runner")
    sc.add_argument("action", choices=["list", "setup", "run", "verify"])
    sc.add_argument("--only", action="append", help="Scenario id / glob / category (repeatable)")
    sc.add_argument("--since", help="ISO time for verify: merge all runs since then (default: last run)")
    sc.add_argument("--identity", choices=["cli", "fleet"], default="cli",
                    help="Caller for setup/run: your Azure CLI login (default) or the fleet identity")
    sc.add_argument("--hooks-url", help="Gate each simulated tool call through the fleet hooks server /evaluate")
    sc.add_argument("--cycle", action="store_true", help="verify: run one fleet cycle first")
    sc.add_argument("--json", action="store_true", help="verify: JSON output")

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("azure", "httpx", "httpx2", "urllib3", "openai", "httpcore", "agent_framework"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    from .config import get_settings
    settings = get_settings()
    if args.state:
        settings.state_db = args.state
    if args.no_llm:
        settings.llm_enabled = False

    if args.cmd == "discover":
        from .collectors.discovery import discover
        inv_ = discover(settings)
        _print({"accounts": inv_.accounts, "projects": [p.__dict__ for p in inv_.projects]})
        return 0

    if args.cmd == "hooks":
        import uvicorn

        from .hooks.server import create_app
        uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")
        return 0

    if args.cmd == "scenarios":
        from .scenarios.runner import main as scenarios_main
        return scenarios_main(args.action, args.only, args.since, identity=args.identity, hooks_url=args.hooks_url,
                              cycle=args.cycle, as_json=args.json, settings=settings)

    from .pipeline import CycleReport, Fleet, build_collectors
    fleet = Fleet(settings, collectors=build_collectors(settings, getattr(args, "source", None)) if getattr(
        args, "source", None) else None, console=getattr(args, "console", False), llm=not args.no_llm)

    if args.cmd == "collect":
        rep = CycleReport()
        new, profiles = fleet.collect(rep)
        _print({**rep.as_dict(), "profiles": [p.name for p in profiles]})
        return 0
    if args.cmd == "run":
        if args.agentic:
            import asyncio
            import time

            from .agents.orchestrator import FleetCommander
            cmd = FleetCommander(fleet)
            while True:
                rep = asyncio.run(cmd.run_cycle())
                _print(rep.as_dict())
                if args.once:
                    break
                time.sleep(args.interval or settings.poll_interval_s)
        elif args.once:
            _print(fleet.run_cycle().as_dict())
        else:
            fleet.run_forever(args.interval)
        return 0
    if args.cmd == "profiles":
        for p in fleet.state.list_profiles():
            print(f"\n== {p.name} ({p.agent_key}) derived_by={p.derived_by}")
            print(f"   purpose: {p.purpose}")
            for u in p.use_cases:
                print(f"   - [{u.id}] {u.description}")
            print(f"   allowed: {[c.value for c in p.allowed_capabilities]}")
            print(f"   forbidden: {[c.value for c in p.forbidden_capabilities]}")
            if p.allowed_destinations:
                print(f"   destinations: {p.allowed_destinations}")
        return 0
    if args.cmd == "alerts":
        alerts = fleet.state.all_alerts(args.limit)
        if args.json:
            _print([a.model_dump(mode="json") for a in alerts])
        else:
            for a_ in alerts:
                print(f"{a_.created_at:%Y-%m-%d %H:%M} [{a_.severity.value:>13}] {a_.score:5.1f} {a_.alert_type:<30} "
                      f"{(a_.agent_name or a_.agent_id or '-')[:28]:<28} {a_.summary[:110]}")
        return 0
    if args.cmd == "incidents":
        for i in fleet.state.list_incidents():
            print(f"{i['id']} [{i['severity']}] {i.get('title')} types={i.get('alert_types')} "
                  f"fused={i.get('fused_score')}")
            for rec in i.get("recommendations", []):
                print(f"    -> {rec['action']} {rec['target']}: {rec['rationale'][:120]}")
        return 0
    if args.cmd == "sessions":
        for s_ in fleet.state.list_sessions(args.limit):
            print(f"{s_['session_id'][:40]:<40} {s_.get('agent_name') or s_['agent_key']:<28} "
                  f"scope={s_.get('scope', '-'):<12} goal={str(s_.get('goal', '-'))[:80]}")
        return 0
    if args.cmd == "stats":
        _print({"state": fleet.state.stats(), "inference_inventory": fleet.state.get_baseline("inference_inventory")})
        return 0
    if args.cmd in ("ask", "investigate"):
        import asyncio

        from .agents.orchestrator import FleetCommander
        cmd = FleetCommander(fleet)
        text = " ".join(args.question) if args.cmd == "ask" else None
        out = asyncio.run(cmd.ask(text) if text else cmd.investigate(args.session_id))
        print(out)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
