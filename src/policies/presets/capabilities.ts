import type { ToolCategory } from '../../analytics/classify';
import { BROWSER_TOOL_RE } from './mcp';
import { getPreset, listPresets, type PresetEntry } from './catalog';

export interface CapabilityInput {
  category: ToolCategory;
  toolName?: string;
  canonicalTool?: string;
  command?: string;
  mcpServer?: string | null;
}

// Command position: start of text or after a separator / `$(` / backtick, optionally behind a
// wrapper (sudo, nohup, env VAR=…, xargs…) and a directory prefix (/usr/bin/, .\).
const S = String.raw`(?:^|[;&|(\x60{]|\$\()\s*(?:(?:sudo|doas|nohup|time|xargs|exec|command|builtin|then|do|else|env(?:\s+\w+=\S*)*)\s+(?:-\S+\s+)*)*(?:[\w.~:-]*[\\/])?`;
const E = String.raw`(?:\.exe)?(?=\s|$|[;&|)])`;
const cmd = (names: string) => new RegExp(`${S}(?:${names})${E}`, 'im');
const GIT = String.raw`\bgit(?:\.exe)?(?:\s+-[Cc]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+`;
const DOCKER = String.raw`\b(?:docker|podman|nerdctl)(?:\.exe)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:image\s+|container\s+)?`;
const KUBE = String.raw`\b(?:kubectl|oc)(?:\.exe)?\s[^\n|;&]*?\b`;

