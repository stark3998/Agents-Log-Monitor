<#
.SYNOPSIS
  Deploys the AgentMon Fleet analytics rules and workbook for AgentMonAlerts_CL.

.DESCRIPTION
  -Target sentinel  Microsoft Sentinel scheduled analytics rules (incidents grouped by agent session) + a workbook
                    under Sentinel > Workbooks. Sentinel must already be enabled on the workspace, or pass
                    -EnableSentinel to onboard it (this changes the workspace and starts Sentinel billing).
  -Target monitor   Azure Monitor scheduled query (log search) alert rules instead, for workspaces without Sentinel.
                    Rules marked sentinelOnly (they need the SecurityAlert table) are skipped.

  The script is idempotent (PUT with stable names). -WhatIf prints what would change.

.EXAMPLE
  ./deploy-sentinel.ps1 -ResourceGroup rg-agentmon-lab -Workspace law-agentmon-lab -Target monitor -WhatIf
  ./deploy-sentinel.ps1 -ResourceGroup rg-agentmon-lab -Workspace law-agentmon-lab -Target sentinel
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SubscriptionId = $(az account show --query id -o tsv),
  [Parameter(Mandatory = $true)][string]$ResourceGroup,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [ValidateSet('sentinel', 'monitor')][string]$Target = 'sentinel',
  [string]$ActionGroupId,
  [switch]$EnableSentinel,
  [switch]$SkipWorkbook,
  [switch]$SkipRules
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wsId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.OperationalInsights/workspaces/$Workspace"
$arm = 'https://management.azure.com'

