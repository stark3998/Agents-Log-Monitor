# Agent Monitor -- installation script (Windows, PowerShell 5.1+)
# Run once from the project root: .\install.ps1
# Re-running is safe: hooks are merged, never duplicated.

param(
  [int]$Port = 4317
)

# If running under old Windows PowerShell (5.x), re-invoke via pwsh (PS7) when available.
# PS7 handles UTF-8 scripts reliably; PS5.1 can misread non-BOM UTF-8 files.
if ($PSVersionTable.PSEdition -ne 'Core') {
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) {
    & $pwsh.Source -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path -Port $Port
    exit $LASTEXITCODE
  }
}

$ErrorActionPreference = "Stop"

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$IngestUrl    = "http://127.0.0.1:$Port/ingest/claude-code"
$SettingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"

$HookEvents = @(
  "SessionStart", "SessionEnd", "UserPromptSubmit",
  "PreToolUse", "PostToolUse",
  "SubagentStart", "SubagentStop",
  "Stop", "Notification"
)

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    $msg"  -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }
function Fail([string]$msg)       { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. Prerequisites -------------------------------------------------------

Write-Step "Checking prerequisites"

$nodeVer = $null
try   { $nodeVer = (node --version 2>&1).Trim() } catch {}
if (-not $nodeVer -or $LASTEXITCODE -ne 0) {
  Fail "Node.js not found. Install it from https://nodejs.org/ and retry."
}
Write-Ok "Node.js $nodeVer"

$major = [int]($nodeVer -replace "v(\d+).*", '$1')
if ($major -lt 18) { Fail "Node.js 18 or later required (found $nodeVer)." }

# Locate npm: try PATH first, then fall back to the directory beside node.exe
# (on Windows, npm.cmd is installed in the same folder as node.exe).
$npmCmd = "npm"
$npmVer = $null
try   { $npmVer = (npm --version 2>&1).Trim() } catch {}
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

# --- 2. Install dependencies ------------------------------------------------

Write-Step "Installing npm dependencies"
Push-Location $ScriptDir
& $npmCmd install --prefer-offline 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed." }
Write-Ok "Dependencies installed."
Pop-Location

# --- 3. Build ---------------------------------------------------------------

Write-Step "Building TypeScript"
Push-Location $ScriptDir
& $npmCmd run build 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "TypeScript build failed." }
Write-Ok "Build complete -> dist/"
Pop-Location

# --- 4. Patch ~/.claude/settings.json --------------------------------------

Write-Step "Wiring Claude Code hooks into $SettingsPath"

$settingsDir = Split-Path $SettingsPath
if (-not (Test-Path $settingsDir)) {
  New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
}

$rawJson  = if (Test-Path $SettingsPath) { Get-Content $SettingsPath -Raw -Encoding UTF8 } else { '{}' }
$settings = $null
try   { $settings = $rawJson | ConvertFrom-Json } catch {}
if ($null -eq $settings) {
  Write-Warn "Could not parse existing settings.json -- backing up and starting fresh."
  if (Test-Path $SettingsPath) { Copy-Item $SettingsPath "$SettingsPath.bak" -Force }
  $settings = '{}' | ConvertFrom-Json
}

# Convert PSCustomObject (PS5.1's ConvertFrom-Json output) to a mutable hashtable.
function ConvertTo-MutableHt {
  param($Obj)
  if ($null -eq $Obj)                        { return $null }
  if ($Obj -is [System.Collections.IList])   { return @($Obj | ForEach-Object { ConvertTo-MutableHt $_ }) }
  if ($Obj -is [System.Collections.IDictionary])                  { return $Obj }
  if ($Obj -is [System.Management.Automation.PSCustomObject]) {
    $ht = [ordered]@{}
    foreach ($prop in $Obj.PSObject.Properties) {
      $ht[$prop.Name] = ConvertTo-MutableHt $prop.Value
    }
    return $ht
  }
  return $Obj
}

$ht    = ConvertTo-MutableHt $settings
if (-not $ht.Contains("hooks")) { $ht["hooks"] = [ordered]@{} }
$hooks = $ht["hooks"]

$added   = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()

foreach ($hookEvent in $HookEvents) {
  if (-not $hooks.Contains($hookEvent)) { $hooks[$hookEvent] = @() }

  $alreadyPresent = $false
  $eventGroups    = @($hooks[$hookEvent])
  foreach ($group in $eventGroups) {
    $groupHooks = @()
    if ($group -is [System.Collections.IDictionary] -and $group.Contains("hooks")) {
      $groupHooks = @($group["hooks"])
    }
    foreach ($h in $groupHooks) {
      if ($h -is [System.Collections.IDictionary] -and $h["url"] -eq $IngestUrl) {
        $alreadyPresent = $true; break
      }
    }
    if ($alreadyPresent) { break }
  }

  if ($alreadyPresent) { $skipped.Add($hookEvent); continue }

  $newGroup    = [ordered]@{ hooks = @([ordered]@{ type = "http"; url = $IngestUrl; timeout = 2 }) }
  $eventGroups = [System.Collections.ArrayList]@($eventGroups)
  $eventGroups.Add($newGroup) | Out-Null
  $hooks[$hookEvent] = $eventGroups.ToArray()
  $added.Add($hookEvent)
}

$ht | ConvertTo-Json -Depth 10 | Set-Content $SettingsPath -Encoding UTF8

if ($added.Count   -gt 0) { Write-Ok "Added hooks for:  $($added   -join ', ')" }
if ($skipped.Count -gt 0) { Write-Ok "Already present:  $($skipped -join ', ')" }

# --- 5. Convenience start script --------------------------------------------

Write-Step "Creating start.ps1"
$startLines = @(
  "# Start Agent Monitor on port $Port",
  'Set-Location "$PSScriptRoot"',
  "node dist/server.js"
)
Set-Content (Join-Path $ScriptDir "start.ps1") ($startLines -join "`r`n") -Encoding UTF8
Write-Ok "start.ps1 written."

# --- Done -------------------------------------------------------------------

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Start the monitor:  .\start.ps1"
Write-Host "  Open the UI:        http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "  Hooks cover all Claude Code surfaces (CLI, VS Code extension, Desktop app)"
Write-Host "  because they all share the same settings.json."
Write-Host "  Restart any active Claude Code session for changes to take effect."
Write-Host ""
Write-Host "  Verify: type /hooks inside any Claude Code session"
Write-Host ""
