<#
.SYNOPSIS
  Idempotent provisioning of the AgentMon lab telemetry sources used by the monitoring fleet.

.DESCRIPTION
  Steps (run all, or pick with -Steps):
    network      NSG + public IP (DNS label) + B1s Ubuntu VM in vnet-agentmon-lab/snet-workloads hosting the lab
                 "vendor directory" API (infra/lab/vendor-api) behind Caddy/HTTPS. Used as an OpenAPI tool target so
                 VNet flow logs (NTANetAnalytics) contain agent-driven traffic. No SSH: manage with `az vm run-command`.
    foundry      Verifies the Foundry project has an Application Insights connection (server-side agent tracing) and
                 that the fleet identity has data-plane access (Foundry User) on the account.
    dataverse    In the AgentMon-Lab Power Platform environment: creates the least-privilege security role
                 "AgentMon Fleet Reader" (read bot, botcomponent, conversationtranscript, audit), an application user
                 for the fleet service principal with that role, and enables auditing on bot/botcomponent.
    diagnostics  Reports AI accounts/projects NOT sending diagnostics to the lab workspace (read-only unless
                 -ApplyDiagnostics).

  Nothing outside rg-agentmon-lab, the Foundry account, or the AgentMon-Lab environment is modified, except
  diagnostic settings when -ApplyDiagnostics is passed (delegates to enable-ai-diagnostics.ps1).

.EXAMPLE
  ./provision-lab.ps1 -WhatIf
  ./provision-lab.ps1 -Steps network,dataverse
#>
param(
  [string]$SubscriptionId = 'c49edb83-3b90-4a88-9fed-6b622851c4a6',
  [string]$ResourceGroup = 'rg-agentmon-lab',
  [string]$Location = 'eastus2',
  [string]$VNet = 'vnet-agentmon-lab',
  [string]$Subnet = 'snet-workloads',
  [string]$VmName = 'vm-agentmon-vendorapi',
  [string]$VmSize = 'Standard_B1s',
  [string]$FoundryAccountId = '/subscriptions/c49edb83-3b90-4a88-9fed-6b622851c4a6/resourceGroups/DMig_group/providers/Microsoft.CognitiveServices/accounts/codex-jay-resource',
  [string]$FoundryProject = 'codex-jay',
  [string]$AppInsightsId = '/subscriptions/c49edb83-3b90-4a88-9fed-6b622851c4a6/resourceGroups/rg-agentmon-lab/providers/microsoft.insights/components/appi-agentmon-lab',
  [string]$DataverseUrl = 'https://agentmonlab.crm.dynamics.com',
  [string]$FleetAppId = 'c42031f7-b89b-4901-83e8-208a43204ad3',
  [ValidateSet('network', 'foundry', 'dataverse', 'diagnostics')]
  [string[]]$Steps = @('network', 'foundry', 'dataverse', 'diagnostics'),
  [switch]$ApplyDiagnostics,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
az account set --subscription $SubscriptionId | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say([string]$m) { Write-Host "[lab] $m" -ForegroundColor Cyan }
# Existence probes: a miss is an expected answer, not a failure (PS 5.1 would otherwise throw on az stderr).
function Get-AzValue([string[]]$azArgs) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & az @azArgs 2>$null; if ($LASTEXITCODE -eq 0) { return $o } return $null } finally { $ErrorActionPreference = $prev }
}
function Invoke-Az([string[]]$azArgs) {
  if ($WhatIf) { Say "WHATIF az $($azArgs -join ' ')"; return $null }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & az @azArgs --only-show-errors 2>&1 } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "az $($azArgs[0..2] -join ' ') failed: $($out | Out-String)" }
  return $out
}

