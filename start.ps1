<#
.SYNOPSIS
  Runs Agent Monitor locally, without Docker.

.DESCRIPTION
  Checks prerequisites, installs npm dependencies when they are missing or out of date, rebuilds the server
  (dist/) and dashboard (public/) when the sources changed, then starts the monitor on http://127.0.0.1:<Port>.

  Optional:
    -Intelligence  also runs the Python intelligence service (Guardian, lane drafter, Ask chat) and points the
                   monitor at it. The virtual environment in intelligence\.venv is created on first use.
    -Dev           hot reload: the API server runs from src/ with ts-node and the dashboard is served by Vite on
                   http://127.0.0.1:5173 (open that one). Nothing is built.

  By default everything runs in this window and Ctrl+C stops all of it. With -Background the services run
  hidden; logs and process ids go to .run\. Use -Status to check them and -Stop to stop them.

  Settings come from the repo-root .env. Variables already set in your shell win over .env.

.EXAMPLE
  .\start.ps1
  Build if needed and run the monitor on port 4317 (or PORT from .env).

.EXAMPLE
  .\start.ps1 -Intelligence -Open
  Also run the intelligence service on port 8000 and open the dashboard in the browser.

.EXAMPLE
  .\start.ps1 -Dev
  API server with ts-node plus Vite with hot reload on http://127.0.0.1:5173.

.EXAMPLE
  .\start.ps1 -Background -Intelligence ; .\start.ps1 -Status ; .\start.ps1 -Stop
  Run in the background, check it, and stop it again.
#>
[CmdletBinding()]
param(
  # Monitor port. Default: $env:PORT, else PORT in .env, else 4317.
  [int]$Port = 0,
  # Also run the Python intelligence service and set INTELLIGENCE_URL for the monitor.
  [switch]$Intelligence,
  [int]$IntelligencePort = 8000,
  # Hot reload: ts-node API server plus the Vite dev server on port 5173.
  [switch]$Dev,
  # Run hidden in the background (logs in .run\); returns once everything is healthy.
  [switch]$Background,
  # Open the dashboard in the default browser once it is up.
  [switch]$Open,
  # Run a full 'npm run build' even if the output looks current.
  [switch]$Rebuild,
  # Never build or install; use what is already there.
  [switch]$SkipBuild,
  # If a previous instance holds a port, stop it first instead of failing.
  [switch]$Restart,
  # Stop services started by this script (and any monitor still listening on the port).
  [switch]$Stop,
  # Show what is running.
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RunDir = Join-Path $Root '.run'
$PidFile = Join-Path $RunDir 'pids.json'
$VitePort = 5173   # the local admin guard only trusts this dev-server port
Set-Location $Root

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Note([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn([string]$msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 turns native stderr output into errors under ErrorActionPreference=Stop, and npm, pip and
# vite print warnings there. Run natives with Continue and judge success by the exit code.
function Invoke-Native([string]$What, [scriptblock]$Command) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
      Write-Host "    $line" -ForegroundColor DarkGray
    }
  } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)." }
}

function Get-DotEnvValue([string]$Name) {
  $file = Join-Path $Root '.env'
  if (-not (Test-Path $file)) { return $null }
  foreach ($line in Get-Content $file) {
    if ($line -match "^\s*(export\s+)?$Name\s*=\s*(.*)$") {
      $v = $Matches[2].Trim()
      if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] } else { $v = ($v -split '\s+#')[0].Trim() }
      if ($v) { return $v }
    }
  }
  return $null
}

function Get-Listener([int]$P) {
  $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
  [pscustomobject]@{ Port = $P; Pid = [int]$c.OwningProcess; CommandLine = if ($proc) { $proc.CommandLine } else { '' } }
}

# Processes this repo starts: the monitor (built or ts-node), Vite, and uvicorn for the intelligence service.
function Test-OwnProcess($Listener) {
  $Listener -and $Listener.CommandLine -match 'dist[\\/]server\.js|src[\\/]server\.ts|ts-node|vite|agentgov_intel'
}

