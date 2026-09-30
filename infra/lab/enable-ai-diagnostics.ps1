<#
.SYNOPSIS
  Adds an "agentmon-lab" diagnostic setting to every Cognitive Services / Foundry account (and Foundry project)
  in a subscription, sending allLogs + AllMetrics to the lab Log Analytics workspace (and the lab storage
  account when the resource is in the same region - diagnostic settings require a same-region storage account).

  Idempotent. Never modifies or removes existing diagnostic settings owned by others.
#>
param(
  [string]$SubscriptionId = 'c49edb83-3b90-4a88-9fed-6b622851c4a6',
  [string]$WorkspaceId = '/subscriptions/c49edb83-3b90-4a88-9fed-6b622851c4a6/resourceGroups/rg-agentmon-lab/providers/Microsoft.OperationalInsights/workspaces/law-agentmon-lab',
  [string]$StorageId = '/subscriptions/c49edb83-3b90-4a88-9fed-6b622851c4a6/resourceGroups/rg-agentmon-lab/providers/Microsoft.Storage/storageAccounts/stagentmonlab74eedc',
  [string]$StorageRegion = 'eastus2',
  [string]$SettingName = 'agentmon-lab',
  [switch]$IncludeProjects = $true,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
az account set --subscription $SubscriptionId | Out-Null

$logsAll = '[{"categoryGroup":"allLogs","enabled":true}]'
$metrics = '[{"category":"AllMetrics","enabled":true}]'
$results = @()

function Set-Diag([string]$resourceId, [string]$location, [string]$logs, [bool]$withMetrics) {
  $existing = az monitor diagnostic-settings list --resource $resourceId --query "[].name" -o json 2>$null | ConvertFrom-Json
  if ($existing -contains $SettingName) { return 'exists' }
  if ($existing.Count -ge 5) { return 'skipped: 5 settings already' }
  $args = @('monitor', 'diagnostic-settings', 'create', '-n', $SettingName, '--resource', $resourceId, '--workspace', $WorkspaceId, '--logs', $logs)
  if ($withMetrics) { $args += @('--metrics', $metrics) }
  if ($location -eq $StorageRegion) { $args += @('--storage-account', $StorageId) }
  if ($WhatIf) { return 'whatif' }
  $out = & az @args 2>&1
  if ($LASTEXITCODE -ne 0) { return "error: $(($out | Out-String).Trim().Split("`n")[0])" }
  return 'created'
}

$accounts = az cognitiveservices account list --query "[].{id:id,name:name,kind:kind,location:location}" -o json | ConvertFrom-Json
foreach ($a in $accounts) {
  $status = Set-Diag $a.id $a.location $logsAll $true
  $results += [pscustomobject]@{ Resource = $a.name; Kind = $a.kind; Location = $a.location; Status = $status }
  if ($IncludeProjects -and $a.kind -eq 'AIServices') {
    $projects = az rest --method get --url "https://management.azure.com$($a.id)/projects?api-version=2025-06-01" --query "value[].{id:id,name:name}" -o json 2>$null | ConvertFrom-Json
    foreach ($p in $projects) {
      $pl = '[{"category":"Audit","enabled":true},{"category":"Trace","enabled":true}]'
      $ps = Set-Diag $p.id $a.location $pl $false
      $results += [pscustomobject]@{ Resource = $p.name; Kind = 'project'; Location = $a.location; Status = $ps }
    }
  }
}
$results | Format-Table -AutoSize | Out-String -Width 220
