"""Find code/commands inside tool-call arguments, tool definitions and messages."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

CODE_KEYS = {"code", "script", "command", "cmd", "commands", "shell", "bash", "powershell", "pwsh", "python", "source",
             "query", "input", "program", "snippet", "expression", "run", "content", "body", "text"}
FILE_KEYS = {"path", "file", "filename", "file_path", "filepath", "target", "destination"}
SCRIPT_EXT = re.compile(r"(?i)\.(ps1|psm1|psd1|bat|cmd|sh|bash|zsh|py|pyw|js|mjs|vbs|hta|rb|pl)$")
FENCE = re.compile(r"```([A-Za-z0-9_+-]*)\s*\n(.*?)```", re.S)

_LANG_HINTS: list[tuple[str, re.Pattern[str]]] = [
    ("powershell", re.compile(r"(?i)(\$\w+\s*=|\b(Get|Set|New|Remove|Invoke|Start|Add|Out|ConvertTo|ConvertFrom|Write)-[A-Z]\w+|"
                              r"\[System\.|\bpowershell(\.exe)?\b|\bpwsh\b|-EncodedCommand|\biex\b)")),
    ("python", re.compile(r"(?m)(^\s*(import|from)\s+\w+|^\s*def\s+\w+\(|\bprint\(|subprocess\.|os\.(system|popen|environ)|__import__)")),
    ("bash", re.compile(r"(?m)(^#!/bin/(ba)?sh|\b(curl|wget|chmod|sudo|apt(-get)?|grep|awk|sed|nc|ssh|scp|export|echo)\b\s|\|\s*(sh|bash)\b|\$\(|&&)")),
    ("javascript", re.compile(r"(\brequire\(|\bconst\s+\w+\s*=|\bfunction\s*\w*\(|=>\s*\{|child_process|fetch\()")),
    ("sql", re.compile(r"(?i)^\s*(select|insert|update|delete|drop|alter|create|truncate|grant)\b")),
    ("cmd", re.compile(r"(?i)^\s*(cmd(\.exe)?\s+/c|net\s+(user|localgroup)|reg\s+(add|query)|schtasks|certutil|bitsadmin|wmic)")),
]


@dataclass
class CodeSnippet:
    language: str
    code: str
    origin: str  # argument path or "message" / "fence"


def detect_language(code: str, hint: str | None = None) -> str:
    if hint:
        h = hint.lower()
        for lang in ("powershell", "python", "bash", "javascript", "sql", "cmd"):
            if lang in h or (lang == "powershell" and h in {"ps", "ps1", "pwsh"}) or (lang == "bash" and h in {"sh", "shell", "zsh"}) \
                    or (lang == "python" and h in {"py"}) or (lang == "javascript" and h in {"js", "node"}):
                return lang
    scores = {lang: len(rx.findall(code)) for lang, rx in _LANG_HINTS}
    best = max(scores, key=lambda k: scores[k])
    return best if scores[best] else "text"


def _looks_like_code(s: str) -> bool:
    if len(s) < 6:
        return False
    return detect_language(s) != "text" or bool(re.search(r"[;|&]|\$\(|`|\bexec\b|\beval\b", s))


def _walk(value: Any, path: str, out: list[CodeSnippet], file_hint: str | None) -> None:
    if isinstance(value, dict):
        fh = file_hint
        for k in value:
            if str(k).lower() in FILE_KEYS and isinstance(value[k], str):
                fh = value[k]
        for k, v in value.items():
            _walk(v, f"{path}.{k}" if path else str(k), out, fh)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _walk(v, f"{path}[{i}]", out, file_hint)
    elif isinstance(value, str):
        key = path.rsplit(".", 1)[-1].split("[")[0].lower()
        stripped = value.strip()
        if stripped.startswith(("{", "[")):
            try:
                _walk(json.loads(stripped), path, out, file_hint)
                return
            except ValueError:
                pass
        for m in FENCE.finditer(value):
            out.append(CodeSnippet(detect_language(m.group(2), m.group(1)), m.group(2), f"{path}:fence"))
        if FENCE.search(value):
            return
        ext_lang = None
        if file_hint and SCRIPT_EXT.search(file_hint):
            ext_lang = SCRIPT_EXT.search(file_hint).group(1)  # type: ignore[union-attr]
        if key in CODE_KEYS or ext_lang:
            if ext_lang or _looks_like_code(value):
                out.append(CodeSnippet(detect_language(value, ext_lang), value, path))


def extract_code(arguments: Any, tool_name: str | None = None, tool_type: str | None = None) -> list[CodeSnippet]:
    out: list[CodeSnippet] = []
    if arguments is None:
        return out
    name = (tool_name or "").lower()
    ttype = (tool_type or "").lower()
    if isinstance(arguments, str) and ("code_interpreter" in ttype or "code_interpreter" in name or "python" in name):
        return [CodeSnippet("python", arguments, "code")]
    if isinstance(arguments, str) and any(k in name for k in ("shell", "bash", "powershell", "terminal", "exec", "run_command")):
        return [CodeSnippet(detect_language(arguments, name), arguments, "command")]
    _walk(arguments, "", out, None)
    return out


INLINE = re.compile(r"`([^`\n]{8,400})`")


def extract_code_from_text(text: str | None) -> list[CodeSnippet]:
    """Fenced blocks, plus inline `code` spans that look like commands (agents often hand users one-liners)."""
    if not text:
        return []
    out = [CodeSnippet(detect_language(m.group(2), m.group(1)), m.group(2), "message:fence") for m in FENCE.finditer(text)]
    stripped = FENCE.sub("", text)
    for m in INLINE.finditer(stripped):
        if _looks_like_code(m.group(1)):
            out.append(CodeSnippet(detect_language(m.group(1)), m.group(1), "message:inline"))
    return out