function Stop-Tree([int]$ProcessId) {
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue)) {
    Stop-Tree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Read-Pids {
  if (-not (Test-Path $PidFile)) { return @() }
  # PowerShell 5.1's ConvertFrom-Json emits a JSON array as one object; piping it through unrolls the entries.
  try { return @(Get-Content $PidFile -Raw | ConvertFrom-Json | ForEach-Object { $_ } | Where-Object { $_.pid }) } catch { return @() }
}

function Save-Pids($Entries) {
  if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir | Out-Null }
  if (@($Entries).Count -eq 0) { Remove-Item $PidFile -ErrorAction SilentlyContinue; return }
  ConvertTo-Json -InputObject @($Entries) | Set-Content $PidFile -Encoding ASCII
}

function Test-Alive($Entry) {
  $p = Get-Process -Id $Entry.pid -ErrorAction SilentlyContinue
  # Guard against pid reuse: the process must have started when we recorded it.
  $p -and ([math]::Abs(($p.StartTime.ToUniversalTime() - ([datetime]$Entry.started).ToUniversalTime()).TotalSeconds) -lt 5)
}

function Wait-Http([string]$Url, [int]$TimeoutSec, $Process) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) { return $false }
    try {
      $r = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -lt 500) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Start-Service2([string]$Name, [string]$File, [string[]]$Arguments, [string]$WorkDir, [int]$ServicePort) {
  if (-not (Test-Path $RunDir)) { New-Item -ItemType Directory -Path $RunDir | Out-Null }
  $out = Join-Path $RunDir "$Name.log"
  $err = Join-Path $RunDir "$Name.err.log"
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
  $null = $p.Handle   # keeps ExitCode readable after the process exits
  [pscustomobject]@{ name = $Name; pid = $p.Id; port = $ServicePort; started = $p.StartTime.ToUniversalTime().ToString('o'); log = $out; err = $err; process = $p }
}

function Show-LogTail($Svc) {
  foreach ($f in @($Svc.err, $Svc.log)) {
    if ($f -and (Test-Path $f)) {
      $tail = Get-Content $f -Tail 15 -ErrorAction SilentlyContinue
      if ($tail) { Write-Host "    --- $f" -ForegroundColor DarkGray; $tail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
  }
}

function Get-NewestWrite([string[]]$Paths) {
  $newest = [datetime]::MinValue
  foreach ($p in $Paths) {
    if (-not (Test-Path $p)) { continue }
    $item = Get-Item $p
    $t = if ($item.PSIsContainer) {
      (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object LastWriteTime -Maximum).Maximum
    } else { $item.LastWriteTime }
    if ($t -and $t -gt $newest) { $newest = $t }
  }
  $newest
}

function Get-Npm {
  foreach ($n in 'npm.cmd', 'npm') {
    $cmd = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
  }
  $nodeDir = Split-Path (Get-Command node).Source
  $candidate = Join-Path $nodeDir 'npm.cmd'
  if (Test-Path $candidate) { return $candidate }
  Fail 'npm not found. Reinstall Node.js with npm included.'
}

function Get-Python312 {
  $candidates = @()
  if (Get-Command py -ErrorAction SilentlyContinue) { $candidates += , @('py', '-3') }
  if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += , @('python') }
  if (Get-Command python3 -ErrorAction SilentlyContinue) { $candidates += , @('python3') }
  foreach ($c in $candidates) {
    $exe = $c[0]; $pre = @($c | Select-Object -Skip 1)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $v = & $exe @pre -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>$null
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -eq 0 -and $v -and ([version]"$v" -ge [version]'3.12')) { return , $c }
  }
  return $null
}

# -- Status / Stop ----------------------------------------------------------------------------------------------

if (-not $Port) {
  $fromEnv = if ($env:PORT) { $env:PORT } else { Get-DotEnvValue 'PORT' }
  $Port = if ($fromEnv) { [int]$fromEnv } else { 4317 }
}

if ($Status) {
  $entries = Read-Pids
  if (@($entries).Count -eq 0) { Write-Host 'No background services recorded in .run\pids.json.' }
  foreach ($e in $entries) {
    $state = if (Test-Alive $e) { 'running' } else { 'stopped' }
    $color = if ($state -eq 'running') { 'Green' } else { 'Yellow' }
    Write-Host ("{0,-13} {1,-8} pid {2,-6} port {3,-5} log {4}" -f $e.name, $state, $e.pid, $e.port, $e.log) -ForegroundColor $color
  }
  $l = Get-Listener $Port
  if ($l) { Write-Host "Port $Port is in use by pid $($l.Pid): $($l.CommandLine)" }
  else { Write-Host "Nothing is listening on port $Port." }
  exit 0
}