# ── network: vendor API VM ──────────────────────────────────────────────────────────────────────────────────────
function Step-Network {
  $nsg = 'nsg-agentmon-workloads'
  $pip = "pip-$VmName"
  $label = 'agentmon-vendors-' + $SubscriptionId.Substring(0, 6)
  $fqdn = "$label.$Location.cloudapp.azure.com"
  if (-not (Get-AzValue @('network', 'nsg', 'show', '-g', $ResourceGroup, '-n', $nsg, '--query', 'id', '-o', 'tsv'))) {
    Say "creating $nsg (HTTPS + HTTP for ACME inbound only; SSH/RDP denied)"
    Invoke-Az @('network', 'nsg', 'create', '-g', $ResourceGroup, '-n', $nsg, '-l', $Location) | Out-Null
    Invoke-Az @('network', 'nsg', 'rule', 'create', '-g', $ResourceGroup, '--nsg-name', $nsg, '-n', 'allow-web', '--priority', '100',
      '--direction', 'Inbound', '--access', 'Allow', '--protocol', 'Tcp', '--destination-port-ranges', '443', '80') | Out-Null
    Invoke-Az @('network', 'nsg', 'rule', 'create', '-g', $ResourceGroup, '--nsg-name', $nsg, '-n', 'deny-ssh-rdp', '--priority', '200',
      '--direction', 'Inbound', '--access', 'Deny', '--protocol', '*', '--destination-port-ranges', '22', '3389') | Out-Null
  }
  $snetNsg = az network vnet subnet show -g $ResourceGroup --vnet-name $VNet -n $Subnet --query networkSecurityGroup.id -o tsv
  if (-not $snetNsg) {
    Say "associating $nsg with $Subnet"
    Invoke-Az @('network', 'vnet', 'subnet', 'update', '-g', $ResourceGroup, '--vnet-name', $VNet, '-n', $Subnet, '--network-security-group', $nsg) | Out-Null
  }
  if (-not (Get-AzValue @('vm', 'show', '-g', $ResourceGroup, '-n', $VmName, '--query', 'id', '-o', 'tsv'))) {
    Say "creating $VmName ($VmSize) with vendor API at https://$fqdn"
    $app = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $here 'vendor-api/app.py')))
    $ci = (Get-Content (Join-Path $here 'vendor-api/cloud-init.yaml') -Raw).Replace('__FQDN__', $fqdn).Replace('__APP_B64__', $app)
    $ciFile = Join-Path ([IO.Path]::GetTempPath()) "agentmon-cloudinit-$([guid]::NewGuid()).yaml"
    Set-Content -Path $ciFile -Value $ci -Encoding ascii
    try {
      Invoke-Az @('network', 'public-ip', 'create', '-g', $ResourceGroup, '-n', $pip, '-l', $Location, '--sku', 'Standard',
        '--allocation-method', 'Static', '--dns-name', $label) | Out-Null
      # NIC without its own NSG: the subnet NSG above is the single place traffic policy lives.
      Invoke-Az @('network', 'nic', 'create', '-g', $ResourceGroup, '-n', "nic-$VmName", '-l', $Location, '--vnet-name', $VNet,
        '--subnet', $Subnet, '--public-ip-address', $pip) | Out-Null
      Invoke-Az @('vm', 'create', '-g', $ResourceGroup, '-n', $VmName, '-l', $Location, '--image', 'Ubuntu2404', '--size', $VmSize,
        '--nics', "nic-$VmName", '--admin-username', 'labadmin',
        '--generate-ssh-keys', '--custom-data', $ciFile, '--os-disk-size-gb', '30', '--storage-sku', 'StandardSSD_LRS',
        '--tags', 'purpose=agentmon-lab', 'component=vendor-api') | Out-Null
    } finally { Remove-Item $ciFile -ErrorAction SilentlyContinue }
  }
  Say "vendor API: https://$fqdn/openapi.json"
  return $fqdn
}

# ── foundry: tracing + access checks ────────────────────────────────────────────────────────────────────────────
function Step-Foundry {
  $url = "https://management.azure.com$FoundryAccountId/projects/$FoundryProject/connections?api-version=2025-06-01"
  $conns = (az rest --method get --url $url -o json | ConvertFrom-Json).value | Where-Object { $_.properties.category -eq 'AppInsights' }
  $appi = ($AppInsightsId -split '/')[-1]
  if ($conns | Where-Object { $_.properties.target -match [regex]::Escape($appi) }) { Say "project $FoundryProject traces to $appi" }
  else { Write-Warning "project $FoundryProject has no App Insights connection to $appi - connect it in Foundry > Agents > Traces" }
  $sp = az ad sp show --id $FleetAppId --query id -o tsv
  $roles = @(az role assignment list --assignee $sp --scope $FoundryAccountId --include-inherited --query "[].roleDefinitionName" -o tsv)
  if (-not ($roles | Where-Object { $_ -match 'Foundry User|Azure AI User|Cognitive Services OpenAI User' })) {
    Say 'granting Foundry User to the fleet SP on the Foundry account'
    Invoke-Az @('role', 'assignment', 'create', '--assignee-object-id', $sp, '--assignee-principal-type', 'ServicePrincipal',
      '--role', 'Foundry User', '--scope', $FoundryAccountId) | Out-Null
  } else { Say "fleet SP data-plane roles on Foundry account: $($roles -join ', ')" }
}

# ── dataverse: least-privilege app user for the fleet ───────────────────────────────────────────────────────────
function Invoke-Dv([string]$method, [string]$path, $body = $null) {
  $tok = az account get-access-token --resource $DataverseUrl --query accessToken -o tsv
  $h = @{ Authorization = "Bearer $tok"; Accept = 'application/json'; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0'; Prefer = 'return=representation' }
  $uri = "$DataverseUrl/api/data/v9.2/$path"
  if ($WhatIf -and $method -ne 'GET') { Say "WHATIF $method $path"; return $null }
  if ($null -ne $body) { return Invoke-RestMethod -Method $method -Uri $uri -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8) }
  return Invoke-RestMethod -Method $method -Uri $uri -Headers $h
}

