"""Recursive deobfuscation of agent-generated commands and scripts.

Handles PowerShell -EncodedCommand, base64 (incl. FromBase64String / b64decode / `base64 -d`), gzip/zlib-wrapped
base64, hex (bytes.fromhex, \\x escapes, xxd), char-code arrays ([char]N, chr(N), String.fromCharCode),
string concatenation, PowerShell format operator and backtick escapes, rot13, and reversed strings.
"""
from __future__ import annotations

import base64
import binascii
import codecs
import gzip
import re
import zlib
from dataclasses import dataclass, field

MAX_DEPTH = 4
MAX_LEN = 200_000

_PS_ENC = re.compile(r"(?i)(?:^|\s)-e(?:nc(?:odedcommand)?|c)?\s+([A-Za-z0-9+/=]{16,})")
_B64_CALL = re.compile(
    r"(?i)(?:FromBase64String|b64decode|atob|base64\.decode|Base64\.getDecoder\(\)\.decode|decodebytes)"
    r"\s*\(\s*(?:b|u)?['\"]([A-Za-z0-9+/=_-]{12,})['\"]")
_B64_PIPE = re.compile(r"(?i)(?:echo|printf)\s+(?:-n\s+)?['\"]?([A-Za-z0-9+/=]{12,})['\"]?\s*\|\s*base64\s+(?:-d|--decode|-D)")
_B64_LITERAL = re.compile(r"(?<![A-Za-z0-9+/])([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])")
_HEX_CALL = re.compile(r"(?i)(?:bytes\.fromhex|unhexlify|Buffer\.from)\s*\(\s*['\"]([0-9a-fA-F]{8,})['\"]")
_HEX_ESC = re.compile(r"((?:\\x[0-9a-fA-F]{2}){4,})")
_XXD = re.compile(r"(?i)echo\s+['\"]?([0-9a-fA-F]{8,})['\"]?\s*\|\s*xxd\s+-r\s+-p")
_PS_CHAR = re.compile(r"(?i)(?:\[char\]\s*0?x?[0-9a-f]+\s*(?:\+|,)\s*){3,}\[char\]\s*0?x?[0-9a-f]+")
_PS_CHAR_ARR = re.compile(r"(?i)\[char\[\]\]\s*\(([0-9,\s]{5,})\)")
_PY_CHR = re.compile(r"(?:chr\(\s*\d+\s*\)\s*\+\s*){3,}chr\(\s*\d+\s*\)")
_PY_CHR_MAP = re.compile(r"(?:''|\"\")\.join\(\s*(?:map\(\s*chr\s*,|\[\s*chr\(\w+\)\s+for\s+\w+\s+in)\s*\[([0-9,\s]{5,})\]")
_JS_CHARCODE = re.compile(r"String\.fromCharCode\(([0-9,\s]{5,})\)")
_CONCAT = re.compile(r"""((?:(['"])[^'"\n]{0,40}\2\s*\+\s*){2,}(['"])[^'"\n]{0,40}\3)""")
_PS_FORMAT = re.compile(r"""\(?\s*["']((?:\{\d+\})+)["']\s*-f\s*((?:["'][^"']*["']\s*,\s*)*["'][^"']*["'])""")
_PS_BACKTICK = re.compile(r"(\w)`(\w)")
_ROT13 = re.compile(r"(?i)codecs\.decode\(\s*['\"]([^'\"]{6,})['\"]\s*,\s*['\"]rot[_-]?13['\"]")
_IEX = re.compile(r"(?i)\b(iex|invoke-expression|\.invoke\(\)|scriptblock\]::create|exec\s*\(|eval\s*\(|execfile|compile\s*\(|"
                  r"new-object\s+-com|\|\s*(?:sh|bash|zsh|pwsh|powershell|python3?)\b|\bsource\s+/dev/stdin)")

SUSPICIOUS_REVERSED = ["noisserpxe-ekovni", "tseuqerbew-ekovni", "llehsrewop", "tneilcbew.ten", "gnirtsdaolnwod",
                       "metsys.so", "ssecorpbus", "lruc", "tegw"]


@dataclass
class DeobResult:
    original: str
    layers: list[str] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    dynamic_exec: bool = False

    @property
    def obfuscated(self) -> bool:
        return bool(self.techniques)

    @property
    def all_text(self) -> str:
        return "\n".join([self.original, *self.layers])


def _printable_ratio(s: str) -> float:
    if not s:
        return 0.0
    ok = sum(1 for c in s if c.isprintable() or c in "\r\n\t")
    return ok / len(s)


def _try_b64(token: str) -> str | None:
    t = token.strip().replace("-", "+").replace("_", "/")
    t += "=" * (-len(t) % 4)
    try:
        raw = base64.b64decode(t, validate=False)
    except (binascii.Error, ValueError):
        return None
    for decomp in (lambda b: gzip.decompress(b), lambda b: zlib.decompress(b), lambda b: zlib.decompress(b, -15)):
        try:
            raw2 = decomp(raw)
            txt = raw2.decode("utf-8", "ignore")
            if _printable_ratio(txt) > 0.9:
                return txt
        except Exception:
            pass
    candidates = []
    if len(raw) >= 4 and raw[1:2] == b"\x00":
        candidates.append(raw.decode("utf-16-le", "ignore"))
    candidates.append(raw.decode("utf-8", "ignore"))
    for txt in candidates:
        if len(txt) >= 4 and _printable_ratio(txt) > 0.92 and re.search(r"[A-Za-z]{3,}", txt):
            return txt
    return None