if ($Stop) {
  $stopped = 0
  foreach ($e in Read-Pids) {
    if (Test-Alive $e) { Stop-Tree ([int]$e.pid); Write-Ok "Stopped $($e.name) (pid $($e.pid))."; $stopped++ }
  }
  Save-Pids @()
  foreach ($p in @($Port, $IntelligencePort, $VitePort)) {
    $l = Get-Listener $p
    if ($l -and (Test-OwnProcess $l)) { Stop-Tree $l.Pid; Write-Ok "Stopped pid $($l.Pid) on port $p ($($l.CommandLine))."; $stopped++ }
  }
  if ($stopped -eq 0) { Write-Host 'Nothing to stop.' }
  exit 0
}

if ($Rebuild -and $SkipBuild) { Fail '-Rebuild and -SkipBuild cannot be combined.' }

# -- Prerequisites -----------------------------------------------------------------------------------------------

Write-Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js not found. Install Node.js 22.5 or later from https://nodejs.org/.' }
$nodeVer = (& node --version).Trim()
$parts = ($nodeVer -replace '^v', '').Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 5)) { Fail "Node.js 22.5 or later is required (found $nodeVer)." }
Write-Ok "Node.js $nodeVer"
$npm = Get-Npm
if (-not (Test-Path (Join-Path $Root '.env'))) {
  Write-Warn 'No .env found. Defaults apply (local mode, no Foundry). Copy .env.example to .env to configure.'
}

# Ports must be free (or held by a previous run we may restart).
$ports = @(@{ Name = 'monitor'; Port = $Port })
if ($Intelligence) { $ports += @{ Name = 'intelligence'; Port = $IntelligencePort } }
if ($Dev) { $ports += @{ Name = 'vite'; Port = $VitePort } }
foreach ($p in $ports) {
  $l = Get-Listener $p.Port
  if (-not $l) { continue }
  if ($Restart -and (Test-OwnProcess $l)) {
    Stop-Tree $l.Pid
    Start-Sleep -Milliseconds 800
    Write-Ok "Stopped the previous $($p.Name) on port $($p.Port) (pid $($l.Pid))."
  } elseif (Test-OwnProcess $l) {
    Fail "Port $($p.Port) is already used by a previous $($p.Name) (pid $($l.Pid)). Run .\start.ps1 -Stop, or add -Restart."
  } else {
    Fail "Port $($p.Port) is in use by another program (pid $($l.Pid): $($l.CommandLine)). Free it or pick another port."
  }
}

# -- Install and build -------------------------------------------------------------------------------------------