function Step-Dataverse {
  $roleName = 'AgentMon Fleet Reader'
  $bu = (Invoke-Dv GET "businessunits?`$select=businessunitid&`$filter=_parentbusinessunitid_value eq null").value[0].businessunitid
  $role = (Invoke-Dv GET "roles?`$select=roleid,name&`$filter=name eq '$roleName' and _businessunitid_value eq $bu").value | Select-Object -First 1
  if (-not $role) {
    Say "creating role '$roleName'"
    $role = Invoke-Dv POST 'roles' @{ name = $roleName; 'businessunitid@odata.bind' = "/businessunits($bu)" }
  }
  if ($role) {
    $wanted = @('prvReadbot', 'prvReadbotcomponent', 'prvReadconversationtranscript', 'prvReadAuditSummary', 'prvReadAuditPartitions')
    $privs = @()
    foreach ($p in $wanted) {
      $row = (Invoke-Dv GET "privileges?`$select=privilegeid,name&`$filter=name eq '$p'").value | Select-Object -First 1
      if ($row) { $privs += @{ PrivilegeId = $row.privilegeid; Depth = 'Global' } } else { Write-Warning "privilege $p not found" }
    }
    if ($privs.Count) {
      Say "granting $($privs.Count) read privileges (organization depth) to '$roleName'"
      Invoke-Dv POST "roles($($role.roleid))/Microsoft.Dynamics.CRM.AddPrivilegesRole" @{ Privileges = $privs } | Out-Null
    }
  }
  $user = (Invoke-Dv GET "systemusers?`$select=systemuserid,applicationid&`$filter=applicationid eq $FleetAppId").value | Select-Object -First 1
  if (-not $user) {
    Say "creating application user for fleet app $FleetAppId"
    $user = Invoke-Dv POST 'systemusers' @{ applicationid = $FleetAppId; 'businessunitid@odata.bind' = "/businessunits($bu)" }
  }
  if ($user -and $role) {
    $has = (Invoke-Dv GET "systemusers($($user.systemuserid))/systemuserroles_association?`$select=roleid&`$filter=roleid eq $($role.roleid)").value
    if (-not $has) {
      Say "assigning '$roleName' to the fleet application user"
      Invoke-Dv POST "systemusers($($user.systemuserid))/systemuserroles_association/`$ref" @{ '@odata.id' = "$DataverseUrl/api/data/v9.2/roles($($role.roleid))" } | Out-Null
    }
  }
  foreach ($t in @('bot', 'botcomponent')) {
    $md = Invoke-Dv GET "EntityDefinitions(LogicalName='$t')"
    if ($md.IsAuditEnabled.Value) { continue }
    if (-not $md.IsAuditEnabled.CanBeChanged -or -not $md.IsCustomizable.Value) {
      # Platform-managed Copilot Studio tables: authoring changes are audited in Purview (BotCreate, BotUpdateOperation-*,
      # BotComponent*) instead; the fleet also detects definition drift itself (AGENT_CONFIG_CHANGE).
      Say "table $t does not allow Dataverse auditing (platform-managed) - use Purview audit + fleet drift detection"
      continue
    }
    Say "enabling auditing on table $t"
    if (-not $WhatIf) {
      # EntityMetadata updates must PUT the full definition (partial bodies are rejected) and then be published.
      $md.IsAuditEnabled.Value = $true
      $md.PSObject.Properties.Remove('@odata.context')
      $tok = az account get-access-token --resource $DataverseUrl --query accessToken -o tsv
      $h = @{ Authorization = "Bearer $tok"; 'MSCRM.MergeLabels' = 'true'; 'OData-MaxVersion' = '4.0'; 'OData-Version' = '4.0' }
      Invoke-RestMethod -Method PUT -Uri "$DataverseUrl/api/data/v9.2/EntityDefinitions($($md.MetadataId))" -Headers $h `
        -ContentType 'application/json' -Body ($md | ConvertTo-Json -Depth 20) | Out-Null
      Invoke-Dv POST 'PublishXml' @{ ParameterXml = "<importexportxml><entities><entity>$t</entity></entities></importexportxml>" } | Out-Null
    }
  }
  Say "dataverse: fleet app user + '$roleName' ready (transcripts are written only for non-test-pane conversations)"
}

# ── diagnostics coverage ────────────────────────────────────────────────────────────────────────────────────────
function Step-Diagnostics {
  $script = Join-Path $here 'enable-ai-diagnostics.ps1'
  if ($ApplyDiagnostics) { & $script -SubscriptionId $SubscriptionId }
  else { Say 'coverage report (read-only; pass -ApplyDiagnostics to fix)'; & $script -SubscriptionId $SubscriptionId -WhatIf }
}

$results = @{}
foreach ($s in $Steps) {
  Say "== $s"
  switch ($s) {
    'network' { $results.vendorApi = Step-Network }
    'foundry' { Step-Foundry }
    'dataverse' { Step-Dataverse }
    'diagnostics' { Step-Diagnostics }
  }
}
$results