/** Command-text rules per capability id. Parent capabilities are also implied by their children. */
const COMMAND_RULES: Record<string, RegExp[]> = {
  code_exec: [
    new RegExp(`${S}(?:python[23]?|py|node|deno|bun|ruby|perl|php|lua|Rscript|osascript)(?:\\.exe)?\\s+(?!--?(?:version|v|V|h|help)\\b)\\S`, 'im'),
    /\b(?:pwsh|powershell)(?:\.exe)?\s+[^\n|;&]*?-(?:c|command|f|file|e|enc|encodedcommand)\b/i,
    /\b(?:Invoke-Expression|iex)\b/i,
    /\bcmd(?:\.exe)?\s+\/[ck]\b/i,
    /(?:^|[\s;&|(])(?:\.\\|\.\/|&\s*)?[\w.\\/-]+\.ps1\b/im,
  ],
  process_spawn_eval: [
    /(?:^|[;&|(`]\s*|\s)(?:eval|exec)\s+\S/im,
    /\b(?:ba|z|da|k|fi)?sh(?:\.exe)?\s+(?:-[a-z]*\s+)*-[a-z]*c\b/i,
    /\b(?:Invoke-Expression|iex)\b/i,
  ],
  process_spawn: [
    cmd('nohup|setsid|disown|Start-Process|saps|mshta|rundll32|regsvr32|wscript|cscript|Invoke-Item|Invoke-WmiMethod|Invoke-CimMethod'),
    /\bwmic\b[^\n]*\bprocess\s+call\s+create\b/i,
    /(?:^|[;&|]\s*)start\s+\S/im,
    /\b(?:pwsh|powershell)(?:\.exe)?\s+[^\n|;&]*?-(?:c|command)\b/i,
    /[^&]&\s*$/m,
  ],
  sudo_exec: [
    cmd('sudo|doas|gsudo|runas|psexec|psexec64'),
    /-Verb\s+['"]?RunAs\b/i,
    /\bsu(?:\s+-\s*|\s+-c\b|\s+root\b|\s*$)/im,
  ],
  file_read: [cmd('cat|less|more|head|tail|Get-Content|gc|bat|nl|strings|xxd|od|hexdump|tac'), /(?:^|[;&|]\s*)type\s+\S/im],
  file_write: [
    /(?<![0-9<>&=|-])>>?\s*(?!&|\/dev\/null\b|\$null\b|nul\b)[^\s|;&>]/i,
    cmd('tee|Set-Content|Add-Content|Out-File|New-Item|ni|touch|mkdir|md|truncate'),
    /\bsed\s+(?:-[a-zA-Z]*\s+)*-i\b/i,
    /\bdd\s[^\n]*\bof=/i,
  ],
  file_delete: [cmd('rm|rmdir|del|erase|rd|unlink|shred|Remove-Item|ri|Clear-RecycleBin'), /\bgit\s+rm\b/i],
  chmod_unsafe: [
    /\bchmod\s+(?:-[a-zA-Z]+\s+)*(?:[0-7]?[0-7]{2}[2367]|[2467][0-7]{3}|[ugoa]*\+[rwx]*s[rwx]*|(?:o|a)?\+[rx]*w[rx]*)(?=\s|$)/im,
    /\bicacls\b[^\n]*\/grant(?::r)?\s+['"]?(?:\*S-1-1-0|Everyone|\*S-1-5-32-545|Users|Authenticated Users)['"]?:\(?(?:[^)\s]*\()?(?:F|M|W)\b/i,
  ],
  file_permissions: [cmd('chmod|chown|chgrp|icacls|cacls|attrib|takeown|Set-Acl|Get-Acl|setfacl|getfacl')],
  file_copy: [cmd('cp|mv|ln|copy|xcopy|robocopy|move|mklink|Copy-Item|Move-Item|Rename-Item|cpi|rni|rsync|ditto')],
  curl_to_shell: [
    /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    /\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i,
    /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
  ],
  web_outbound_send: [
    /\b(?:curl|wget|xh|https?|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[^\n|;]*?(?:-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|--request\s+['"]?(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-[\w]+)?|-F|--form|--upload-file|-T|--post-data|--post-file|--body-data|--body-file|--method=(?:POST|PUT|PATCH|DELETE))(?=[\s=@'"]|$)|-Method\s+['"]?(?:Post|Put|Patch|Delete)\b|\s-InFile\b|\s-Body\b)/i,
    /\b(?:http|https|xh)\s+(?:POST|PUT|PATCH|DELETE)\b/,
  ],
  web_access: [
    cmd('curl|wget|http|https|xh|aria2c|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Start-BitsTransfer'),
    /\bcertutil(?:\.exe)?\b[^\n]*-urlcache/i,
    /\bbitsadmin(?:\.exe)?\b[^\n]*\/transfer/i,
    /Net\.WebClient|DownloadString|DownloadFile/i,
  ],
  dns_lookup: [cmd('dig|nslookup|resolvectl|Resolve-DnsName|drill'), /(?:^|[;&|]\s*)host\s+\S/im, /\bgetent\s+hosts\b/i],
  socket_listen: [
    /\b(?:nc|ncat|netcat)(?:\.exe)?\b[^\n|;]*\s-[a-zA-Z]*l/i,
    /\bsocat\b[^\n]*(?:TCP|UDP)[46]?-LISTEN:/i,
    /\bpython[23]?\s+-m\s+(?:http\.server|SimpleHTTPServer)\b/i,
    /Sockets\.TcpListener|Net\.HttpListener/i,
  ],
  socket_open: [cmd('nc|ncat|netcat|socat|nmap|telnet|masscan|Test-NetConnection|tnc'), /System\.Net\.Sockets/i, /\/dev\/(?:tcp|udp)\//i],
  git_outbound_ops: [new RegExp(`${GIT}(?:push|send-pack)\\b`, 'i')],
  git_inbound_ops: [new RegExp(`${GIT}(?:pull|fetch|clone)\\b`, 'i')],
  git_destructive_ops: [
    new RegExp(`${GIT}push\\b[^\\n;&|]*(?:\\s--force\\b|\\s-f\\b|\\s--force-with-lease\\b|\\s\\+\\S)`, 'i'),
    new RegExp(`${GIT}(?:reset\\s+(?:\\S+\\s+)*--hard|filter-branch|filter-repo|clean\\s+-[a-z]*f[a-z]*|branch\\s+-D|checkout\\s+--\\s+\\.|reflog\\s+expire|gc\\s+--prune=now)(?![\\w-])`, 'i'),
  ],
  git_ops: [cmd('git')],
  docker_outbound_ops: [new RegExp(`${DOCKER}push\\b`, 'i')],
  docker_inbound_ops: [new RegExp(`${DOCKER}pull\\b`, 'i')],
  docker_destructive_ops: [new RegExp(`${DOCKER}(?:rm|rmi|prune|kill|system\\s+prune|volume\\s+(?:rm|prune)|network\\s+(?:rm|prune))\\b`, 'i')],
  docker_ops: [cmd('docker|podman|nerdctl|docker-compose')],
  kubectl_destructive_ops: [new RegExp(`${KUBE}(?:delete|drain)\\b`, 'i'), new RegExp(`${KUBE}scale\\b[^\\n|;&]*--replicas[= ]0\\b`, 'i'), /\bhelm\s+(?:uninstall|delete)\b/i],
  kubectl_mutate_ops: [
    new RegExp(`${KUBE}(?:apply|create|patch|replace|edit|scale|delete|drain|cordon|uncordon|label|annotate|taint|expose|run|set\\s+\\w+|rollout\\s+(?:restart|undo))\\b`, 'i'),
    /\bhelm\s+(?:install|upgrade|uninstall|delete|rollback)\b/i,
  ],
  kubectl_secret_ops: [new RegExp(`${KUBE}(?:get|describe)\\s+(?:-\\S+\\s+)*(?:secrets?|externalsecrets?|secretstores?|clustersecretstores?)\\b`, 'i')],
  kubectl_ops: [cmd('kubectl|helm|k9s|oc|kubectx|kubens')],
  aws_secret_ops: [/\baws\s[^\n|;&]*?\b(?:secretsmanager\s+(?:get-secret-value|list-secrets|batch-get-secret-value)|ssm\s+get-parameters?(?:-by-path)?\b[^\n|;&]*--with-decryption)\b/i],
  aws_ops: [cmd('aws')],
  vault_secret_ops: [/\bvault\s+(?:read|kv\s+get)\b/i],
  onepassword_secret_ops: [/\bop\s+(?:item\s+get|read)\b/i],
  gcloud_secret_ops: [/\bgcloud\s+secrets\s+versions\s+access\b/i],
  akeyless_secret_ops: [/\bakeyless\s+get-secret(?:-value)?\b/i],
  terraform_destructive_ops: [/\b(?:terraform|tofu)\s[^\n|;&]*?\b(?:destroy\b|apply\b[^\n|;&]*\s-destroy\b)/i],
  package_publish_ops: [/\b(?:npm|yarn|pnpm|bun)\s+publish\b|\bcargo\s+publish\b|\bgem\s+(?:push|publish)\b|\btwine\s+upload\b|\b(?:poetry|uv|flit|hatch)\s+publish\b|\b(?:dotnet\s+)?nuget\s+push\b/i],
  package_global_install: [
    /\b(?:npm|pnpm|bun)\s+(?:i|install|add)\b[^\n|;&]*\s(?:-g|--global)\b/i,
    /\byarn\s+global\s+add\b/i,
    /\bpip[23]?\s+install\b[^\n|;&]*\s--user\b/i,
    /\bsudo\s+(?:-\S+\s+)*pip[23]?\s+install\b/i,
    /\b(?:brew|cargo|go|gem|winget|choco|scoop|pipx)\s+install\b/i,
    /\b(?:apt|apt-get|yum|dnf|zypper|apk)\s+(?:install|add)\b|\bpacman\s+-S\b/i,
    /\bmsiexec(?:\.exe)?\b[^\n]*\/i\b/i,
    /\b(?:Install-Module|Install-Package)\b/i,
    /\buv\s+tool\s+install\b|\bdotnet\s+tool\s+install\b[^\n|;&]*(?:\s-g\b|--global)/i,
  ],
  package_install: [
    /\b(?:npm|pnpm|bun)\s+(?:i|install|add|ci)\b/i,
    /\byarn\s+(?:add|install)\b/i,
    /\bpip[23]?\s+install\b|\buv\s+(?:pip\s+install|add|sync)\b|\bpoetry\s+(?:add|install)\b|\bconda\s+install\b/i,
    /\bbundle\s+install\b|\bcargo\s+add\b|\bgo\s+get\b|\bcomposer\s+(?:require|install)\b/i,
    /\bdotnet\s+(?:add\s+package|restore)\b|\bnuget\s+install\b/i,
  ],
  package_ops: [cmd('npm|npx|yarn|pnpm|pnpx|bun|bunx|pip|pip3|pipx|uv|poetry|conda|gem|bundle|cargo|brew|apt|apt-get|yum|dnf|zypper|apk|pacman|twine|winget|choco|scoop|composer|nuget')],
  clipboard_read: [cmd('pbpaste|wl-paste|Get-Clipboard|gcb'), /\bxclip\b[^\n|;&]*\s-o(?:ut)?\b/i, /\bxsel\b[^\n|;&]*\s(?:-o|--output)\b/i, /Clipboard\]::(?:GetText|GetData|GetImage)/i],
  clipboard_access: [cmd('pbcopy|xclip|xsel|wl-copy|clip|Set-Clipboard|scb'), /Windows\.Forms\.Clipboard|\[Clipboard\]::/i],
  screenshot: [cmd('screencapture|scrot|gnome-screenshot|flameshot|spectacle|grim|maim|xwd|SnippingTool|ScreenSketch'), /\bimport\s+-window\b/i, /CopyFromScreen|savescreenshot/i],
  env_dump: [
    /(?:^|[;&|(`]\s*)(?:printenv|env)\s*(?:$|[|;&>])/im,
    /\b(?:Get-ChildItem|gci|ls|dir)\s+env:\s*(?:$|[|;&>])/im,
    /(?:^|[;&|]\s*)set\s*(?:$|[|>])/im,
    /\[Environment\]::GetEnvironmentVariables\(\s*\)/i,
    /\bexport\s+-p\b|\bdeclare\s+-x\b|\bcompgen\s+-e\b/i,
    /\/proc\/(?:self|\d+|\*)\/environ\b/i,
  ],
  env_vars: [cmd('printenv|export|source|setx|env'), /\$env:\w/i, /\[Environment\]::/i, /\breg(?:\.exe)?\s+query\s+[^\n]*Environment/i, /\b(?:Get-ChildItem|gci|ls|dir)\s+env:/i],
  browser_automation: [/\b(?:playwright|puppeteer|selenium|chromedriver|geckodriver|msedgedriver|webdriver)\b/i, /--remote-debugging-port\b/i],
  registry_modify: [
    /\breg(?:\.exe)?\s+(?:add|delete|import|load|restore|copy|unload)\b/i,
    /\bregini\b|\bregedit(?:\.exe)?\s+\/s\b/i,
    /\b(?:Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Rename-ItemProperty)\b/i,
    /\b(?:New-Item|Remove-Item|ni|ri)\b[^\n|;]*(?:HK(?:LM|CU|CR|U|CC):|Registry::)/i,
  ],
  service_control: [
    /\bsc(?:\.exe)?\s+(?:\\\\\S+\s+)?(?:create|config|start|stop|delete|pause|continue|failure)\b/i,
    /\bnet(?:\.exe)?\s+(?:start|stop)\b/i,
    /\b(?:New-Service|Start-Service|Stop-Service|Restart-Service|Set-Service|Remove-Service|Suspend-Service|Resume-Service)\b/i,
    /\b(?:systemctl|service)\s+(?:--\S+\s+)*(?:start|stop|restart|enable|disable|mask)\b/i,
    /\blaunchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart|start|stop)\b/i,
  ],
  scheduled_tasks: [
    /\bschtasks(?:\.exe)?\s+[^\n|;&]*\/(?:create|change|delete|run|end)\b/i,
    /(?:^|[;&|]\s*)at(?:\.exe)?\s+\d{1,2}:\d{2}\b/im,
    /\b(?:Register-ScheduledTask|Set-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask)\b/i,
    /\bcrontab\s+(?!-l\b)\S|\bcrontab\s*$/im,
  ],
  firewall_modify: [
    /\bnetsh(?:\.exe)?\s+(?:advfirewall|firewall)\b[^\n|;&]*\b(?:add|delete|set)\b/i,
    /\b(?:New-NetFirewallRule|Set-NetFirewallRule|Remove-NetFirewallRule|Disable-NetFirewallRule|Enable-NetFirewallRule|Set-NetFirewallProfile)\b/i,
    /\bufw\s+(?:allow|deny|reject|delete|disable|enable|default)\b|\bfirewall-cmd\b[^\n]*--(?:add|remove|set)-|\b(?:iptables|ip6tables)\s+[^\n]*-[AIDFPX]\b|\bnft\s+(?:add|delete|flush|insert)\b|\bpfctl\s+-[a-zA-Z]*[dEfF]/i,
  ],
};

const PARENT = new Map<string, string>();
for (const e of listPresets('capability') as PresetEntry[]) if (e.subsetOf) PARENT.set(e.id, e.subsetOf);

/** A capability and all capabilities it is a subset of. */
export function withAncestors(ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    let cur: string | undefined = id;
    let guard = 0;
    while (cur && !out.has(cur) && guard++ < 10) { out.add(cur); cur = PARENT.get(cur); }
  }
  return out;
}