if (-not $SkipBuild) {
  $rootMarker = Join-Path $Root 'node_modules\.package-lock.json'
  $webMarker = Join-Path $Root 'web\node_modules\.package-lock.json'
  $needsInstall = -not (Test-Path $rootMarker) -or -not (Test-Path $webMarker) -or
    ((Get-NewestWrite @('package.json', 'package-lock.json')) -gt (Get-Item $rootMarker).LastWriteTime) -or
    ((Get-NewestWrite @('web\package.json', 'web\package-lock.json')) -gt (Get-Item $webMarker).LastWriteTime)
  if ($needsInstall) {
    Write-Step 'Installing npm dependencies (root and web/)'
    Invoke-Native 'npm install' { & $npm install --no-audit --no-fund }
    # npm leaves its marker untouched when nothing changed; stamp it so the next start skips the install.
    foreach ($m in @($rootMarker, $webMarker)) { if (Test-Path $m) { (Get-Item $m).LastWriteTime = Get-Date } }
  }

  if ($Dev) {
    Write-Note 'Dev mode: skipping the build (ts-node and Vite compile on the fly).'
  } elseif ($Rebuild) {
    Write-Step 'Building server and dashboard'
    Invoke-Native 'npm run build' { & $npm run build }
  } else {
    $serverOut = Join-Path $Root 'dist\server.js'
    $webOut = Join-Path $Root 'public\index.html'
    $serverSrc = Get-NewestWrite @('src', 'tsconfig.json', 'package.json')
    $webSrc = Get-NewestWrite @('web\src', 'web\index.html', 'web\vite.config.ts', 'web\package.json', 'web\tsconfig.json', 'web\tsconfig.app.json')
    if (-not (Test-Path $serverOut) -or $serverSrc -gt (Get-Item $serverOut).LastWriteTime) {
      Write-Step 'Building the server (src/ -> dist/)'
      Invoke-Native 'npm run build:server' { & $npm run build:server }
    } else { Write-Ok 'Server build is current.' }
    if (-not (Test-Path $webOut) -or $webSrc -gt (Get-Item $webOut).LastWriteTime) {
      Write-Step 'Building the dashboard (web/ -> public/)'
      Invoke-Native 'npm run build:web' { & $npm run build:web }
    } else { Write-Ok 'Dashboard build is current.' }
  }
} elseif (-not $Dev -and -not (Test-Path (Join-Path $Root 'dist\server.js'))) {
  Fail 'dist\server.js is missing. Run without -SkipBuild (or npm run build) first.'
}

$intelPython = Join-Path $Root 'intelligence\.venv\Scripts\python.exe'
if ($Intelligence -and -not $SkipBuild) {
  $marker = Join-Path $Root 'intelligence\.venv\.agentmon-installed'
  $pyproject = Join-Path $Root 'intelligence\pyproject.toml'
  if (-not (Test-Path $intelPython)) {
    Write-Step 'Creating the intelligence virtual environment (intelligence\.venv)'
    $py = Get-Python312
    if (-not $py) { Fail 'Python 3.12 or later is required for -Intelligence. Install it from https://www.python.org/.' }
    $exe = $py[0]; $pre = @($py | Select-Object -Skip 1)
    Invoke-Native 'python -m venv' { & $exe @pre -m venv (Join-Path $Root 'intelligence\.venv') }
  }
  if (-not (Test-Path $marker) -or (Get-Item $pyproject).LastWriteTime -gt (Get-Item $marker).LastWriteTime) {
    Write-Step 'Installing the intelligence service (pip install -e intelligence)'
    Invoke-Native 'pip install' { & $intelPython -m pip install --disable-pip-version-check -q -e (Join-Path $Root 'intelligence') }
    Set-Content $marker (Get-Date -Format o) -Encoding ASCII
  }
}
if ($Intelligence -and -not (Test-Path $intelPython)) { Fail 'intelligence\.venv is missing. Run without -SkipBuild first.' }

# -- Start -------------------------------------------------------------------------------------------------------

$monitorUrl = "http://127.0.0.1:$Port"
$intelUrl = "http://127.0.0.1:$IntelligencePort"
$env:PORT = "$Port"
$env:AGENT_MONITOR_URL = $monitorUrl   # Vite proxy target
if ($Intelligence) {
  $env:INTELLIGENCE_URL = $intelUrl
  $env:MONITOR_API_URL = $monitorUrl
  $env:MONITOR_MCP_URL = "$monitorUrl/mcp"
}

