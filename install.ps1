# Agent Monitor / Governance installer (Windows, PowerShell 5.1+).
# Re-running is safe: this script removes only Agent Monitor hook entries, then adds the requested ones.

param(
  [int]$Port = 4317,
  [int]$HookTimeoutSec = 120,
  [switch]$CopilotHooks,
  [switch]$CopilotPolicyHooks,
  [switch]$VSCodeHooks,
  [ValidateSet('auto', 'open', 'closed')]
  [string]$FailMode = 'auto',
  [string]$ControlPlaneUrl = '',
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SettingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
$LocalBaseUrl = "http://127.0.0.1:$Port"
$BaseUrl = if ($ControlPlaneUrl) { $ControlPlaneUrl.TrimEnd('/') } else { $LocalBaseUrl }
$ClaudeHookUrl = "$BaseUrl/hooks/claude-code"
$OldClaudeIngestUrl = "$LocalBaseUrl/ingest/claude-code"

$ClaudeEvents = @(
  "SessionStart", "SessionEnd", "UserPromptSubmit",
  "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop",
  "Stop", "Notification"
)

$BlockingClaudeEvents = @("PreToolUse", "UserPromptSubmit", "PermissionRequest")
$CopilotEvents = @(
  "sessionStart", "sessionEnd", "userPromptSubmitted",
  "preToolUse", "permissionRequest", "postToolUse", "postToolUseFailure",
  "agentStop", "subagentStart", "subagentStop", "errorOccurred"
)
$VSCodeEvents = @("SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "PreCompact")

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 turns native stderr lines into terminating errors under
# ErrorActionPreference=Stop when redirected with 2>&1. Tools like npm/vite print
# warnings to stderr, so run them with Continue and judge success by $LASTEXITCODE.
function Invoke-Native([scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
    }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function ConvertTo-MutableHt {
  param($Obj)
  if ($null -eq $Obj) { return $null }
  if ($Obj -is [System.Collections.IList]) { return @($Obj | ForEach-Object { ConvertTo-MutableHt $_ }) }
  if ($Obj -is [System.Collections.IDictionary]) { return $Obj }
  if ($Obj -is [System.Management.Automation.PSCustomObject]) {
    $ht = [ordered]@{}
    foreach ($prop in $Obj.PSObject.Properties) { $ht[$prop.Name] = ConvertTo-MutableHt $prop.Value }
    return $ht
  }
  return $Obj
}

function Read-JsonHt([string]$Path) {
  if (-not (Test-Path $Path)) { return [ordered]@{} }
  $raw = Get-Content $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) { return [ordered]@{} }
  try { return ConvertTo-MutableHt ($raw | ConvertFrom-Json) } catch {
    Copy-Item $Path "$Path.bak" -Force
    Write-Warn "Could not parse $Path; backed it up to $Path.bak and started fresh."
    return [ordered]@{}
  }
}

function Write-JsonHt([string]$Path, $Value) {
  $dir = Split-Path $Path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 20), $utf8NoBom)
}

function Is-AgentMonitorClaudeHook($Hook) {
  if ($Hook -isnot [System.Collections.IDictionary]) { return $false }
  $url = [string]$Hook["url"]
  if ($url -eq $ClaudeHookUrl -or $url -eq $OldClaudeIngestUrl) { return $true }
  if ($url -match '/hooks/claude-code$' -or $url -match '/ingest/claude-code$') { return $true }
  return $false
}

function Remove-AgentMonitorClaudeHooks($HooksTable) {
  foreach ($eventName in @($HooksTable.Keys)) {
    $groups = [System.Collections.ArrayList]@()
    foreach ($group in @($HooksTable[$eventName])) {
      if ($group -is [System.Collections.IDictionary] -and $group.Contains("hooks")) {
        $kept = @($group["hooks"] | Where-Object { -not (Is-AgentMonitorClaudeHook $_) })
        if ($kept.Count -gt 0) {
          $group["hooks"] = $kept
          [void]$groups.Add($group)
        }
      } else {
        [void]$groups.Add($group)
      }
    }
    $HooksTable[$eventName] = $groups.ToArray()
  }
}

