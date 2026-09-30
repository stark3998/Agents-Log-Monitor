"""Off-thread Jev shadow comparisons for the OFFLINE detectors (intent, alignment, evasion, injection, code).

SHADOW MODE ONLY: nothing here may change an alert, score, ledger or LLM call. Detectors call ``schedule(...)`` on
their own thread, which (1) skips real-time contexts, (2) consumes one unit of the per-cycle Jev budget
deterministically via ``ctx.take_jev()``, and (3) hands a closure over an immutable SNAPSHOT of the inputs to a
bounded shared thread pool. The worker builds the Jev state, calls ``FleetJev.ask`` (never raises, hard deadline),
combines the answers, and posts a comparison record through the non-blocking ``ShadowReporter``.

The executor is bounded (``MAX_PENDING`` jobs); when full, new jobs are dropped and counted, never queued without
limit and never blocking the detector. ``drain(timeout)`` waits (bounded) for in-flight jobs at the end of a cycle.
Prompts/answers are never logged.
"""
from __future__ import annotations

import concurrent.futures as cf
import logging
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

from . import jev as _jevmod
from .config import Settings
from .jev import JevResult, jev_outcome

log = logging.getLogger(__name__)

MAX_WORKERS = 8
MAX_PENDING = 2000
DEFAULT_DRAIN_S = 10.0


class ShadowExecutor:
    """Bounded thread pool: ``submit`` never raises or blocks; overflow is dropped and counted."""

    def __init__(self, max_workers: int = MAX_WORKERS, max_pending: int = MAX_PENDING) -> None:
        self.max_workers = max(1, int(max_workers))
        self.max_pending = max(1, int(max_pending))
        self._pool: cf.ThreadPoolExecutor | None = None
        self._cond = threading.Condition()
        self._pending = 0
        self._stats = {"submitted": 0, "completed": 0, "dropped": 0, "errors": 0}

    def _executor(self) -> cf.ThreadPoolExecutor:
        if self._pool is None:
            self._pool = cf.ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix="fleet-jev-shadow")
        return self._pool

    def submit(self, fn: Callable[[], Any]) -> bool:
        """Run ``fn`` off-thread. False when dropped (queue full / executor unusable). Never raises."""
        try:
            with self._cond:
                if self._pending >= self.max_pending:
                    self._stats["dropped"] += 1
                    return False
                self._pending += 1
                self._stats["submitted"] += 1
                pool = self._executor()
            try:
                pool.submit(self._run, fn)
            except Exception:
                with self._cond:
                    self._pending -= 1
                    self._stats["submitted"] -= 1
                    self._stats["dropped"] += 1
                    self._cond.notify_all()
                return False
            return True
        except Exception:  # pragma: no cover - defensive
            return False

    def _run(self, fn: Callable[[], Any]) -> None:
        try:
            fn()
        except Exception as exc:
            with self._cond:
                self._stats["errors"] += 1
            log.debug("jev shadow job failed: %s", type(exc).__name__)
        finally:
            with self._cond:
                self._pending -= 1
                self._stats["completed"] += 1
                self._cond.notify_all()

    def drain(self, timeout: float = DEFAULT_DRAIN_S) -> bool:
        """Wait until no job is pending, at most ``timeout`` seconds. True when fully drained."""
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._cond:
            while self._pending > 0:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(left)
            return True

    def stats(self) -> dict[str, int]:
        with self._cond:
            return {**self._stats, "pending": self._pending, "max_pending": self.max_pending,
                    "workers": self.max_workers}

    def shutdown(self, wait: bool = False) -> None:
        with self._cond:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=wait, cancel_futures=not wait)


_EXEC = ShadowExecutor()


def get_executor() -> ShadowExecutor:
    return _EXEC


def set_executor_for_tests(ex: ShadowExecutor | None) -> None:
    """Replace the shared executor (None → a fresh default one)."""
    global _EXEC
    _EXEC = ex or ShadowExecutor()


def submit(fn: Callable[[], Any]) -> bool:
    return _EXEC.submit(fn)


def drain(timeout: float = DEFAULT_DRAIN_S, *, flush_reporter: bool = True) -> bool:
    """Bounded wait for in-flight jobs, then (with the remaining time) for the ShadowReporter queue. Never raises."""
    try:
        deadline = time.monotonic() + max(0.0, float(timeout))
        ok = _EXEC.drain(timeout)
        rep = getattr(_jevmod, "_REPORTER", None)  # only flush a reporter that already exists
        if flush_reporter and rep is not None and hasattr(rep, "flush"):
            ok = bool(rep.flush(max(0.0, deadline - time.monotonic()))) and ok
        return ok
    except Exception:  # pragma: no cover - defensive
        return False


