<#
.SYNOPSIS
  Creates (idempotently) the Entra app + federated identity credential that Copilot Studio uses to authenticate to the
  fleet's external threat-detection webhook, mirroring Microsoft's Create-CopilotWebhookApp.ps1 (single-tenant app,
  service principal, FIC with issuer login.microsoftonline.com/{tenant}/v2.0, audience api://AzureADTokenExchange and
  subject /eid1/c/pub/t/{b64 tenant}/a/m1WPnYRZpEaQKq1Cceg--g/{b64 endpoint}). Uses Microsoft Graph through `az rest`.

  The Endpoint must be the exact base URL entered in Power Platform admin center (Security > Threat detection), e.g.
  https://<tunnel>.devtunnels.ms/copilot-studio . If the endpoint changes, re-run: a FIC is added for the new endpoint.

.OUTPUTS
  App (client) ID — set FLEET_HOOKS_AUDIENCE / FLEET_HOOKS_ALLOWED_APP_IDS to it and paste it into PPAC.
#>
param(
  [Parameter(Mandatory)] [string]$Endpoint,
  [string]$TenantId = 'c8a8cdf0-9270-446b-9930-3d017bf24220',
  [string]$DisplayName = 'AgentMon Threat Detection (lab)',
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$graph = 'https://graph.microsoft.com/v1.0'
$Endpoint = $Endpoint.TrimEnd('/')

function Invoke-Graph([string]$method, [string]$url, $body = $null) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    if ($null -ne $body) {
      $tmp = New-TemporaryFile
      ($body | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding utf8
      $out = az rest --method $method --url $url --body "@$tmp" --headers 'Content-Type=application/json' --only-show-errors 2>&1
      Remove-Item $tmp
    } else { $out = az rest --method $method --url $url --only-show-errors 2>&1 }
  } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "Graph $method $url failed: $($out | Out-String)" }
  if ($out) { return ($out | Out-String | ConvertFrom-Json) }
}

$tenantB64 = [Convert]::ToBase64String([Guid]::Parse($TenantId).ToByteArray()).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$endpointB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Endpoint)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$subject = "/eid1/c/pub/t/$tenantB64/a/m1WPnYRZpEaQKq1Cceg--g/$endpointB64"

$app = (Invoke-Graph GET "$graph/applications?`$filter=displayName eq '$DisplayName'&`$select=id,appId,displayName").value | Select-Object -First 1
if (-not $app) {
  if ($WhatIf) { Write-Host "WHATIF create application '$DisplayName'"; return }
  $app = Invoke-Graph POST "$graph/applications" @{ displayName = $DisplayName; signInAudience = 'AzureADMyOrg'
    notes = 'Copilot Studio external threat detection -> agentmon fleet webhook (lab). Managed by infra/lab/create-webhook-app.ps1' }
  Write-Host "created application $($app.appId)"
}
$sp = (Invoke-Graph GET "$graph/servicePrincipals?`$filter=appId eq '$($app.appId)'&`$select=id").value | Select-Object -First 1
if (-not $sp -and -not $WhatIf) { $sp = Invoke-Graph POST "$graph/servicePrincipals" @{ appId = $app.appId }; Write-Host 'created service principal' }

$fics = (Invoke-Graph GET "$graph/applications/$($app.id)/federatedIdentityCredentials").value
if ($fics | Where-Object { $_.subject -eq $subject }) { Write-Host "FIC for $Endpoint already present" }
elseif ($WhatIf) { Write-Host "WHATIF add FIC for $Endpoint" }
else {
  $name = 'copilot-studio-' + ([Math]::Abs($Endpoint.GetHashCode())).ToString()
  Invoke-Graph POST "$graph/applications/$($app.id)/federatedIdentityCredentials" @{
    name = $name; issuer = "https://login.microsoftonline.com/$TenantId/v2.0"; subject = $subject
    audiences = @('api://AzureADTokenExchange'); description = "Copilot Studio threat detection webhook $Endpoint" } | Out-Null
  Write-Host "added FIC $name for $Endpoint"
}
[pscustomobject]@{ AppId = $app.appId; Endpoint = $Endpoint; Subject = $subject }