function Add-ClaudeHooks {
  Write-Step "Wiring Claude Code governance hooks into $SettingsPath"
  $settings = Read-JsonHt $SettingsPath
  if (-not $settings.Contains("hooks")) { $settings["hooks"] = [ordered]@{} }
  $hooks = $settings["hooks"]
  Remove-AgentMonitorClaudeHooks $hooks

  foreach ($eventName in $ClaudeEvents) {
    if (-not $hooks.Contains($eventName)) { $hooks[$eventName] = @() }
    $timeout = if ($BlockingClaudeEvents -contains $eventName) { $HookTimeoutSec } else { 5 }
    $handler = [ordered]@{ type = "http"; url = $ClaudeHookUrl; timeout = $timeout }
    $group = [ordered]@{ hooks = @($handler) }
    $groups = [System.Collections.ArrayList]@($hooks[$eventName])
    [void]$groups.Add($group)
    $hooks[$eventName] = $groups.ToArray()
  }

  Write-JsonHt $SettingsPath $settings
  Write-Ok "Claude Code hooks point to $ClaudeHookUrl"
}

function New-CopilotHookConfig([string]$Surface, [bool]$NativeVSCode) {
  $forwardPs1 = Join-Path $ScriptDir "scripts\copilot-hook-forward.ps1"
  $forwardSh = (Join-Path $ScriptDir "scripts\copilot-hook-forward.sh").Replace("\", "/")
  $deadline = [Math]::Max(1, $HookTimeoutSec - 5)
  $env = [ordered]@{
    AGENT_GOVERNANCE_FAIL_MODE = $FailMode
    AGENT_GOVERNANCE_SURFACE = $Surface
  }
  if ($ControlPlaneUrl) { $env["AGENT_MONITOR_URL"] = $ControlPlaneUrl.TrimEnd('/') }

  if ($NativeVSCode) {
    $hooks = [ordered]@{}
    foreach ($eventName in $VSCodeEvents) {
      $timeout = if ($eventName -eq "PreToolUse" -or $eventName -eq "UserPromptSubmit") { $HookTimeoutSec } else { 5 }
      $hooks[$eventName] = @([ordered]@{
        type = "command"
        command = "sh '$forwardSh' --port $Port --timeout $deadline --surface $Surface"
        windows = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$forwardPs1`" -Port $Port -TimeoutSec $deadline -Surface $Surface"
        timeout = $timeout
        env = $env
      })
    }
    return [ordered]@{ hooks = $hooks }
  }

  $commandHook = [ordered]@{
    type = "command"
    powershell = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$forwardPs1`" -Port $Port -TimeoutSec $deadline -Surface $Surface"
    bash = "sh '$forwardSh' --port $Port --timeout $deadline --surface $Surface"
    timeoutSec = $HookTimeoutSec
    env = $env
  }
  $copilotHooks = [ordered]@{}
  foreach ($eventName in $CopilotEvents) { $copilotHooks[$eventName] = @($commandHook) }
  return [ordered]@{ version = 1; hooks = $copilotHooks }
}

function Install-CopilotUserHooks {
  $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
  $path = Join-Path (Join-Path $copilotHome "hooks") "agent-governance.json"
  Write-Step "Wiring Copilot CLI enforcing hooks into $path"
  Write-JsonHt $path (New-CopilotHookConfig "copilot-cli" $false)
  Write-Ok "Copilot CLI hook config written."
}

function Test-IsAdmin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Install-CopilotPolicyHooks {
  $policyDir = Join-Path $env:ProgramData "GitHub\Copilot\policy.d"
  $path = Join-Path $policyDir "agent-governance.json"
  Write-Step "Wiring machine-wide Copilot CLI policy hooks into $path"
  if (-not (Test-IsAdmin)) {
    Write-Warn "Copilot policy hooks require an elevated PowerShell session. Skipping policy install."
    return
  }
  Write-JsonHt $path (New-CopilotHookConfig "copilot-cli" $false)
  Write-Ok "Copilot CLI policy hook config written."
}

function Install-VSCodeHooks {
  $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
  $path = Join-Path (Join-Path $copilotHome "hooks") "agent-governance-vscode.json"
  Write-Step "Wiring VS Code Local harness hooks into $path"
  Write-JsonHt $path (New-CopilotHookConfig "vscode" $true)
  Write-Ok "VS Code hook config written. Ensure chat.useHooks is enabled and the workspace is trusted."
}

function Uninstall-Hooks {
  Write-Step "Removing Agent Monitor governance hook entries"
  $settings = Read-JsonHt $SettingsPath
  if ($settings.Contains("hooks")) {
    Remove-AgentMonitorClaudeHooks $settings["hooks"]
    Write-JsonHt $SettingsPath $settings
    Write-Ok "Removed Claude Code Agent Monitor hook entries."
  }

  $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
  foreach ($file in @(
    (Join-Path (Join-Path $copilotHome "hooks") "agent-governance.json"),
    (Join-Path (Join-Path $copilotHome "hooks") "agent-governance-vscode.json")
  )) {
    if (Test-Path $file) { Remove-Item $file -Force; Write-Ok "Removed $file" }
  }

  $policyFile = Join-Path (Join-Path $env:ProgramData "GitHub\Copilot\policy.d") "agent-governance.json"
  if (Test-Path $policyFile) {
    if (Test-IsAdmin) { Remove-Item $policyFile -Force; Write-Ok "Removed $policyFile" }
    else { Write-Warn "Policy hook exists at $policyFile but requires elevation to remove." }
  }
}

if ($Uninstall) {
  Uninstall-Hooks
  Write-Host "`nUninstall complete." -ForegroundColor Green
  exit 0
}

Write-Step "Checking prerequisites"
$nodeVer = $null
try { $nodeVer = (node --version 2>&1).Trim() } catch {}
if (-not $nodeVer -or $LASTEXITCODE -ne 0) { Fail "Node.js not found. Install it from https://nodejs.org/ and retry." }
Write-Ok "Node.js $nodeVer"

$verParts = ($nodeVer -replace "^v", "").Split(".")
$major = [int]$verParts[0]
$minor = [int]$verParts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) { Fail "Node.js 22.5 or later required (found $nodeVer)." }

$npmCmd = "npm"
$npmVer = $null
try { $npmVer = (npm --version 2>&1).Trim() } catch {}
if (-not $npmVer -or $LASTEXITCODE -ne 0) {
  $nodeDir = Split-Path (Get-Command node).Source
  $npmCandidate = Join-Path $nodeDir "npm.cmd"
  if (Test-Path $npmCandidate) {
    $npmCmd = $npmCandidate
    $npmVer = (& $npmCmd --version 2>&1).Trim()
  }
}
if (-not $npmVer) { Fail "npm not found. Ensure Node.js was installed with npm included." }
Write-Ok "npm $npmVer"

Write-Step "Installing npm dependencies"
Push-Location $ScriptDir
Invoke-Native { & $npmCmd install --prefer-offline } | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed." }
Write-Ok "Dependencies installed."

Write-Step "Building TypeScript"
Invoke-Native { & $npmCmd run build } | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "TypeScript build failed." }
Write-Ok "Build complete -> dist/"
Pop-Location

Add-ClaudeHooks
if ($CopilotHooks) { Install-CopilotUserHooks }
if ($CopilotPolicyHooks) { Install-CopilotPolicyHooks }
if ($VSCodeHooks) { Install-VSCodeHooks }

Write-Step "Creating start.ps1"
$startLines = @(
  "# Start Agent Monitor on port $Port",
  'Set-Location "$PSScriptRoot"',
  "node dist/server.js"
)
Set-Content (Join-Path $ScriptDir "start.ps1") ($startLines -join "`r`n") -Encoding UTF8
Write-Ok "start.ps1 written."

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "  Start the monitor:  .\start.ps1"
Write-Host "  Local URL:           http://127.0.0.1:$Port/"
Write-Host "  Claude hook URL:    $ClaudeHookUrl"
Write-Host "  Fail mode:          $FailMode (forwarder command hooks)"
if ($ControlPlaneUrl) {
  Write-Host "  Cloud control URL:  $ControlPlaneUrl"
  Write-Warn "Set AGENT_GOVERNANCE_TOKEN in hook environments when your cloud control plane requires bearer auth."
}
Write-Host "  Verify Claude Code: type /hooks inside a new Claude Code session."
