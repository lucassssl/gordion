# Default is inspection/plan only. -Apply grants Application Mail.Read to ONE mailbox.
# Requires ExchangeOnlineManagement and Microsoft.Graph.Applications/Authentication.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$ClientId,
    [Parameter(Mandatory)][guid]$ServicePrincipalObjectId,
    [Parameter(Mandatory)][guid]$ControlMailboxObjectId,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$config = Get-Content (Join-Path $PSScriptRoot '../config/microsoft-365.json') -Raw | ConvertFrom-Json
if ([string]$ControlMailboxObjectId -eq $config.mailboxObjectId) { throw 'Control mailbox must differ from outreach mailbox.' }
Import-Module ExchangeOnlineManagement -ErrorAction Stop
Import-Module Microsoft.Graph.Applications -ErrorAction Stop
# This delegated Directory.Read.All is for the inspecting administrator, NOT the outreach app.
Connect-MgGraph -TenantId $config.tenantId -Scopes 'Directory.Read.All' -ContextScope Process -NoWelcome
try {
    $sp = Get-MgServicePrincipal -ServicePrincipalId $ServicePrincipalObjectId
    if ([string]$sp.AppId -ne [string]$ClientId) { throw 'Client ID does not match the Enterprise Application object ID.' }
    $grants = @(Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $ServicePrincipalObjectId -All)
    if ($grants.Count -gt 0) {
        throw 'Dedicated outreach application already has Entra application-role grants. Review them before RBAC; this script does not revoke existing grants.'
    }
    Connect-ExchangeOnline -UserPrincipalName $config.adminUserPrincipalName -ShowBanner:$false
    try {
        $connections = @(Get-ConnectionInformation)
        if ($connections.Count -ne 1 -or [string]$connections[0].TenantID -ne $config.tenantId) { throw 'Wrong or ambiguous Exchange tenant connection.' }
        $target = Get-EXOMailbox -ExternalDirectoryObjectId $config.mailboxObjectId
        $control = Get-EXOMailbox -ExternalDirectoryObjectId $ControlMailboxObjectId
        if (-not $target -or -not $control) { throw 'Both target and control must be existing mailboxes.' }
        $filter = "ExternalDirectoryObjectId -eq '$($config.mailboxObjectId)'"
        $scopeName = "Gordion-Outreach-$ClientId"
        $roleName = 'Application Mail.Read'
        $assignmentName = "Gordion-Outreach-Read-$ClientId"
        $members = @(Get-Recipient -Filter $filter)
        if ($members.Count -ne 1 -or [string]$members[0].ExternalDirectoryObjectId -ne $config.mailboxObjectId) {
            throw 'Scope must resolve to exactly the configured outreach mailbox.'
        }
        # Read current configuration before proposing changes; never silently widen an existing scope.
        $scope = Get-ManagementScope | Where-Object Name -eq $scopeName
        if ($scope -and ([string]$scope.RecipientFilter -ne $filter)) {
            throw 'Existing scope filter differs. Inspect it manually before reuse.'
        }
        $exchangeSp = Get-ServicePrincipal | Where-Object AppId -eq $ClientId
        if ($exchangeSp -and [string]$exchangeSp.ObjectId -ne [string]$ServicePrincipalObjectId) { throw 'Exchange principal mismatch.' }
        $assignments = @()
        if ($exchangeSp) { $assignments = @(Get-ManagementRoleAssignment -RoleAssignee $ServicePrincipalObjectId) }
        if ($assignments.Count -gt 0) {
            $assignments | Format-Table Name,Role,CustomResourceScope
            throw 'Existing Exchange role assignments require review. Nothing has been changed.'
        }
        Write-Host "Proposed: $roleName on $($target.PrimarySmtpAddress), filter $filter"
        Write-Host "Control mailbox: $($control.PrimarySmtpAddress). No Mail.Send or Mail.ReadWrite grant."
        if (-not $Apply) { Write-Host 'Plan only. No tenant changes made. Use -Apply to create the displayed read-only assignment.'; return }
        if (-not $exchangeSp) {
            $null = New-ServicePrincipal -AppId $ClientId -ObjectId $ServicePrincipalObjectId -DisplayName 'Gordion Outreach'
        }
        if (-not $scope) { $null = New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $filter }
        $null = New-ManagementRoleAssignment -Name $assignmentName -App $ServicePrincipalObjectId -Role $roleName -CustomResourceScope $scopeName
        $targetCheck = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $target.PrimarySmtpAddress)
        $controlCheck = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $control.PrimarySmtpAddress)
        if (-not ($targetCheck | Where-Object { $_.RoleName -eq $roleName -and $_.InScope -eq $true })) { throw 'Target mailbox is not in scope.' }
        if ($controlCheck | Where-Object InScope -eq $true) { throw 'Control mailbox unexpectedly in scope.' }
        Write-Host 'RBAC checks passed. Run the real Graph positive/negative probe after propagation (up to 2 hours).'
    } finally { Disconnect-ExchangeOnline -Confirm:$false }
} finally { Disconnect-MgGraph | Out-Null }
