"""Capability extraction and risk scoring for agent-generated code (Python AST + multi-language rules)."""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from ..models import Capability, Effect
from .deobfuscate import DeobResult, deobfuscate
from .extract import CodeSnippet


@dataclass(frozen=True)
class Rule:
    id: str
    capability: Capability
    pattern: re.Pattern[str]
    weight: int  # inherent risk 0-100
    description: str


def _r(id_: str, cap: Capability, rx: str, weight: int, desc: str) -> Rule:
    return Rule(id_, cap, re.compile(rx, re.I | re.M), weight, desc)


RULES: list[Rule] = [
    # Credential access
    _r("cred.imds", Capability.CRED_ACCESS,
       r"169\.254\.169\.254|metadata\.azure\.com|/metadata/identity/oauth2|IDENTITY_ENDPOINT|MSI_ENDPOINT",
       85, "Cloud instance metadata / managed identity token endpoint"),
    _r("cred.files", Capability.CRED_ACCESS,
       r"\.aws[/\\]credentials|\.azure[/\\](accessTokens|msal_token_cache|azureProfile)|\.ssh[/\\]id_|\.kube[/\\]config|"
       r"\.docker[/\\]config\.json|\.git-credentials|\.npmrc|\.pypirc|/etc/shadow|web\.config|appsettings\.json|\.env\b",
       75, "Reads credential/config files"),
    _r("cred.env", Capability.CRED_ACCESS,
       r"os\.environ(?!\[['\"](PATH|HOME|PWD|TEMP|TMP)['\"]\])|os\.getenv\(|Get-ChildItem\s+env:|\bgci\s+env:|"
       r"\$env:\w*(KEY|SECRET|TOKEN|PASS|CONN)|\bprintenv\b|process\.env",
       45, "Reads environment variables / secrets"),
    _r("cred.tokens", Capability.CRED_ACCESS,
       r"az\s+account\s+get-access-token|Get-AzAccessToken|gcloud\s+auth\s+print-access-token|\.get_token\(|"
       r"ConvertFrom-SecureString|Get-Credential|mimikatz|sekurlsa|lsass|vaultcmd|cmdkey\s+/list|"
       r"security\s+find-generic-password|CryptUnprotectData",
       85, "Token / credential harvesting"),
    _r("cred.keyvault", Capability.CRED_ACCESS,
       r"az\s+keyvault\s+secret\s+(show|list|download)|Get-AzKeyVaultSecret|SecretClient\(|\.get_secret\(",
       55, "Reads Key Vault secrets"),
    # Network
    _r("net.http", Capability.NET_EGRESS,
       r"\b(requests|httpx|urllib\.request|urllib3|aiohttp)\.\w+\(|Invoke-(WebRequest|RestMethod)|\biwr\b|\birm\b|"
       r"\bcurl\s|\bwget\s|Net\.WebClient|HttpClient|\bfetch\(|XMLHttpRequest|http\.client|urlopen\(",
       25, "Makes HTTP requests"),
    _r("net.socket", Capability.NET_EGRESS,
       r"socket\.socket\(|\bnc(at)?\s+(-\w+\s+)*[\w.]+\s+\d+|Net\.Sockets\.TcpClient|/dev/tcp/|\btelnet\s",
       60, "Raw socket connection"),
    _r("net.dns_tunnel", Capability.EXFIL,
       r"nslookup\s+\S*\$|dig\s+\S*\$\(|Resolve-DnsName\s+\S*\$|gethostbyname\([^)]*\+", 75, "DNS-based exfiltration"),
    _r("exfil.upload", Capability.EXFIL,
       r"requests\.(post|put)\([^)]*(files=|data=open)|curl\s[^\n]*(-F\s|--data-binary\s+@|-d\s+@|-T\s|--upload-file)|"
       r"Invoke-(WebRequest|RestMethod)[^\n]*-(InFile|Method\s+['\"]?(Post|Put))|UploadFile|UploadString|UploadData|"
       r"\bscp\s+\S+\s+\S+@|\brsync\s+\S+\s+\S+@|smtplib|Send-MailMessage|pastebin\.com|transfer\.sh|webhook\.site|"
       r"requestbin|ngrok\.io|discord(app)?\.com/api/webhooks|api\.telegram\.org",
       70, "Uploads data to a remote destination"),
    _r("dl.exec", Capability.DOWNLOAD_EXEC,
       r"(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b|iex\s*\(?\s*\(?\s*(New-Object\s+Net\.WebClient\)\.DownloadString|iwr|irm|Invoke-WebRequest)|"
       r"DownloadString\(|DownloadFile\([^)]*\.(exe|ps1|dll|bat)|pip\s+install\s+(git\+)?https?://|"
       r"Start-BitsTransfer|certutil\s+-urlcache|bitsadmin\s+/transfer|mshta\s+http",
       85, "Downloads and executes remote code"),
    # Execution
    _r("exec.shell", Capability.EXEC_SHELL,
       r"subprocess\.(run|Popen|call|check_output|check_call)|os\.(system|popen|exec\w*|spawn\w*)|pty\.spawn|"
       r"Start-Process|Invoke-Command|cmd(\.exe)?\s+/c|powershell(\.exe)?\s+-|child_process|Runtime\.getRuntime\(\)\.exec|"
       r"ProcessStartInfo|shell=True",
       35, "Spawns shell/processes"),
    _r("exec.dynamic", Capability.DEFENSE_EVASION,
       r"\biex\b|Invoke-Expression|\[ScriptBlock\]::Create|\bexec\s*\(|\beval\s*\(|__import__\(|compile\([^)]*['\"]exec['\"]|"
       r"importlib\.import_module\(|getattr\(\s*__builtins__|Add-Type\s+-TypeDefinition|Reflection\.Assembly\]::Load|ctypes\.",
       55, "Dynamic code execution"),
    # Persistence
    _r("persist.task", Capability.PERSISTENCE,
       r"schtasks\s+/create|Register-ScheduledTask|New-ScheduledTask|crontab\s+-|/etc/cron|systemctl\s+enable|"
       r"\\CurrentVersion\\Run|New-Service|sc(\.exe)?\s+create|launchctl\s+load|"
       r"\.(ba|z)sh(rc|_profile)\b|\$PROFILE|Microsoft\.PowerShell_profile|authorized_keys|\.git/hooks/",
       75, "Creates persistence (scheduled task, service, startup, profile, keys)"),
    # Privilege escalation
    _r("priv.esc", Capability.PRIV_ESC,
       r"\bsudo\s|\bsu\s+-|chmod\s+[ugo]*\+s|chmod\s+[46]7\d\d|Set-ExecutionPolicy\s+(Bypass|Unrestricted)|-ExecutionPolicy\s+Bypass|"
       r"\brunas\s|Start-Process[^\n]*-Verb\s+RunAs|/var/run/docker\.sock|--privileged|\bnsenter\s|setuid\(",
       60, "Privilege escalation"),
    # Defense evasion
    _r("evasion.av", Capability.DEFENSE_EVASION,
       r"Set-MpPreference\s+-Disable|Add-MpPreference\s+-Exclusion|DisableRealtimeMonitoring|AmsiUtils|amsiInitFailed|"
       r"Clear-EventLog|wevtutil\s+cl|Remove-Item[^\n]*ConsoleHost_history|history\s+-c|unset\s+HISTFILE|auditpol\s+/clear|"
       r"setenforce\s+0|ufw\s+disable|iptables\s+-F|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off|"
       r"dangerouslyDisableSandbox|--dangerously-skip-permissions|--no-sandbox|/proc/self/root|ld-linux[\w.-]*\.so",
       80, "Disables defenses, clears logs or evades sandbox"),
    _r("evasion.masquerade", Capability.DEFENSE_EVASION,
       r"(cp|copy|Copy-Item|mv|move|Rename-Item)\s+\S*(/usr)?/bin/\S+\s+\S+|(cp|Copy-Item)\s+\S*\\(System32|SysWOW64)\\\S+\.exe\s",
       55, "Copies/renames system binaries"),
    # Destructive
    _r("destroy.fs", Capability.DESTRUCTIVE,
       r"rm\s+-(r|f|rf|fr)\s+(/|~|\*|\$HOME|\.\.)(\s|$)|Remove-Item[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE|~|\\\*)|"
       r"shutil\.rmtree\(|\bmkfs\b|\bdd\s+if=.*of=/dev/|format\s+[a-z]:|vssadmin\s+delete|cipher\s+/w|"
       r"git\s+push\s+(-f|--force)|git\s+reset\s+--hard|git\s+clean\s+-fdx",
       70, "Destructive filesystem / repository operation"),
    _r("destroy.data", Capability.DESTRUCTIVE,
       r"\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(;|$))|az\s+group\s+delete|"
       r"Remove-AzResourceGroup|az\s+\w+\s+delete\s|kubectl\s+delete\s+(ns|namespace|all)",
       70, "Destructive data / cloud operation"),
    _r("ransom.encrypt", Capability.DESTRUCTIVE,
       r"(Fernet|AES\.new|Cryptography\.Aes|openssl\s+enc)[\s\S]{0,400}(os\.walk|Get-ChildItem\s+-Recurse|glob\()",
       80, "Bulk encryption of files"),
    # Recon
    _r("recon.host", Capability.RECON,
       r"\bwhoami\b|\bnet\s+(user|group|localgroup)\b|\bipconfig\b|\bifconfig\b|\bnetstat\b|\bsysteminfo\b|"
       r"Get-(LocalUser|ADUser|ADComputer|NetTCPConnection)|\bnmap\s|\barp\s+-a|\buname\s+-a|/etc/passwd|"
       r"\btasklist\b|Get-Process|\bps\s+aux",
       25, "Host / network reconnaissance"),
    _r("recon.cloud", Capability.RECON,
       r"az\s+(role\s+assignment|ad\s+(user|sp|app)|resource)\s+list|Get-AzRoleAssignment|graph\.microsoft\.com/v1\.0/(users|groups|servicePrincipals)|"
       r"aws\s+iam\s+list|gcloud\s+projects\s+list",
       40, "Cloud / directory enumeration"),
    # Identity / cloud admin
    _r("admin.identity", Capability.IDENTITY_ADMIN,
       r"az\s+role\s+assignment\s+create|New-AzRoleAssignment|az\s+ad\s+(app|sp)\s+credential\s+reset|"
       r"Add-MgDirectoryRoleMember|New-MgServicePrincipalAppRoleAssignment|net\s+user\s+\S+\s+\S+\s+/add|"
       r"net\s+localgroup\s+administrators\s+\S+\s+/add|Reset-(ADAccountPassword|MgUserPassword)|passwordProfile",
       75, "Identity / permission changes"),
    _r("admin.cloud", Capability.CLOUD_ADMIN,
       r"az\s+(vm|network|storage|keyvault|cognitiveservices|monitor\s+diagnostic-settings)\s+\w+\s+(create|update|delete|set)|"
       r"New-Az\w+|Set-Az\w+|terraform\s+(apply|destroy)|kubectl\s+(apply|exec)",
       45, "Cloud control-plane changes"),
    # File I/O (benign by default, context-dependent)
    _r("fs.write", Capability.WRITE_DATA,
       r"open\([^)]*['\"][wa]b?['\"]|Set-Content|Out-File|Add-Content|>\s*\S+\.\w+|\.write_text\(|\.to_csv\(|fs\.writeFile",
       10, "Writes files"),
    _r("fs.read", Capability.READ_DATA,
       r"open\([^)]*\)|Get-Content|\bcat\s|\.read_text\(|read_csv\(|fs\.readFile|os\.walk\(|Get-ChildItem",
       5, "Reads files"),
    _r("fs.delete", Capability.DELETE_DATA,
       r"os\.(remove|unlink|rmdir)\(|Remove-Item|\brm\s|\bdel\s", 20, "Deletes files"),
]

