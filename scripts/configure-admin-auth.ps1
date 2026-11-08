<#
.SYNOPSIS
  Creates (or updates) the Entra ID app registration for the Demo Center admin portal,
  adds Administrator / Content Creator app roles, assigns you the Admin role, and switches on sign-in
  for the admin web app.

.DESCRIPTION
  Run once after "Deploy to Azure". Needs the Azure CLI (az login) and permission to
  create app registrations in the tenant (Application Developer role or higher), plus
  Contributor on the resource group.

  If the app registration should live in a different Entra tenant from the Azure
  subscription (for example a test tenant), pass -EntraTenant. The script signs you in
  to that tenant for the Entra steps, then switches back to the subscription.

.EXAMPLE
  ./scripts/configure-admin-auth.ps1 -ResourceGroup rg-demo-center

.EXAMPLE
  ./scripts/configure-admin-auth.ps1 -ResourceGroup tdc-test-weu -EntraTenant contoso.onmicrosoft.com
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [string] $AdminAppName,
  [string] $DisplayName = 'Tungsten Demo Center Admin',
  [string] $EntraTenant
)
$ErrorActionPreference = 'Stop'

function Invoke-Az { param([string[]] $AzArgs)
  $out = & az @AzArgs
  if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed" }
  return $out
}

$subscriptionId = (Invoke-Az @('account', 'show', '--query', 'id', '-o', 'tsv')).Trim()
if (-not $AdminAppName) {
  $AdminAppName = (Invoke-Az @('webapp', 'list', '-g', $ResourceGroup, '--query', "[?contains(name, '-admin-')].name | [0]", '-o', 'tsv')).Trim()
  if (-not $AdminAppName) { throw "No admin web app found in $ResourceGroup" }
}
$hostName = (Invoke-Az @('webapp', 'show', '-g', $ResourceGroup, '-n', $AdminAppName, '--query', 'defaultHostName', '-o', 'tsv')).Trim()
$redirect = "https://$hostName/.auth/login/aad/callback"
Write-Host "Admin portal: https://$hostName"

if ($EntraTenant) {
  Write-Host "Sign in to the Entra tenant '$EntraTenant' (a browser window opens)..."
  Invoke-Az @('login', '--tenant', $EntraTenant, '--allow-no-subscriptions', '--only-show-errors', '-o', 'none') | Out-Null
}
$tenantId = (Invoke-Az @('account', 'show', '--query', 'tenantId', '-o', 'tsv')).Trim()
Write-Host "App registration tenant: $tenantId"

# ---- App registration ----
$appId = (Invoke-Az @('ad', 'app', 'list', '--display-name', $DisplayName, '--query', '[0].appId', '-o', 'tsv'))
if ($appId) { $appId = $appId.Trim() }
$rolesFile = New-TemporaryFile
$existingRoles = @()
if ($appId) { $existingRoles = Invoke-Az @('ad', 'app', 'show', '--id', $appId, '--query', 'appRoles') | ConvertFrom-Json }
# Approvers are maintained inside the admin portal (Approvers page), so Entra only needs these two roles.
$wanted = @(
    @{ value = 'Admin'; displayName = 'Administrator'; description = 'Platform owner: everything, including the approver list, subscribers, form submissions and deletion.' },
    @{ value = 'Creator'; displayName = 'Content Creator'; description = 'Add and edit videos and submit them for approval.' })
$roles = @(foreach ($r in $wanted) {
  $id = ($existingRoles | Where-Object { $_.value -eq $r.value } | Select-Object -First 1).id
  if (-not $id) { $id = [guid]::NewGuid().ToString() }
  [ordered]@{ allowedMemberTypes = @('User'); description = $r.description; displayName = $r.displayName; id = $id; isEnabled = $true; value = $r.value }
})
# Keep any other existing roles (for example the older "Editor", which the portal treats as Content Creator):
# Entra refuses to drop a role that is still enabled or assigned.
foreach ($e in @($existingRoles)) {
  if ($e -and -not ($wanted.value -contains $e.value)) {
    $roles += [ordered]@{ allowedMemberTypes = @($e.allowedMemberTypes); description = $e.description; displayName = $e.displayName; id = $e.id; isEnabled = $e.isEnabled; value = $e.value }
  }
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
# Without this tag the portal's Enterprise applications list hides the app (its default filter), so admins can't find it to assign users.
$tagBody = New-TemporaryFile
'{"tags":["WindowsAzureActiveDirectoryIntegratedApp"]}' | Set-Content $tagBody -Encoding ascii
Invoke-Az @('rest', '--method', 'PATCH', '--url', "https://graph.microsoft.com/v1.0/servicePrincipals/$spId", '--body', "@$tagBody", '--headers', 'Content-Type=application/json') | Out-Null
Remove-Item $tagBody -Force

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
if ($EntraTenant) {
  try { Invoke-Az @('account', 'set', '--subscription', $subscriptionId) | Out-Null }
  catch {
    Write-Host 'Sign in again to the tenant that holds the subscription...'
    Invoke-Az @('login', '--only-show-errors', '-o', 'none') | Out-Null
    Invoke-Az @('account', 'set', '--subscription', $subscriptionId) | Out-Null
  }
}
# Edits authsettingsV2 through the ARM API directly, so no Azure CLI extension download is needed
# (extension installs fail on networks that filter PyPI / package hosts).
$authUrl = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Web/sites/$AdminAppName/config/authsettingsV2?api-version=2023-12-01"
$auth = Invoke-Az @('rest', '--method', 'GET', '--url', $authUrl) | ConvertFrom-Json
$p = $auth.properties
$p.platform.enabled = $true
$p.globalValidation.requireAuthentication = $true
$p.globalValidation.unauthenticatedClientAction = 'RedirectToLoginPage'
$p.globalValidation | Add-Member -Force -NotePropertyName redirectToProvider -NotePropertyValue 'azureactivedirectory'
$aad = [ordered]@{
  enabled      = $true
  registration = [ordered]@{ openIdIssuer = "https://login.microsoftonline.com/$tenantId/v2.0"; clientId = $appId }
  validation   = [ordered]@{ allowedAudiences = @($appId, "api://$appId") }
}
if (-not $p.identityProviders) { $p | Add-Member -Force -NotePropertyName identityProviders -NotePropertyValue ([pscustomobject]@{}) }
$p.identityProviders | Add-Member -Force -NotePropertyName azureActiveDirectory -NotePropertyValue $aad
$authBody = New-TemporaryFile
@{ properties = $p } | ConvertTo-Json -Depth 20 | Set-Content $authBody -Encoding utf8
Invoke-Az @('rest', '--method', 'PUT', '--url', $authUrl, '--body', "@$authBody", '--headers', 'Content-Type=application/json') | Out-Null
Remove-Item $authBody -Force
# The site keeps the previous auth mode until it restarts.
Invoke-Az @('webapp', 'restart', '-g', $ResourceGroup, '-n', $AdminAppName) | Out-Null

Write-Host ''
Write-Host "Done. Client ID: $appId"
Write-Host "Sign in at https://$hostName (it can take a minute to apply)."
Write-Host 'Give colleagues access in Entra ID > Enterprise applications > Users and groups (Administrator or Content Creator role).'
Write-Host 'Then add approvers on the Approvers page of the admin portal.'
Write-Host "Tip: pass -p entraClientId=$appId entraTenantId=$tenantId on future deployments so redeploys keep sign-in enabled."
