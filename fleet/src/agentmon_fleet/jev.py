"""TypeSafe Jev (System One) client wrapper for the fleet — SHADOW MODE ONLY.

- ``FleetJev.ask`` / ``FleetJev.aask`` send one state + question battery (see ``jev_questions``) and return a
  ``JevResult``. They NEVER raise (errors land in ``JevResult.error``), enforce a hard wall-clock deadline, and
  never retry (the real-time hook path has a sub-second budget).
- ``ShadowReporter`` posts non-authoritative comparison records to the monitor
  (``POST {monitor_url}/api/gov/jev/shadow``) and/or appends them to a JSONL file, from a single daemon thread fed
  by a bounded queue, so callers never block on I/O.
- Prompts/answers are never logged (PII); only error types and counts are.
"""
from __future__ import annotations

import asyncio
import concurrent.futures as cf
import inspect
import json
import logging
import math
import queue
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings, get_settings
from .jev_questions import answer_signals

log = logging.getLogger(__name__)

FLEET_SHADOW_KINDS = frozenset({"fleet_realtime", "fleet_intent", "fleet_alignment", "fleet_evasion",
                                "fleet_injection", "fleet_code"})
BASELINE_PROVIDERS = frozenset({"foundry", "rules", "prompt-shields", "guardian", "heuristic", "none"})
_PROVIDER_ALIASES = {"llm": "foundry", "gpt": "foundry", "openai": "foundry", "azure_openai": "foundry",
                     "regex": "rules", "rule": "rules", "static": "rules", "deterministic": "rules"}


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Result + answer normalization
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
@dataclass
class JevResult:
    ok: bool
    model: str
    answers: dict[str, Any] = field(default_factory=dict)
    """Normalized answers keyed by question id:
    noul → {"type": "noul", "noul": P(yes)}; choice → {"type": "choice", "choice", "confidence", "probabilities"};
    score → {"type": "score", "score": expectation, "confidence", "probabilities": {level:int → p}}."""
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: float = 0.0
    error: str | None = None

    def noul(self, key: str, default: float | None = None) -> float | None:
        a = self.answers.get(key)
        return default if not a or a.get("noul") is None else float(a["noul"])

    def choice(self, key: str) -> str | None:
        a = self.answers.get(key)
        return None if not a else a.get("choice")

    def score(self, key: str) -> float | None:
        a = self.answers.get(key)
        return None if not a or a.get("score") is None else float(a["score"])

    @property
    def signals(self) -> dict[str, float | str]:
        return answer_signals(self.answers)


def _attr(o: Any, k: str) -> Any:
    return o.get(k) if isinstance(o, Mapping) else getattr(o, k, None)


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def normalize_answer(a: Any) -> dict[str, Any] | None:
    kind = _attr(a, "type")
    if kind is None:
        kind = "noul" if _attr(a, "noul") is not None else "choice" if _attr(a, "choice") is not None else \
            "score" if _attr(a, "score") is not None else None
    if kind == "noul":
        p = _f(_attr(a, "noul"))
        return None if p is None else {"type": "noul", "noul": min(1.0, max(0.0, p))}
    probs = _attr(a, "probabilities") or {}
    if kind == "choice":
        label = _attr(a, "choice")
        if label is None:
            return None
        return {"type": "choice", "choice": str(label), "confidence": _f(_attr(a, "confidence")),
                "probabilities": {str(k): _f(v) for k, v in dict(probs).items() if _f(v) is not None}}
    if kind == "score":
        s = _f(_attr(a, "score"))
        if s is None:
            return None
        out_p: dict[int, float] = {}
        for k, v in dict(probs).items():
            try:
                if _f(v) is not None:
                    out_p[int(k)] = float(v)
            except (TypeError, ValueError):
                continue
        return {"type": "score", "score": s, "confidence": _f(_attr(a, "confidence")), "probabilities": out_p}
    return None


def normalize_answers(response: Any) -> dict[str, dict[str, Any]]:
    raw = _attr(response, "answers") or {}
    out: dict[str, dict[str, Any]] = {}
    for k, a in dict(raw).items():
        n = normalize_answer(a)
        if n is not None:
            out[str(k)] = n
    return out


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Client
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
_POOL: cf.ThreadPoolExecutor | None = None
_POOL_LOCK = threading.Lock()


def _pool() -> cf.ThreadPoolExecutor:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = cf.ThreadPoolExecutor(max_workers=8, thread_name_prefix="fleet-jev")
        return _POOL