SENSITIVE_PATH = re.compile(
    r"(?i)(\.ssh|\.aws|\.azure|\.kube|\.docker|\.gnupg|/etc/(shadow|passwd|sudoers)|System32\\config|"
    r"\.env\b|secrets?\.(json|ya?ml)|id_rsa|id_ed25519|\.pem\b|\.pfx\b|\.key\b|credentials)")
URL_RX = re.compile(r"(?i)\b(?:https?|ftp|wss?)://[^\s'\"<>)\]}]+")
IP_RX = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
BENIGN_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "example.com"}

_PY_MODULE_CAPS: dict[str, tuple[Capability, int]] = {
    "subprocess": (Capability.EXEC_SHELL, 35), "pty": (Capability.EXEC_SHELL, 50), "socket": (Capability.NET_EGRESS, 45),
    "requests": (Capability.NET_EGRESS, 20), "httpx": (Capability.NET_EGRESS, 20), "urllib": (Capability.NET_EGRESS, 20),
    "aiohttp": (Capability.NET_EGRESS, 20), "paramiko": (Capability.NET_EGRESS, 50), "ftplib": (Capability.EXFIL, 55),
    "smtplib": (Capability.EXFIL, 60), "ctypes": (Capability.DEFENSE_EVASION, 50), "winreg": (Capability.PERSISTENCE, 45),
    "keyring": (Capability.CRED_ACCESS, 60), "win32crypt": (Capability.CRED_ACCESS, 80),
    "azure.keyvault": (Capability.CRED_ACCESS, 50), "boto3": (Capability.CLOUD_ADMIN, 30),
    "azure.mgmt": (Capability.CLOUD_ADMIN, 30), "shutil": (Capability.WRITE_DATA, 10),
}
_PY_CALL_CAPS: dict[str, tuple[Capability, int]] = {
    "exec": (Capability.DEFENSE_EVASION, 55), "eval": (Capability.DEFENSE_EVASION, 45),
    "compile": (Capability.DEFENSE_EVASION, 35), "__import__": (Capability.DEFENSE_EVASION, 45),
    "os.system": (Capability.EXEC_SHELL, 40), "os.popen": (Capability.EXEC_SHELL, 40),
    "shutil.rmtree": (Capability.DESTRUCTIVE, 55), "os.remove": (Capability.DELETE_DATA, 20),
    "os.getenv": (Capability.CRED_ACCESS, 30), "os.environ.get": (Capability.CRED_ACCESS, 30),
}