def _codes_to_str(nums: str) -> str | None:
    try:
        vals = [int(n.strip(), 0) for n in nums.split(",") if n.strip()]
        return "".join(chr(v) for v in vals if 0 < v < 0x110000)
    except ValueError:
        return None


def _decode_layer(text: str) -> tuple[list[str], list[str]]:
    """Returns (decoded fragments, techniques) for one pass."""
    frags: list[str] = []
    techs: list[str] = []

    def add(fragment: str | None, tech: str) -> None:
        if fragment and fragment.strip() and fragment not in frags and fragment not in text:
            frags.append(fragment)
            if tech not in techs:
                techs.append(tech)

    for m in _PS_ENC.finditer(text):
        tok = m.group(1)
        try:
            add(base64.b64decode(tok + "=" * (-len(tok) % 4)).decode("utf-16-le", "ignore"), "powershell_encodedcommand")
        except (binascii.Error, ValueError):
            pass
    for rx, tech in ((_B64_CALL, "base64_call"), (_B64_PIPE, "base64_pipe")):
        for m in rx.finditer(text):
            add(_try_b64(m.group(1)), tech)
    for m in _B64_LITERAL.finditer(text):
        dec = _try_b64(m.group(1))
        if dec and re.search(r"(?i)(http|import|invoke|powershell|cmd|bash|curl|wget|exec|password|token|secret|\$\w+|/bin/|\\\\)", dec):
            add(dec, "base64_literal")
    for m in _HEX_CALL.finditer(text):
        try:
            add(bytes.fromhex(m.group(1)).decode("utf-8", "ignore"), "hex")
        except ValueError:
            pass
    for m in _XXD.finditer(text):
        try:
            add(bytes.fromhex(m.group(1)).decode("utf-8", "ignore"), "hex_xxd")
        except ValueError:
            pass
    for m in _HEX_ESC.finditer(text):
        try:
            add(codecs.decode(m.group(1), "unicode_escape"), "hex_escape")
        except Exception:
            pass
    for m in _PS_CHAR.finditer(text):
        nums = re.findall(r"(?i)\[char\]\s*(0?x?[0-9a-f]+)", m.group(0))
        add(_codes_to_str(",".join(nums)), "char_codes")
    for rx in (_PS_CHAR_ARR, _PY_CHR_MAP, _JS_CHARCODE):
        for m in rx.finditer(text):
            add(_codes_to_str(m.group(1)), "char_codes")
    for m in _PY_CHR.finditer(text):
        add(_codes_to_str(",".join(re.findall(r"\d+", m.group(0)))), "char_codes")
    for m in _CONCAT.finditer(text):
        joined = "".join(p[1] for p in re.findall(r"""(['"])([^'"\n]*)\1""", m.group(1)))
        if len(joined) >= 6 and re.search(r"(?i)(invoke|expression|download|webclient|http|system|exec|eval|subprocess|"
                                          r"powershell|cmd|bash|curl|wget|token|password|secret|shell|socket|import)", joined):
            add(joined, "string_concat")
    for m in _PS_FORMAT.finditer(text):
        order = [int(i) for i in re.findall(r"\{(\d+)\}", m.group(1))]
        parts = [p[1] for p in re.findall(r"""(["'])([^"']*)\1""", m.group(2))]
        try:
            add("".join(parts[i] for i in order), "ps_format_operator")
        except IndexError:
            pass
    if _PS_BACKTICK.search(text):
        cleaned = text
        for _ in range(3):
            cleaned = _PS_BACKTICK.sub(r"\1\2", cleaned)
        if cleaned != text and re.search(r"(?i)(invoke|iex|downloadstring|webclient|expression|new-object|start-process)", cleaned):
            add(cleaned, "ps_backtick")
    for m in _ROT13.finditer(text):
        add(codecs.decode(m.group(1), "rot13"), "rot13")
    low = text.lower()
    for rev in SUSPICIOUS_REVERSED:
        if rev in low:
            add(low[::-1], "reversed_string")
            break
    return frags, techs


def deobfuscate(text: str, max_depth: int = MAX_DEPTH) -> DeobResult:
    text = text[:MAX_LEN]
    result = DeobResult(original=text)
    result.dynamic_exec = bool(_IEX.search(text))
    frontier = [text]
    for _ in range(max_depth):
        nxt: list[str] = []
        for chunk in frontier:
            frags, techs = _decode_layer(chunk)
            for t in techs:
                if t not in result.techniques:
                    result.techniques.append(t)
            for f in frags:
                if f not in result.layers:
                    result.layers.append(f)
                    nxt.append(f)
                    if _IEX.search(f):
                        result.dynamic_exec = True
        if not nxt:
            break
        frontier = nxt
    return result