def _err(exc: BaseException) -> str:
    first = (str(exc).splitlines() or [""])[0]
    return f"{type(exc).__name__}: {first[:200]}"


class FleetJev:
    """Never-raising Jev client. ``client`` / ``aclient`` may be injected (tests, custom transports): any object
    with ``system_one(state, questions, **kwargs)`` returning an SDK-shaped response (sync or awaitable)."""

    def __init__(self, settings: Settings | None = None, *, client: Any | None = None, aclient: Any | None = None,
                 model: str | None = None) -> None:
        self.settings = settings or get_settings()
        self.model = model or self.settings.jev_model
        self.default_timeout_s = float(self.settings.jev_timeout_s)
        self._client = client
        self._aclient = aclient
        self._injected = client is not None or aclient is not None
        self._aclients: dict[int, Any] = {}  # per event loop (httpx async clients are loop-bound)
        self._lock = threading.Lock()

    # ── SDK construction (lazy; no network until the first call) ──────────────────────────────────────────
    def _sdk_kwargs(self, timeout: float) -> dict[str, Any]:
        from typesafe_sdk import RetryPolicy
        return dict(api_key=self.settings.typesafe_api_key, base_url=self.settings.typesafe_base_url or None,
                    model=self.model, timeout=timeout, retry=RetryPolicy(max_retries=0, timeout=timeout))

    def _sync_client(self) -> Any:
        with self._lock:
            if self._client is None:
                if self._aclient is not None:
                    return self._aclient
                from typesafe_sdk import TypeSafeClient
                self._client = TypeSafeClient(**self._sdk_kwargs(self.default_timeout_s))
            return self._client

    def _async_client(self) -> Any:
        if self._aclient is not None:
            return self._aclient
        if self._injected:
            return self._client
        loop = asyncio.get_running_loop()
        c = self._aclients.get(id(loop))
        if c is None:
            from typesafe_sdk import AsyncTypeSafeClient
            c = AsyncTypeSafeClient(**self._sdk_kwargs(self.default_timeout_s))
            self._aclients = {id(loop): c}  # drop clients of loops that are gone
        return c

    def _call_kwargs(self, timeout: float) -> dict[str, Any]:
        from typesafe_sdk import RetryPolicy
        return {"model": self.model, "timeout": timeout, "retry": RetryPolicy(max_retries=0, timeout=timeout)}

    def _timeout(self, timeout_s: float | None) -> float:
        t = self.default_timeout_s if timeout_s is None else float(timeout_s)
        return max(0.01, t)

    # ── results ──────────────────────────────────────────────────────────────────────────────────────────
    def _ok(self, resp: Any, started: float) -> JevResult:
        usage = _attr(resp, "usage")
        return JevResult(ok=True, model=str(_attr(resp, "model") or self.model), answers=normalize_answers(resp),
                         input_tokens=int(_attr(usage, "input_tokens") or 0) if usage is not None else 0,
                         output_tokens=int(_attr(usage, "output_tokens") or 0) if usage is not None else 0,
                         latency_ms=round((time.perf_counter() - started) * 1000.0, 1))

    def _fail(self, error: str, started: float) -> JevResult:
        return JevResult(ok=False, model=self.model, latency_ms=round((time.perf_counter() - started) * 1000.0, 1),
                         error=error[:2000])

    # ── sync ─────────────────────────────────────────────────────────────────────────────────────────────
    def _call_sync(self, client: Any, state: Any, questions: Any, timeout: float) -> Any:
        res = client.system_one(state, questions, **self._call_kwargs(timeout))
        if inspect.isawaitable(res):
            async def _await() -> Any:
                return await res
            res = asyncio.run(_await())
        return res

    def ask(self, state: dict, questions: dict, *, timeout_s: float | None = None) -> JevResult:
        """One System One call with a hard deadline (runs on a worker thread). Never raises; no retries."""
        started = time.perf_counter()
        t = self._timeout(timeout_s)
        fut: cf.Future | None = None
        try:
            if not questions:
                return self._fail("no questions", started)
            client = self._sync_client()
            fut = _pool().submit(self._call_sync, client, state, questions, t)
            return self._ok(fut.result(timeout=t), started)
        except cf.TimeoutError:
            if fut is not None:
                fut.cancel()
            return self._fail(f"timeout after {t * 1000:.0f}ms", started)
        except Exception as exc:
            log.debug("jev ask failed: %s", type(exc).__name__)
            return self._fail(_err(exc), started)

    # ── async ────────────────────────────────────────────────────────────────────────────────────────────
    async def _acall(self, state: Any, questions: Any, timeout: float) -> Any:
        client = self._async_client()
        fn = client.system_one
        if inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(getattr(fn, "__func__", None)):
            return await fn(state, questions, **self._call_kwargs(timeout))
        res = await asyncio.to_thread(fn, state, questions, **self._call_kwargs(timeout))
        if inspect.isawaitable(res):
            res = await res
        return res

    async def aask(self, state: dict, questions: dict, *, timeout_s: float | None = None) -> JevResult:
        """Async System One call bounded by ``asyncio.wait_for``. Never raises (except task cancellation)."""
        started = time.perf_counter()
        t = self._timeout(timeout_s)
        try:
            if not questions:
                return self._fail("no questions", started)
            resp = await asyncio.wait_for(self._acall(state, questions, t), timeout=t)
            return self._ok(resp, started)
        except (asyncio.TimeoutError, TimeoutError):
            return self._fail(f"timeout after {t * 1000:.0f}ms", started)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.debug("jev aask failed: %s", type(exc).__name__)
            return self._fail(_err(exc), started)

    def close(self) -> None:
        try:
            if self._client is not None and not self._injected:
                self._client.close()
        except Exception:
            pass
        self._client = None if not self._injected else self._client
        self._aclients = {}


