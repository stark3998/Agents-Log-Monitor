from __future__ import annotations

import os

from agentgov_intel.config import load_env_file, load_settings


def test_env_file_loads_without_overriding_real_env(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "GUARDIAN_DEPLOYMENT=from-file\nCHAT_DEPLOYMENT=from-file\nMONITOR_TOKEN=\nAGENT_MONITOR_ENV_FILE=elsewhere\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("AGENT_MONITOR_ENV_FILE", str(env))
    monkeypatch.setenv("CHAT_DEPLOYMENT", "from-shell")
    monkeypatch.delenv("GUARDIAN_DEPLOYMENT", raising=False)
    monkeypatch.delenv("MONITOR_TOKEN", raising=False)

    settings = load_settings()

    assert settings.guardian_deployment == "from-file"
    assert settings.chat_deployment == "from-shell"
    assert "MONITOR_TOKEN" not in os.environ
    assert os.environ["AGENT_MONITOR_ENV_FILE"] == str(env)


def test_env_file_can_be_disabled(monkeypatch):
    monkeypatch.setenv("AGENT_MONITOR_ENV_FILE", "none")
    assert load_env_file() is None