@dataclass
class Finding:
    rule_id: str
    capability: Capability
    weight: int
    description: str
    evidence: str
    in_decoded_layer: bool = False


@dataclass
class CodeAnalysis:
    language: str
    origin: str
    findings: list[Finding] = field(default_factory=list)
    destinations: list[str] = field(default_factory=list)
    sensitive_paths: list[str] = field(default_factory=list)
    obfuscation: list[str] = field(default_factory=list)
    dynamic_exec: bool = False
    decoded_preview: list[str] = field(default_factory=list)
    parse_error: bool = False

    @property
    def capabilities(self) -> set[Capability]:
        return {f.capability for f in self.findings}

    @property
    def risk(self) -> int:
        """Inherent risk 0-100 (before comparing with the agent's charter)."""
        base = max((f.weight for f in self.findings), default=0)
        distinct_high = len({f.capability for f in self.findings if f.weight >= 55})
        score = base + 5 * max(0, distinct_high - 1)
        if self.obfuscation:
            score = score * 1.35 + 15
        if self.dynamic_exec and self.obfuscation:
            score += 10
        if self.sensitive_paths:
            score += 10
        if any(f.in_decoded_layer and f.weight >= 55 for f in self.findings):
            score += 10
        return int(min(100, score))

    def effects(self, executor: str) -> list[Effect]:
        out: list[Effect] = []
        seen: set[str] = set()
        for f in self.findings:
            dest = self.destinations[0] if f.capability in (Capability.NET_EGRESS, Capability.EXFIL,
                                                             Capability.DOWNLOAD_EXEC) and self.destinations else ""
            res = self.sensitive_paths[0] if f.capability in (Capability.CRED_ACCESS, Capability.READ_DATA) and self.sensitive_paths else ""
            e = Effect(capability=f.capability, resource=res, destination=dest, executor=executor, evidence=f.evidence[:160],
                       data_class="credential" if f.capability == Capability.CRED_ACCESS else "")
            if e.key() not in seen:
                seen.add(e.key())
                out.append(e)
        for d in self.destinations[1:]:
            e = Effect(capability=Capability.NET_EGRESS, destination=d, executor=executor)
            if e.key() not in seen:
                seen.add(e.key())
                out.append(e)
        return out

    def summary(self) -> dict:
        return {
            "language": self.language, "risk": self.risk, "obfuscation": self.obfuscation,
            "dynamic_exec": self.dynamic_exec,
            "capabilities": sorted(c.value for c in self.capabilities),
            "findings": [{"rule": f.rule_id, "capability": f.capability.value, "evidence": f.evidence[:160],
                          "decoded": f.in_decoded_layer} for f in self.findings[:25]],
            "destinations": self.destinations[:10], "sensitive_paths": self.sensitive_paths[:10],
            "decoded_preview": [d[:400] for d in self.decoded_preview[:3]],
        }