# ── process-wide accessor ───────────────────────────────────────────────────────────────────────────────
_UNSET: Any = object()
_OVERRIDE: Any = _UNSET
_CACHED: tuple[tuple, FleetJev] | None = None
_CACHE_LOCK = threading.Lock()


def get_jev(settings: Settings | None = None) -> FleetJev | None:
    """Cached FleetJev, or None when Jev is not enabled (no key / jev_mode=off). Never raises.

    If ``set_jev_for_tests`` was called, its value (a FleetJev or None) is returned regardless of settings until
    ``reset_jev()``."""
    global _CACHED
    if _OVERRIDE is not _UNSET:
        return _OVERRIDE
    try:
        s = settings or get_settings()
        if not s.jev_enabled:
            return None
        key = (s.typesafe_api_key, s.typesafe_base_url, s.jev_model, s.jev_timeout_s)
        with _CACHE_LOCK:
            if _CACHED is None or _CACHED[0] != key:
                _CACHED = (key, FleetJev(s))
            return _CACHED[1]
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("jev disabled: %s", type(exc).__name__)
        return None


def set_jev_for_tests(j: FleetJev | None) -> None:
    """Force ``get_jev`` to return ``j`` (use None to force-disable). Undo with ``reset_jev()``."""
    global _OVERRIDE
    _OVERRIDE = j


def reset_jev() -> None:
    global _OVERRIDE, _CACHED
    _OVERRIDE = _UNSET
    with _CACHE_LOCK:
        _CACHED = None


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Shadow outcome + reporter
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
def jev_outcome(result: JevResult, *, verdict: str | None, score: float | None = None,
                confidence: float | None = None, rationale: str | None = None,
                signals: dict | None = None) -> dict[str, Any]:
    """The ``jev`` body of a JevShadowInput (camelCase; None fields dropped). Signals always include the raw answer
    probabilities (Noul P(yes), Choice label + confidence, Score expectation + confidence)."""
    sig: dict[str, Any] = dict(result.signals)
    sig.update(signals or {})
    out: dict[str, Any] = {
        "model": result.model, "verdict": verdict, "score": score, "confidence": confidence,
        "latencyMs": result.latency_ms,
        "inputTokens": result.input_tokens if result.ok else None,
        "outputTokens": result.output_tokens if result.ok else None,
        "rationale": rationale, "signals": sig, "error": result.error,
    }
    return {k: v for k, v in out.items() if v is not None}


def _camel(k: str) -> str:
    if "_" not in k:
        return k
    head, *rest = k.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def _s(v: Any, n: int) -> str | None:
    if v is None:
        return None
    return str(v)[:n]