function Invoke-Arm([string]$Method, [string]$Path, $Body) {
  $azArgs = @('rest', '--method', $Method, '--url', "$arm$Path", '--only-show-errors')
  $tmp = $null
  if ($null -ne $Body) {
    $tmp = New-TemporaryFile
    [IO.File]::WriteAllText($tmp.FullName, ($Body | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
    $azArgs += @('--body', "@$($tmp.FullName)", '--headers', 'Content-Type=application/json')
  }
  try {
    $out = & az @azArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "az rest $Method $Path failed: $out" }
    if ($out) { return ($out | Out-String | ConvertFrom-Json) }
  } finally { if ($tmp) { Remove-Item $tmp -ErrorAction SilentlyContinue } }
}

function Get-StableGuid([string]$Text) {
  $md5 = [Security.Cryptography.MD5]::Create()
  return [guid]::new($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).ToString()
}

$ws = Invoke-Arm GET "${wsId}?api-version=2022-10-01" $null
$location = $ws.location
Write-Host "Workspace $Workspace ($location), target: $Target"

if ($Target -eq 'sentinel') {
  $onboardPath = "$wsId/providers/Microsoft.SecurityInsights/onboardingStates/default?api-version=2024-03-01"
  $onboarded = $true
  try { Invoke-Arm GET $onboardPath $null | Out-Null } catch { $onboarded = $false }
  if (-not $onboarded) {
    if (-not $EnableSentinel) {
      throw "Microsoft Sentinel is not enabled on $Workspace. Re-run with -EnableSentinel (billable) or use -Target monitor."
    }
    if ($PSCmdlet.ShouldProcess($Workspace, 'Enable Microsoft Sentinel')) {
      Invoke-Arm PUT $onboardPath @{ properties = @{} } | Out-Null
      Write-Host '  Sentinel enabled'
    }
  }
}

$rules = Get-Content (Join-Path $here 'rules.json') -Raw | ConvertFrom-Json
if (-not $SkipRules) {
  foreach ($r in $rules) {
    if ($Target -eq 'sentinel') {
      $customDetails = @{}
      foreach ($c in 'SessionId', 'AgentName', 'AlertType', 'Platform', 'UserId', 'MitreAtlasS', 'OwaspAgenticS') {
        if ($r.query -match "\b$c\b") { $customDetails[$c] = $c }
      }
      $entities = @()
      if ($r.query -match '\bUserId\b') { $entities += @{ entityType = 'Account'; fieldMappings = @(@{ identifier = 'FullName'; columnName = 'UserId' }) } }
      if ($r.query -match '\bCallerIp\b') { $entities += @{ entityType = 'IP'; fieldMappings = @(@{ identifier = 'Address'; columnName = 'CallerIp' }) } }
      if ($r.query -match '\bAgentName\b') { $entities += @{ entityType = 'CloudApplication'; fieldMappings = @(@{ identifier = 'Name'; columnName = 'AgentName' }) } }
      $groupBy = @(if ($r.query -match '\bSessionId\b') { 'SessionId' })
      $body = @{
        kind       = 'Scheduled'
        properties = @{
          displayName           = $r.displayName
          description           = $r.description
          severity              = $r.severity
          enabled               = $true
          query                 = $r.query
          queryFrequency        = $r.queryFrequency
          queryPeriod           = $r.queryPeriod
          triggerOperator       = 'GreaterThan'
          triggerThreshold      = 0
          suppressionDuration   = 'PT1H'
          suppressionEnabled    = $false
          tactics               = @($r.tactics)
          eventGroupingSettings = @{ aggregationKind = 'AlertPerResult' }
          customDetails         = $customDetails
          entityMappings        = $entities
          alertDetailsOverride  = @{ alertDisplayNameFormat = '{{Title}}'; alertDescriptionFormat = '{{Summary}}'; alertSeverityColumnName = 'SentinelSeverity' }
          incidentConfiguration = @{
            createIncident        = $true
            groupingConfiguration = @{
              enabled = $groupBy.Count -gt 0; reopenClosedIncident = $false; lookbackDuration = 'PT5H'
              matchingMethod = 'Selected'; groupByEntities = @(); groupByAlertDetails = @(); groupByCustomDetails = $groupBy
            }
          }
        }
      }
      $path = "$wsId/providers/Microsoft.SecurityInsights/alertRules/$($r.id)?api-version=2024-03-01"
    } else {
      if ($r.sentinelOnly) { Write-Host "  skip $($r.id) (needs Sentinel / SecurityAlert)"; continue }
      $sev = @{ High = 1; Medium = 2; Low = 3; Informational = 4 }[$r.severity]
      $body = @{
        location   = $location
        kind       = 'LogAlert'
        properties = @{
          displayName         = $r.displayName
          description         = $r.description
          severity            = $sev
          enabled             = $true
          evaluationFrequency = $r.queryFrequency
          windowSize          = $r.queryPeriod
          scopes              = @($wsId)
          autoMitigate        = $false
          criteria            = @{ allOf = @(@{
                query = $r.query; timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 0
                failingPeriods = @{ numberOfEvaluationPeriods = 1; minFailingPeriodsToAlert = 1 }
              }) }
          actions             = @{ actionGroups = @(if ($ActionGroupId) { $ActionGroupId }) }
        }
      }
      $path = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Insights/scheduledQueryRules/$($r.id)?api-version=2023-03-15-preview"
    }
    if ($PSCmdlet.ShouldProcess($r.id, "PUT $Target rule")) {
      Invoke-Arm PUT $path $body | Out-Null
      Write-Host "  rule $($r.id)"
    }
  }
}

if (-not $SkipWorkbook) {
  $serialized = (Get-Content (Join-Path $here 'workbook.json') -Raw).Replace('{workspaceResourceId}', $wsId)
  $name = Get-StableGuid "agentmon-fleet-workbook|$wsId"
  $body = @{
    location   = $location
    kind       = 'shared'
    properties = @{
      displayName    = 'AgentMon Fleet'
      category       = $(if ($Target -eq 'sentinel') { 'sentinel' } else { 'workbook' })
      serializedData = $serialized
      sourceId       = $wsId
      version        = 'Notebook/1.0'
    }
  }
  $path = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Insights/workbooks/${name}?api-version=2023-06-01"
  if ($PSCmdlet.ShouldProcess('AgentMon Fleet', 'PUT workbook')) {
    Invoke-Arm PUT $path $body | Out-Null
    Write-Host "  workbook AgentMon Fleet ($name)"
  }
}
Write-Host 'Done.'