export function knownCapabilityIds(): string[] {
  return (listPresets('capability') as PresetEntry[]).map(e => e.id);
}

/** Capability ids exhibited by an action, closed over `subsetOf` (children imply parents). */
export function detectCapabilities(a: CapabilityInput): Set<string> {
  const found = new Set<string>();
  const tool = `${a.toolName ?? ''} ${a.canonicalTool ?? ''}`;
  if (a.category === 'READ') found.add('file_read');
  if (a.category === 'WRITE') {
    found.add('file_write');
    if (/delete|remove|unlink/i.test(tool)) found.add('file_delete');
  }
  if (a.category === 'NETWORK') found.add('web_access');
  if (/screenshot|screen_capture|capture_screen/i.test(tool)) found.add('screenshot');
  if (/clipboard/i.test(tool)) found.add('clipboard_access');
  if (BROWSER_TOOL_RE.test(tool) || (a.mcpServer && BROWSER_TOOL_RE.test(a.mcpServer))) found.add('browser_automation');
  if (a.category === 'EXEC') {
    found.add('shell_exec');
    const c = a.command ?? '';
    if (c) {
      for (const [id, res] of Object.entries(COMMAND_RULES)) {
        if (res.some(re => re.test(c))) found.add(id);
      }
    }
  }
  return withAncestors(found);
}

/** True when the action's capabilities include any wanted id (`*` / `all_capabilities` = any action). */
export function capabilityMatches(wanted: string[], have: Set<string>): boolean {
  return wanted.some(w => w === '*' || w === 'all_capabilities' || have.has(w));
}

export function isKnownCapability(id: string): boolean {
  return id === '*' || !!getPreset('capability', id);
}

export const __COMMAND_RULE_IDS = Object.keys(COMMAND_RULES);