def _n(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    x = _f(v)
    return None if x is None else x


def _cnt(v: Any) -> int | None:
    x = _n(v)
    return None if x is None or x < 0 else int(min(x, 1e9))


def _lat(v: Any) -> float | None:
    x = _n(v)
    return None if x is None or x < 0 else round(min(x, 3_600_000.0), 1)


def _signals(sig: Any) -> dict[str, float | str]:
    out: dict[str, float | str] = {}
    if not isinstance(sig, Mapping):
        return out
    for k, v in sig.items():
        if len(out) >= 200:
            break
        key = str(k)[:128]
        if isinstance(v, bool):
            out[key] = 1 if v else 0
        elif isinstance(v, (int, float)):
            if _f(v) is not None:
                out[key] = round(float(v), 6) if isinstance(v, float) else v
        elif isinstance(v, str):
            out[key] = v[:256]
        elif v is not None:
            try:
                out[key] = json.dumps(v, default=str)[:256]
            except Exception:
                continue
    return out


def _clean_baseline(b: Mapping[str, Any] | None) -> dict[str, Any]:
    src = {_camel(str(k)): v for k, v in (b or {}).items()}
    provider = str(src.get("provider") or "none").lower()
    provider = provider if provider in BASELINE_PROVIDERS else _PROVIDER_ALIASES.get(provider, "heuristic")
    out = {"provider": provider, "model": _s(src.get("model"), 256), "verdict": _s(src.get("verdict"), 64),
           "score": _n(src.get("score")), "confidence": _n(src.get("confidence")),
           "latencyMs": _lat(src.get("latencyMs")), "inputTokens": _cnt(src.get("inputTokens")),
           "outputTokens": _cnt(src.get("outputTokens")), "stage": _s(src.get("stage"), 64)}
    return {k: v for k, v in out.items() if v is not None}


def _clean_jev(j: Mapping[str, Any] | None) -> dict[str, Any]:
    src = {_camel(str(k)): v for k, v in (j or {}).items()}
    out = {"model": _s(src.get("model") or "unknown", 256), "verdict": _s(src.get("verdict"), 64),
           "score": _n(src.get("score")), "confidence": _n(src.get("confidence")),
           "latencyMs": _lat(src.get("latencyMs")) or 0.0, "inputTokens": _cnt(src.get("inputTokens")),
           "outputTokens": _cnt(src.get("outputTokens")), "policy": _s(src.get("policy"), 64),
           "rationale": _s(src.get("rationale"), 4000), "laneClause": _s(src.get("laneClause"), 4000),
           "signals": _signals(src.get("signals")), "error": _s(src.get("error"), 2000)}
    return {k: v for k, v in out.items() if v is not None}


def build_shadow_body(kind: str, *, baseline: dict, jev: dict, agree: bool | None, session_id: str | None = None,
                      agent_id: str | None = None, lane_id: str | None = None, tool_name: str | None = None,
                      checkpoint: str | None = None) -> dict[str, Any]:
    """JevShadowInput (camelCase), absent keys omitted, strings clipped to the server schema limits."""
    body: dict[str, Any] = {
        "kind": str(kind)[:64], "sessionId": _s(session_id, 256), "agentId": _s(agent_id, 256),
        "laneId": _s(lane_id, 256), "checkpoint": _s(checkpoint, 64), "toolName": _s(tool_name, 256),
        "baseline": _clean_baseline(baseline), "jev": _clean_jev(jev),
        "agree": agree if isinstance(agree, bool) else None,
    }
    return {k: v for k, v in body.items() if v is not None}


_STOP = object()


class ShadowReporter:
    """Non-blocking shadow-record sink: bounded queue → one daemon thread → monitor POST + JSONL. Never raises."""

    FAILURES_BEFORE_PAUSE = 5
    PAUSE_S = 30.0
    POST_TIMEOUT_S = 5.0

    def __init__(self, settings: Settings | None = None, *, http_client: Any | None = None, maxsize: int = 1000,
                 start_worker: bool = True) -> None:
        self.settings = settings or get_settings()
        s = self.settings
        self._post = bool(s.jev_shadow_post and s.monitor_url)
        self._url = f"{(s.monitor_url or '').rstrip('/')}/api/gov/jev/shadow"
        self._http = http_client
        self._jsonl = Path(s.jev_shadow_jsonl) if s.jev_shadow_jsonl else None
        self._q: queue.Queue = queue.Queue(maxsize=max(1, maxsize))
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._auto_start = start_worker
        self._consecutive_failures = 0
        self._paused_until = 0.0
        self._stats = {"enqueued": 0, "dropped": 0, "posted": 0, "post_errors": 0, "post_skipped": 0,
                       "written": 0, "write_errors": 0, "invalid": 0}
        self.last_error: str | None = None

    # ── public ───────────────────────────────────────────────────────────────────────────────────────────
    def report(self, kind: str, *, baseline: dict, jev: dict, agree: bool | None, session_id: str | None = None,
               agent_id: str | None = None, lane_id: str | None = None, tool_name: str | None = None,
               checkpoint: str | None = None) -> None:
        try:
            if not self._post and self._jsonl is None:
                return
            body = build_shadow_body(kind, baseline=baseline, jev=jev, agree=agree, session_id=session_id,
                                     agent_id=agent_id, lane_id=lane_id, tool_name=tool_name, checkpoint=checkpoint)
            if kind not in FLEET_SHADOW_KINDS:
                self._inc("invalid")
            try:
                self._q.put_nowait(body)
                self._inc("enqueued")
            except queue.Full:
                self._inc("dropped")
                return
            if self._auto_start:
                self.start()
        except Exception as exc:  # pragma: no cover - defensive
            self.last_error = _err(exc)

    def start(self) -> None:
        try:
            with self._lock:
                if self._thread is None or not self._thread.is_alive():
                    self._thread = threading.Thread(target=self._run, name="fleet-jev-shadow", daemon=True)
                    self._thread.start()
        except Exception as exc:  # pragma: no cover - defensive
            self.last_error = _err(exc)

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until every queued record was processed; True when drained within ``timeout``."""
        deadline = time.monotonic() + max(0.0, timeout)
        if self._q.unfinished_tasks and (self._thread is None or not self._thread.is_alive()):
            self.start()
        while self._q.unfinished_tasks > 0:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def close(self, timeout: float = 5.0) -> None:
        self.flush(timeout)
        try:
            if self._thread is not None and self._thread.is_alive():
                self._q.put_nowait(_STOP)
                self._thread.join(timeout=1.0)
        except Exception:
            pass

    def stats(self) -> dict[str, Any]:
        with self._lock:
            out: dict[str, Any] = dict(self._stats)
        out.update(pending=self._q.qsize(), post_enabled=self._post, jsonl=str(self._jsonl) if self._jsonl else None,
                   paused=time.monotonic() < self._paused_until, last_error=self.last_error)
        return out

    # ── worker ───────────────────────────────────────────────────────────────────────────────────────────
    def _inc(self, key: str) -> None:
        with self._lock:
            self._stats[key] = self._stats.get(key, 0) + 1

    def _client(self) -> Any:
        if self._http is None:
            # Reuse the dashboard sink's monitor auth/header logic (Content-Type + Bearer monitor_token).
            from .sinks.base import DashboardSink
            self._http = DashboardSink(self.settings).http
        return self._http

    def _run(self) -> None:
        while True:
            item = self._q.get()
            try:
                if item is _STOP:
                    return
                self._write(item)
                self._send(item)
            except Exception as exc:  # pragma: no cover - defensive
                self.last_error = _err(exc)
            finally:
                self._q.task_done()

    def _write(self, body: dict[str, Any]) -> None:
        if self._jsonl is None:
            return
        try:
            self._jsonl.parent.mkdir(parents=True, exist_ok=True)
            line = json.dumps({"type": "jev_shadow", "ts": datetime.now(timezone.utc).isoformat(), **body},
                              default=str, ensure_ascii=False)
            with self._jsonl.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            self._inc("written")
        except Exception as exc:
            self._inc("write_errors")
            self.last_error = _err(exc)

    def _send(self, body: dict[str, Any]) -> None:
        if not self._post:
            return
        if time.monotonic() < self._paused_until:
            self._inc("post_skipped")
            return
        try:
            r = self._client().post(self._url, content=json.dumps(body, default=str),
                                    headers={"Content-Type": "application/json"}, timeout=self.POST_TIMEOUT_S)
            if r.status_code >= 300:
                raise RuntimeError(f"HTTP {r.status_code} {str(getattr(r, 'text', ''))[:200]}")
            self._inc("posted")
            self._consecutive_failures = 0
        except Exception as exc:
            self._inc("post_errors")
            self.last_error = _err(exc)
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.FAILURES_BEFORE_PAUSE:
                self._paused_until = time.monotonic() + self.PAUSE_S
                self._consecutive_failures = 0
                log.warning("jev shadow POST paused for %.0fs after repeated failures (%s)", self.PAUSE_S,
                            self.last_error)


_REPORTER: ShadowReporter | None = None
_REPORTER_LOCK = threading.Lock()


def get_shadow_reporter(settings: Settings | None = None) -> ShadowReporter:
    """Process-wide ShadowReporter (created on first use)."""
    global _REPORTER
    with _REPORTER_LOCK:
        if _REPORTER is None:
            _REPORTER = ShadowReporter(settings)
        return _REPORTER


def set_shadow_reporter_for_tests(r: ShadowReporter | None) -> None:
    """Replace (or clear, with None) the process-wide reporter."""
    global _REPORTER
    with _REPORTER_LOCK:
        _REPORTER = r
