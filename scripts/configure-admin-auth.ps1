<#
.SYNOPSIS
  Creates (or updates) the Entra ID app registration for the Demo Center admin portal,
  adds Admin / Editor app roles, assigns you the Admin role, and switches on sign-in
  for the admin web app.

.DESCRIPTION
  Run once after "Deploy to Azure". Needs the Azure CLI (az login) and permission to
  create app registrations in the tenant (Application Developer role or higher), plus
  Contributor on the resource group.

.EXAMPLE
  ./scripts/configure-admin-auth.ps1 -ResourceGroup rg-demo-center
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [string] $AdminAppName,
  [string] $DisplayName = 'Tungsten Demo Center Admin'
)
$ErrorActionPreference = 'Stop'

function Invoke-Az { param([string[]] $AzArgs)
  $out = & az @AzArgs
  if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed" }
  return $out
}

$tenantId = (Invoke-Az @('account', 'show', '--query', 'tenantId', '-o', 'tsv')).Trim()
if (-not $AdminAppName) {
  $AdminAppName = (Invoke-Az @('webapp', 'list', '-g', $ResourceGroup, '--query', "[?contains(name, '-admin-')].name | [0]", '-o', 'tsv')).Trim()
  if (-not $AdminAppName) { throw "No admin web app found in $ResourceGroup" }
}
$hostName = (Invoke-Az @('webapp', 'show', '-g', $ResourceGroup, '-n', $AdminAppName, '--query', 'defaultHostName', '-o', 'tsv')).Trim()
$redirect = "https://$hostName/.auth/login/aad/callback"
Write-Host "Admin portal: https://$hostName"

# ---- App registration ----
$appId = (Invoke-Az @('ad', 'app', 'list', '--display-name', $DisplayName, '--query', '[0].appId', '-o', 'tsv'))
if ($appId) { $appId = $appId.Trim() }
$rolesFile = New-TemporaryFile
$existingRoles = @()
if ($appId) { $existingRoles = Invoke-Az @('ad', 'app', 'show', '--id', $appId, '--query', 'appRoles') | ConvertFrom-Json }
$roles = foreach ($r in @(
    @{ value = 'Admin'; displayName = 'Admin'; description = 'Full access, including subscribers, form submissions and deletion.' },
    @{ value = 'Editor'; displayName = 'Editor'; description = 'Create and edit videos, uploads and lists.' })) {
  $id = ($existingRoles | Where-Object { $_.value -eq $r.value } | Select-Object -First 1).id
  if (-not $id) { $id = [guid]::NewGuid().ToString() }
  [ordered]@{ allowedMemberTypes = @('User'); description = $r.description; displayName = $r.displayName; id = $id; isEnabled = $true; value = $r.value }
}
ConvertTo-Json -InputObject @($roles) -Depth 5 | Set-Content -Path $rolesFile -Encoding utf8

if (-not $appId) {
  Write-Host "Creating app registration '$DisplayName'..."
  $appId = (Invoke-Az @('ad', 'app', 'create', '--display-name', $DisplayName, '--sign-in-audience', 'AzureADMyOrg',
      '--web-redirect-uris', $redirect, '--enable-id-token-issuance', 'true', '--app-roles', "@$rolesFile",
      '--query', 'appId', '-o', 'tsv')).Trim()
} else {
  Write-Host "Updating existing app registration $appId..."
  Invoke-Az @('ad', 'app', 'update', '--id', $appId, '--web-redirect-uris', $redirect, '--enable-id-token-issuance', 'true', '--app-roles', "@$rolesFile") | Out-Null
}
Remove-Item $rolesFile -Force

# ---- Enterprise app: require role assignment so only assigned users can sign in ----
$spId = (Invoke-Az @('ad', 'sp', 'list', '--filter', "appId eq '$appId'", '--query', '[0].id', '-o', 'tsv'))
if (-not $spId) { $spId = (Invoke-Az @('ad', 'sp', 'create', '--id', $appId, '--query', 'id', '-o', 'tsv')) }
$spId = $spId.Trim()
Invoke-Az @('ad', 'sp', 'update', '--id', $spId, '--set', 'appRoleAssignmentRequired=true') | Out-Null

# ---- Assign the signed-in user the Admin role ----
$me = (Invoke-Az @('ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv')).Trim()
$adminRoleId = ((Invoke-Az @('ad', 'app', 'show', '--id', $appId, '--query', 'appRoles') | ConvertFrom-Json) | Where-Object { $_.value -eq 'Admin' }).id
$assigned = Invoke-Az @('rest', '--method', 'GET', '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo") | ConvertFrom-Json
if (-not ($assigned.value | Where-Object { $_.principalId -eq $me -and $_.appRoleId -eq $adminRoleId })) {
  $body = New-TemporaryFile
  @{ principalId = $me; resourceId = $spId; appRoleId = $adminRoleId } | ConvertTo-Json | Set-Content $body -Encoding utf8
  Invoke-Az @('rest', '--method', 'POST', '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignedTo", '--body', "@$body", '--headers', 'Content-Type=application/json') | Out-Null
  Remove-Item $body -Force
  Write-Host 'Assigned you the Admin role.'
}

# ---- Turn on Entra sign-in for the admin web app ----
Invoke-Az @('webapp', 'auth', 'microsoft', 'update', '-g', $ResourceGroup, '-n', $AdminAppName,
    '--client-id', $appId, '--issuer', "https://login.microsoftonline.com/$tenantId/v2.0",
    '--allowed-audiences', $appId, "api://$appId", '--yes') | Out-Null
Invoke-Az @('webapp', 'auth', 'update', '-g', $ResourceGroup, '-n', $AdminAppName,
    '--enabled', 'true', '--action', 'RedirectToLoginPage', '--redirect-provider', 'azureactivedirectory') | Out-Null

Write-Host ''
Write-Host "Done. Client ID: $appId"
Write-Host "Sign in at https://$hostName (it can take a minute to apply)."
Write-Host 'Give colleagues access in Entra ID > Enterprise applications > Users and groups (Admin or Editor role).'
Write-Host "Tip: pass -p entraClientId=$appId on future deployments so redeploys keep sign-in enabled."
