"""Durable fleet state (SQLite): cursors, recent events, agent profiles, session ledgers, denial ledger, alert dedup."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from .models import AgentProfile, Alert, CanonicalEvent, Decision

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, session_id TEXT, agent_key TEXT, kind TEXT, occurred_at TEXT, source TEXT,
  processed INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_session ON events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_events_unprocessed ON events(processed, occurred_at);
CREATE TABLE IF NOT EXISTS profiles (agent_key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, agent_key TEXT, body TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS denials (
  id TEXT PRIMARY KEY, session_id TEXT, agent_key TEXT, user_id TEXT, occurred_at TEXT, capabilities TEXT,
  effect_keys TEXT, action_text TEXT, reason TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS ix_denials_session ON denials(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_denials_agent ON denials(agent_key, occurred_at);
CREATE TABLE IF NOT EXISTS alerts (
  fingerprint TEXT PRIMARY KEY, alert_id TEXT, body TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT, last_seen TEXT, delivered INTEGER NOT NULL DEFAULT 0, incident_id TEXT);
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, session_id TEXT, agent_key TEXT, body TEXT NOT NULL,
  updated_at TEXT, synced INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS identities (object_id TEXT PRIMARY KEY, kind TEXT, name TEXT, agent_key TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS baselines (key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT);
"""

# Additive, idempotent schema changes for existing state files.
_MIGRATIONS = [
    "ALTER TABLE denials ADD COLUMN actor TEXT NOT NULL DEFAULT 'agent'",
    "ALTER TABLE denials ADD COLUMN tool_call_id TEXT",
]


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