$services = @()
$started = $false
$exitCode = 0
try {
  if ($Intelligence) {
    Write-Step "Starting the intelligence service on $intelUrl"
    $intelArgs = @('-m', 'uvicorn', 'agentgov_intel.app:app', '--host', '127.0.0.1', '--port', "$IntelligencePort")
    if ($Dev) { $intelArgs += '--reload' }
    $services += Start-Service2 'intelligence' $intelPython $intelArgs (Join-Path $Root 'intelligence') $IntelligencePort
  }

  if ($Dev) {
    Write-Step "Starting Vite (hot reload) on http://127.0.0.1:$VitePort"
    $viteArgs = @('node_modules\vite\bin\vite.js', '--host', '127.0.0.1', '--port', "$VitePort", '--strictPort')
    $services += Start-Service2 'vite' 'node' $viteArgs (Join-Path $Root 'web') $VitePort
  }

  $monitorArgs = if ($Dev) { @('node_modules\ts-node\dist\bin.js', 'src/server.ts') } else { @('dist/server.js') }
  $mode = if ($Dev) { 'ts-node, dev' } else { 'built' }
  Write-Step "Starting the monitor ($mode) on $monitorUrl"
  if ($Background) {
    $monitor = Start-Service2 'monitor' 'node' $monitorArgs $Root $Port
  } else {
    $p = Start-Process -FilePath 'node' -ArgumentList $monitorArgs -WorkingDirectory $Root -NoNewWindow -PassThru
    $null = $p.Handle
    $monitor = [pscustomobject]@{ name = 'monitor'; pid = $p.Id; port = $Port; started = $p.StartTime.ToUniversalTime().ToString('o'); log = $null; err = $null; process = $p }
  }
  $services += $monitor
  $ourPorts = @($services | ForEach-Object { $_.port })
  $kept = @(Read-Pids | Where-Object { ($ourPorts -notcontains $_.port) -and (Test-Alive $_) })
  Save-Pids (@($kept) + @($services | Select-Object name, pid, port, started, log, err))

  # Wait for each service to answer.
  $checks = @(@{ Svc = $monitor; Url = "$monitorUrl/health"; Timeout = $(if ($Dev) { 120 } else { 60 }) })
  foreach ($s in $services | Where-Object { $_.name -eq 'intelligence' }) { $checks += @{ Svc = $s; Url = "$intelUrl/health"; Timeout = 60 } }
  foreach ($s in $services | Where-Object { $_.name -eq 'vite' }) { $checks += @{ Svc = $s; Url = "http://127.0.0.1:$VitePort/"; Timeout = 60 } }
  foreach ($c in $checks) {
    if (-not (Wait-Http $c.Url $c.Timeout $c.Svc.process)) {
      Write-Host "ERROR: $($c.Svc.name) did not become healthy at $($c.Url)." -ForegroundColor Red
      Show-LogTail $c.Svc
      throw "$($c.Svc.name) failed to start"
    }
    Write-Ok "$($c.Svc.name) is up ($($c.Url))."
  }
  $started = $true

  $uiUrl = if ($Dev) { "http://127.0.0.1:$VitePort/" } else { "$monitorUrl/" }
  Write-Host ''
  Write-Host "Agent Monitor is running." -ForegroundColor Green
  Write-Host "  Dashboard:      $uiUrl"
  Write-Host "  API / health:   $monitorUrl/health"
  if ($Intelligence) { Write-Host "  Intelligence:   $intelUrl  (INTELLIGENCE_URL)" }
  if ($Background) {
    $login = Select-String -Path $monitor.log, $monitor.err -Pattern 'AGENTGOV_ADMIN_LOGIN_URL=(\S+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($login) { Write-Host "  Local admin:    $($login.Matches[0].Groups[1].Value)" }
    Write-Host "  Logs:           $RunDir"
    Write-Host '  Stop with:      .\start.ps1 -Stop'
  } else {
    Write-Host '  Press Ctrl+C to stop.'
  }
  if ($Open) { Start-Process $uiUrl }

  if (-not $Background) {
    # Ctrl+C reaches the monitor (same console) and interrupts this loop; 'finally' stops the hidden helpers.
    while (-not $monitor.process.HasExited) {
      Start-Sleep -Milliseconds 500
      foreach ($s in $services | Where-Object { $_.name -ne 'monitor' -and $_.process.HasExited }) {
        Write-Warn "$($s.name) exited (code $($s.process.ExitCode)). See $($s.err)"
        $services = @($services | Where-Object { $_ -ne $s })
      }
    }
    Write-Host "The monitor exited (code $($monitor.process.ExitCode))."
    $exitCode = $monitor.process.ExitCode
  }
} finally {
  if (-not $Background -or -not $started) {
    foreach ($s in $services) { if (-not $s.process.HasExited) { Stop-Tree $s.pid } }
    $ids = @($services | ForEach-Object { $_.pid })
    Save-Pids @(Read-Pids | Where-Object { $ids -notcontains $_.pid })
    if (@($services).Count -gt 0) { Write-Note 'Stopped all services started by this script.' }
  }
}
exit $exitCode
