param(
  [int]$Port = 4317,
  [int]$TimeoutSec = 110,
  [ValidateSet('copilot-cli', 'vscode', 'copilot-cloud-agent')]
  [string]$Surface = 'copilot-cli'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-HookEventName($JsonText) {
  try {
    $obj = $JsonText | ConvertFrom-Json
    if ($obj.hook_event_name) { return [string]$obj.hook_event_name }
    if ($obj.hookEventName) { return [string]$obj.hookEventName }
    if ($obj.hookType) { return [string]$obj.hookType }
    if ($obj.tool_name -or $obj.toolName) { return 'PreToolUse' }
  } catch {}
  return ''
}

function Get-ToolName($JsonText) {
  try {
    $obj = $JsonText | ConvertFrom-Json
    foreach ($name in @('tool_name', 'toolName', 'name')) {
      $prop = $obj.PSObject.Properties[$name]
      if ($prop -and $prop.Value) { return [string]$prop.Value }
    }
  } catch {}
  return ''
}

function Get-AutoFailMode([string]$JsonText) {
  $tool = (Get-ToolName $JsonText).ToLowerInvariant()
  if ($tool -match '^(view|read|grep|glob|ls|search)$') { return 'open' }
  return 'closed'
}

function New-DecisionJson([string]$Decision, [string]$Reason) {
  return (@{
    permissionDecision = $Decision
    permissionDecisionReason = $Reason
  } | ConvertTo-Json -Compress)
}

function Get-EndpointUrl {
  $base = $env:AGENT_MONITOR_URL
  if ($base) {
    $trimmed = $base.TrimEnd('/')
    if ($trimmed -match '/hooks/[^/]+$') { return $trimmed }
    return "$trimmed/hooks/$Surface"
  }
  return "http://127.0.0.1:$Port/hooks/$Surface"
}

try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false } catch {}

if ($env:AGENT_MONITOR_PORT) {
  $parsedPort = 0
  if ([int]::TryParse($env:AGENT_MONITOR_PORT, [ref]$parsedPort)) { $Port = $parsedPort }
}
if ($env:AGENT_GOVERNANCE_TIMEOUT_SEC) {
  $parsedTimeout = 0
  if ([int]::TryParse($env:AGENT_GOVERNANCE_TIMEOUT_SEC, [ref]$parsedTimeout)) { $TimeoutSec = $parsedTimeout }
}

$body = [Console]::In.ReadToEnd()
$eventName = Get-HookEventName $body
$isPreToolUse = $eventName -ieq 'PreToolUse' -or $eventName -ieq 'preToolUse'

if ([string]::IsNullOrWhiteSpace($body)) {
  if ($isPreToolUse) { Write-Output (New-DecisionJson 'allow' 'No hook payload was provided; governance fail-open.') }
  exit 0
}

try {
  $headers = @{}
  if ($env:AGENT_GOVERNANCE_TOKEN) { $headers['Authorization'] = "Bearer $($env:AGENT_GOVERNANCE_TOKEN)" }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $params = @{
    Uri = Get-EndpointUrl
    Method = 'Post'
    Body = $bytes
    ContentType = 'application/json; charset=utf-8'
    TimeoutSec = $TimeoutSec
    Headers = $headers
    ErrorAction = 'Stop'
  }
  if ($PSVersionTable.PSVersion.Major -lt 6) { $params['UseBasicParsing'] = $true }
  $response = Invoke-WebRequest @params
  if ($isPreToolUse) {
    $text = [string]$response.Content
    if ([string]::IsNullOrWhiteSpace($text)) {
      Write-Output (New-DecisionJson 'allow' 'Governance service returned no decision; fail-open.')
    } else {
      try {
        $json = $text | ConvertFrom-Json
        Write-Output ($json | ConvertTo-Json -Compress -Depth 20)
      } catch {
        Write-Output (New-DecisionJson 'allow' 'Governance service returned an invalid decision; fail-open.')
      }
    }
  }
} catch {
  if ($isPreToolUse) {
    $failMode = if ($env:AGENT_GOVERNANCE_FAIL_MODE) { $env:AGENT_GOVERNANCE_FAIL_MODE.ToLowerInvariant() } else { 'auto' }
    if ($failMode -eq 'auto') { $failMode = Get-AutoFailMode $body }
    if ($failMode -eq 'closed') {
      Write-Output (New-DecisionJson 'deny' 'governance service unreachable')
    } else {
      Write-Output (New-DecisionJson 'allow' 'governance service unreachable; fail-open')
    }
  }
}

exit 0