class State:
    def __init__(self, path: str = "fleet-state.db") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(_SCHEMA)
            for ddl in _MIGRATIONS:
                try:
                    self._db.execute(ddl)
                except sqlite3.OperationalError:
                    pass  # already applied

    def close(self) -> None:
        self._db.close()

    def _exec(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, tuple(params))

    # ── cursors ─────────────────────────────────────────────────────────────
    def get_cursor(self, key: str, default: str | None = None) -> str | None:
        row = self._exec("SELECT value FROM cursors WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_cursor(self, key: str, value: str) -> None:
        self._exec("INSERT INTO cursors(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, value))

    # ── events ──────────────────────────────────────────────────────────────
    def add_events(self, events: Iterable[CanonicalEvent]) -> list[CanonicalEvent]:
        """Insert events; returns only the new ones (dedup on id)."""
        new: list[CanonicalEvent] = []
        with self._lock:
            self._db.execute("BEGIN")
            try:
                for e in events:
                    cur = self._db.execute(
                        "INSERT OR IGNORE INTO events(id,session_id,agent_key,kind,occurred_at,source,body) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (e.id, e.session_id, e.agent_key, e.kind.value, _iso(e.occurred_at), e.source,
                         e.model_dump_json()))
                    if cur.rowcount:
                        new.append(e)
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        return new

    def unprocessed_events(self, limit: int = 5000) -> list[CanonicalEvent]:
        rows = self._exec("SELECT body FROM events WHERE processed=0 ORDER BY occurred_at, rowid LIMIT ?",
                          (limit,)).fetchall()
        return [CanonicalEvent.model_validate_json(r["body"]) for r in rows]

    def update_event(self, e: CanonicalEvent) -> None:
        self._exec("UPDATE events SET body=? WHERE id=?", (e.model_dump_json(), e.id))

    def update_alert(self, a: Alert) -> None:
        self._exec("UPDATE alerts SET body=?, incident_id=? WHERE fingerprint=?",
                   (a.model_dump_json(), a.incident_id, a.fingerprint))

    def mark_processed(self, ids: Iterable[str]) -> None:
        with self._lock:
            self._db.executemany("UPDATE events SET processed=1 WHERE id=?", [(i,) for i in ids])

    def session_events(self, session_id: str, limit: int = 400) -> list[CanonicalEvent]:
        rows = self._exec("SELECT body FROM events WHERE session_id=? ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                          (session_id, limit)).fetchall()
        return [CanonicalEvent.model_validate_json(r["body"]) for r in reversed(rows)]

    def recent_events(self, since: datetime, kinds: list[str] | None = None, limit: int = 20000) -> list[CanonicalEvent]:
        sql = "SELECT body FROM events WHERE occurred_at >= ?"
        params: list[Any] = [_iso(since)]
        if kinds:
            sql += f" AND kind IN ({','.join('?' * len(kinds))})"
            params += kinds
        rows = self._exec(sql + " ORDER BY occurred_at LIMIT ?", [*params, limit]).fetchall()
        return [CanonicalEvent.model_validate_json(r["body"]) for r in rows]

    def prune(self, older_than_days: int = 14) -> None:
        cutoff = _iso(datetime.now(timezone.utc) - timedelta(days=older_than_days))
        self._exec("DELETE FROM events WHERE occurred_at < ? AND processed=1", (cutoff,))

    # ── profiles ────────────────────────────────────────────────────────────
    def get_profile(self, agent_key: str) -> AgentProfile | None:
        row = self._exec("SELECT body FROM profiles WHERE agent_key=?", (agent_key,)).fetchone()
        return AgentProfile.model_validate_json(row["body"]) if row else None

    def put_profile(self, profile: AgentProfile) -> None:
        self._exec("INSERT INTO profiles(agent_key,body,updated_at) VALUES(?,?,?) ON CONFLICT(agent_key) DO UPDATE "
                   "SET body=excluded.body, updated_at=excluded.updated_at",
                   (profile.agent_key, profile.model_dump_json(), _iso(profile.updated_at)))

    def list_profiles(self) -> list[AgentProfile]:
        return [AgentProfile.model_validate_json(r["body"]) for r in self._exec("SELECT body FROM profiles").fetchall()]

    # ── sessions ────────────────────────────────────────────────────────────
    def get_session(self, session_id: str) -> dict[str, Any]:
        row = self._exec("SELECT body FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        return json.loads(row["body"]) if row else {}

    def put_session(self, session_id: str, agent_key: str, body: dict[str, Any]) -> None:
        self._exec("INSERT INTO sessions(session_id,agent_key,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) "
                   "DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at",
                   (session_id, agent_key, json.dumps(body, default=str), _iso(datetime.now(timezone.utc))))

    # ── denial ledger ───────────────────────────────────────────────────────
    def add_denial(self, event: CanonicalEvent, reason: str, source: str, actor: str = "agent",
                   action_text: str | None = None) -> None:
        """actor='agent' for denied agent actions; actor='user' for refused/filtered user requests."""
        if event.tool_call_id and event.session_id and self._exec(
                "SELECT 1 FROM denials WHERE session_id=? AND tool_call_id=? AND actor=? LIMIT 1",
                (event.session_id, event.tool_call_id, actor)).fetchone():
            return  # the call and its (blocked) result describe one denial, not two
        caps = sorted({e.capability.value for e in event.effects})
        keys = sorted({e.key() for e in event.effects})
        self._exec("INSERT OR IGNORE INTO denials(id,session_id,agent_key,user_id,occurred_at,capabilities,effect_keys,"
                   "action_text,reason,source,actor,tool_call_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                   (event.id, event.session_id, event.agent_key, event.user_id, _iso(event.occurred_at),
                    json.dumps(caps), json.dumps(keys), action_text or event.action_text(1500), reason, source, actor,
                    event.tool_call_id))

    def denials_for(self, session_id: str | None, agent_key: str, user_id: str | None, before: datetime,
                    window: timedelta = timedelta(hours=24), actor: str | None = None) -> list[dict[str, Any]]:
        since = _iso(before - window)
        sql = ("SELECT * FROM denials WHERE occurred_at >= ? AND occurred_at <= ? AND "
               "(session_id = ? OR (agent_key = ? AND user_id IS ? AND user_id IS NOT NULL))")
        params: list[Any] = [since, _iso(before), session_id, agent_key, user_id]
        if actor:
            sql += " AND actor = ?"
            params.append(actor)
        rows = self._exec(sql + " ORDER BY occurred_at", params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["capabilities"] = json.loads(d["capabilities"])
            d["effect_keys"] = json.loads(d["effect_keys"])
            out.append(d)
        return out

    # ── alerts ──────────────────────────────────────────────────────────────
    def upsert_alert(self, alert: Alert, dedup_window: timedelta = timedelta(minutes=30)) -> bool:
        """Returns True if this is a new alert (or re-fires after the dedup window)."""
        fp = alert.fingerprint
        now = _iso(alert.created_at)
        row = self._exec("SELECT last_seen, count FROM alerts WHERE fingerprint=?", (fp,)).fetchone()
        if row:
            last = datetime.fromisoformat(row["last_seen"])
            self._exec("UPDATE alerts SET count=count+1, last_seen=? WHERE fingerprint=?", (now, fp))
            if alert.created_at - last < dedup_window:
                return False
            self._exec("UPDATE alerts SET body=?, delivered=0 WHERE fingerprint=?", (alert.model_dump_json(), fp))
            return True
        self._exec("INSERT INTO alerts(fingerprint,alert_id,body,first_seen,last_seen) VALUES(?,?,?,?,?)",
                   (fp, alert.alert_id, alert.model_dump_json(), now, now))
        return True

    def undelivered_alerts(self) -> list[Alert]:
        rows = self._exec("SELECT body FROM alerts WHERE delivered=0 ORDER BY last_seen").fetchall()
        return [Alert.model_validate_json(r["body"]) for r in rows]

    def mark_delivered(self, alerts: Iterable[Alert]) -> None:
        with self._lock:
            self._db.executemany("UPDATE alerts SET delivered=1 WHERE fingerprint=?", [(a.fingerprint,) for a in alerts])

    def session_alerts(self, session_id: str) -> list[Alert]:
        rows = self._exec("SELECT body FROM alerts WHERE json_extract(body, '$.session_id') = ?", (session_id,)).fetchall()
        return [Alert.model_validate_json(r["body"]) for r in rows]

    def all_alerts(self, limit: int = 500) -> list[Alert]:
        rows = self._exec("SELECT body FROM alerts ORDER BY last_seen DESC LIMIT ?", (limit,)).fetchall()
        return [Alert.model_validate_json(r["body"]) for r in rows]

    # ── incidents ───────────────────────────────────────────────────────────
    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        row = self._exec("SELECT body FROM incidents WHERE id=?", (incident_id,)).fetchone()
        return json.loads(row["body"]) if row else None

    def incident_for_session(self, session_id: str) -> dict[str, Any] | None:
        row = self._exec("SELECT body FROM incidents WHERE session_id=?", (session_id,)).fetchone()
        return json.loads(row["body"]) if row else None

    def put_incident(self, incident: dict[str, Any]) -> None:
        self._exec("INSERT INTO incidents(id,session_id,agent_key,body,updated_at,synced) VALUES(?,?,?,?,?,0) "
                   "ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at, synced=0",
                   (incident["id"], incident.get("session_id"), incident.get("agent_key"),
                    json.dumps(incident, default=str), _iso(datetime.now(timezone.utc))))

    def unsynced_incidents(self) -> list[dict[str, Any]]:
        return [json.loads(r["body"]) for r in self._exec("SELECT body FROM incidents WHERE synced=0").fetchall()]

    def mark_incident_synced(self, incident_id: str) -> None:
        self._exec("UPDATE incidents SET synced=1 WHERE id=?", (incident_id,))

    # ── known identities (agents' Entra object ids / managed identities) ─────
    def put_identity(self, object_id: str, kind: str, name: str, agent_key: str | None = None) -> None:
        self._exec("INSERT INTO identities(object_id,kind,name,agent_key,updated_at) VALUES(?,?,?,?,?) "
                   "ON CONFLICT(object_id) DO UPDATE SET kind=excluded.kind, name=excluded.name, "
                   "agent_key=COALESCE(excluded.agent_key, identities.agent_key), updated_at=excluded.updated_at",
                   (object_id.lower(), kind, name, agent_key, _iso(datetime.now(timezone.utc))))

    def get_identity(self, object_id: str) -> dict[str, Any] | None:
        row = self._exec("SELECT * FROM identities WHERE object_id=?", (object_id.lower(),)).fetchone()
        return dict(row) if row else None

    def list_identities(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self._exec("SELECT * FROM identities").fetchall()]

    def sessions_with_source(self, session_ids: set[str], source: str) -> set[str]:
        out: set[str] = set()
        ids = [s for s in session_ids if s]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            rows = self._exec(f"SELECT DISTINCT session_id FROM events WHERE source = ? AND session_id IN "
                              f"({','.join('?' * len(chunk))})", [source, *chunk]).fetchall()
            out |= {r["session_id"] for r in rows}
        return out

    # ── statistical baselines (EWMA etc.) ───────────────────────────────────
    def get_baseline(self, key: str) -> dict[str, Any]:
        row = self._exec("SELECT body FROM baselines WHERE key=?", (key,)).fetchone()
        return json.loads(row["body"]) if row else {}

    def put_baseline(self, key: str, body: dict[str, Any]) -> None:
        self._exec("INSERT INTO baselines(key,body,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE "
                   "SET body=excluded.body, updated_at=excluded.updated_at",
                   (key, json.dumps(body, default=str), _iso(datetime.now(timezone.utc))))

    def list_sessions(self, limit: int = 200) -> list[dict[str, Any]]:
        rows = self._exec("SELECT session_id, agent_key, body, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?",
                          (limit,)).fetchall()
        return [{"session_id": r["session_id"], "agent_key": r["agent_key"], "updated_at": r["updated_at"],
                 **json.loads(r["body"])} for r in rows]

    def list_incidents(self, limit: int = 200) -> list[dict[str, Any]]:
        rows = self._exec("SELECT body FROM incidents ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["body"]) for r in rows]

    def stats(self) -> dict[str, int]:
        out = {}
        for t in ("events", "profiles", "sessions", "denials", "alerts", "incidents", "identities"):
            out[t] = self._exec(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"]
        return out


def blocked(event: CanonicalEvent) -> bool:
    return event.decision == Decision.BLOCKED