def canonical_host(url_or_host: str) -> str:
    s = url_or_host.strip().strip("'\"")
    if "://" in s:
        host = urlparse(s).hostname or ""
    else:
        host = s.split("/")[0].split(":")[0]
    host = host.lower().rstrip(".")
    try:
        host = host.encode("idna").decode() if host and not IP_RX.fullmatch(host) else host
    except UnicodeError:
        pass
    return host


def _destinations(text: str) -> list[str]:
    hosts: list[str] = []
    for u in URL_RX.findall(text):
        h = canonical_host(u)
        if h and h not in BENIGN_HOSTS and h not in hosts:
            hosts.append(h)
    for ip in IP_RX.findall(text):
        if ip not in BENIGN_HOSTS and ip not in hosts and not ip.startswith(("0.", "255.")):
            hosts.append(ip)
    return hosts


def _python_ast(code: str, analysis: CodeAnalysis) -> None:
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        analysis.parse_error = True
        return
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for n in names:
                for mod, (cap, w) in _PY_MODULE_CAPS.items():
                    if n == mod or n.startswith(mod + "."):
                        analysis.findings.append(Finding(f"py.import.{mod}", cap, w, f"imports {n}", f"import {n}"))
        elif isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name in _PY_CALL_CAPS:
                cap, w = _PY_CALL_CAPS[name]
                analysis.findings.append(Finding(f"py.call.{name}", cap, w, f"calls {name}", ast.unparse(node)[:160]))
                if name in ("exec", "eval", "compile", "__import__"):
                    analysis.dynamic_exec = True