def stats() -> dict[str, int]:
    return _EXEC.stats()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Comparison job
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
Judge = Callable[[dict[str, Any]], Mapping[str, Any]]
Agree = Callable[[Mapping[str, Any], Mapping[str, Any]], "bool | None"]


def _err(exc: BaseException) -> str:
    first = (str(exc).splitlines() or [""])[0]
    return f"{type(exc).__name__}: {first[:200]}"


def _default_agree(out: Mapping[str, Any], baseline: Mapping[str, Any]) -> bool | None:
    if str(baseline.get("provider") or "none") == "none" or baseline.get("verdict") is None:
        return None
    return out.get("verdict") == baseline.get("verdict")


def run_comparison(kind: str, jev: Any, *, settings: Settings, build: Callable[[], tuple[dict, dict]], judge: Judge,
                   baseline: Mapping[str, Any], agree: Agree | None = None, session_id: str | None = None,
                   agent_id: str | None = None, tool_name: str | None = None, checkpoint: str | None = None,
                   lane_id: str | None = None) -> None:
    """Worker side: build state + questions, ask Jev, combine, report. Never raises."""
    started = time.perf_counter()
    try:
        state, questions = build()
        res = jev.ask(state, questions, timeout_s=float(settings.jev_timeout_s))
        if not isinstance(res, JevResult):
            raise TypeError("jev.ask returned a non-JevResult")
    except Exception as exc:
        res = JevResult(ok=False, model=str(getattr(jev, "model", None) or settings.jev_model),
                        latency_ms=round((time.perf_counter() - started) * 1000.0, 1), error=_err(exc))
    out: Mapping[str, Any] = {}
    if res.ok:
        try:
            out = judge(res.answers) or {}
        except Exception as exc:
            res.error = f"combine failed: {_err(exc)}"
            out = {}
    try:
        sig = {k: v for k, v in dict(out.get("signals") or {}).items() if v is not None}
        body = jev_outcome(res, verdict=out.get("verdict"), score=out.get("score"),
                           confidence=out.get("confidence"), rationale=out.get("rationale"), signals=sig)
        base = dict(baseline)
        agreed: bool | None = None
        if res.ok and out.get("verdict") is not None:
            agreed = (agree or _default_agree)(out, base)
        _jevmod.get_shadow_reporter(settings).report(
            kind, baseline=base, jev=body, agree=agreed if isinstance(agreed, bool) else None, session_id=session_id,
            agent_id=agent_id, lane_id=lane_id, tool_name=tool_name, checkpoint=checkpoint)
    except Exception as exc:  # pragma: no cover - defensive (reporter never raises)
        log.debug("jev shadow report failed: %s", type(exc).__name__)


def available(ctx: Any) -> bool:
    """Cheap pre-check so detectors skip snapshot work when Jev is off, exhausted, or the context is real-time."""
    try:
        return (not getattr(ctx, "realtime", False) and getattr(ctx, "jev", None) is not None
                and getattr(ctx, "jev_budget", 0) > 0)
    except Exception:  # pragma: no cover - defensive
        return False


def schedule(ctx: Any, kind: str, *, build: Callable[[], tuple[dict, dict]], judge: Judge,
             baseline: Mapping[str, Any], agree: Agree | None = None, session_id: str | None = None,
             agent_id: str | None = None, tool_name: str | None = None, checkpoint: str | None = None) -> bool:
    """Detector side. Skips real-time contexts; consumes one Jev budget unit; submits off-thread. Never raises.

    ``build``/``judge``/``baseline`` MUST only close over immutable snapshots (copied strings/lists/dicts)."""
    try:
        if getattr(ctx, "realtime", False):
            return False
        jev = ctx.take_jev()
        if jev is None:
            return False
        settings = ctx.settings
        base = dict(baseline)
        return submit(lambda: run_comparison(kind, jev, settings=settings, build=build, judge=judge, baseline=base,
                                             agree=agree, session_id=session_id, agent_id=agent_id,
                                             tool_name=tool_name, checkpoint=checkpoint))
    except Exception as exc:
        log.debug("jev shadow schedule failed: %s", type(exc).__name__)
        return False