def _call_name(func: ast.AST) -> str:
    parts: list[str] = []
    while isinstance(func, ast.Attribute):
        parts.append(func.attr)
        func = func.value
    if isinstance(func, ast.Name):
        parts.append(func.id)
    return ".".join(reversed(parts))


def analyze_snippet(snippet: CodeSnippet, deob: DeobResult | None = None) -> CodeAnalysis:
    deob = deob or deobfuscate(snippet.code)
    analysis = CodeAnalysis(language=snippet.language, origin=snippet.origin, obfuscation=list(deob.techniques),
                            dynamic_exec=deob.dynamic_exec, decoded_preview=list(deob.layers))
    texts = [(snippet.code, False)] + [(layer, True) for layer in deob.layers]
    seen: set[tuple[str, bool]] = set()
    for text, decoded in texts:
        for rule in RULES:
            m = rule.pattern.search(text)
            if m and (rule.id, decoded) not in seen:
                seen.add((rule.id, decoded))
                analysis.findings.append(Finding(rule.id, rule.capability, rule.weight, rule.description,
                                                 _context(text, m.start(), m.end()), decoded))
        for d in _destinations(text):
            if d not in analysis.destinations:
                analysis.destinations.append(d)
        for m in SENSITIVE_PATH.finditer(text):
            if m.group(0) not in analysis.sensitive_paths:
                analysis.sensitive_paths.append(m.group(0))
    if snippet.language == "python":
        _python_ast(snippet.code, analysis)
        for layer in deob.layers:
            if re.search(r"(?m)^\s*(import|from)\s", layer):
                _python_ast(layer, analysis)
    # Keep one finding per (rule, decoded) and prefer the higher weight when AST and regex overlap.
    uniq: dict[tuple[str, bool], Finding] = {}
    for f in analysis.findings:
        k = (f.rule_id, f.in_decoded_layer)
        if k not in uniq or uniq[k].weight < f.weight:
            uniq[k] = f
    caps = {f.capability for f in uniq.values()}
    if Capability.CRED_ACCESS in caps and caps & {Capability.NET_EGRESS, Capability.EXFIL} and analysis.destinations:
        uniq[("combo.cred_egress", False)] = Finding(
            "combo.cred_egress", Capability.EXFIL, 85, "Reads secrets and sends data to a remote host",
            f"secrets -> {analysis.destinations[0]}")
    analysis.findings = sorted(uniq.values(), key=lambda f: -f.weight)
    return analysis


def _context(text: str, start: int, end: int, pad: int = 40) -> str:
    return text[max(0, start - pad): min(len(text), end + pad)].replace("\n", " ⏎ ")


def analyze_code(code: str, language: str = "text", origin: str = "inline") -> CodeAnalysis:
    return analyze_snippet(CodeSnippet(language, code, origin))
