# Requires ExchangeOnlineManagement. Read-only; exports metadata, never mail contents.
[CmdletBinding()]
param([string]$OutputPath = '.outreach-data/mailbox-evidence.json')
$ErrorActionPreference = 'Stop'
$config = Get-Content (Join-Path $PSScriptRoot '../config/microsoft-365.json') -Raw | ConvertFrom-Json
Import-Module ExchangeOnlineManagement -ErrorAction Stop
Connect-ExchangeOnline -UserPrincipalName $config.adminUserPrincipalName -ShowBanner:$false
try {
    $connections = @(Get-ConnectionInformation)
    if ($connections.Count -ne 1 -or [string]$connections[0].TenantID -ne $config.tenantId) {
        throw 'Connected Exchange tenant differs from the configured tenant.'
    }
    $mailboxes = @(Get-EXOMailbox -ExternalDirectoryObjectId $config.mailboxObjectId -Properties PrimarySmtpAddress,EmailAddresses,UserPrincipalName,RecipientTypeDetails,ExternalDirectoryObjectId)
    if ($mailboxes.Count -ne 1) { throw 'Expected exactly one mailbox for the supplied object ID.' }
    $mailbox = $mailboxes[0]
    if ([string]$mailbox.RecipientTypeDetails -ne 'UserMailbox') { throw 'Expected a user mailbox.' }
    $primary = ([string]$mailbox.PrimarySmtpAddress).ToLowerInvariant()
    if ($primary -notin $config.senderCandidates) { throw 'Exchange primary SMTP address matches neither supplied candidate. Review the mailbox identity.' }
    $addresses = @($mailbox.EmailAddresses | ForEach-Object { [string]$_ })
    foreach ($candidate in $config.senderCandidates) {
        $classification = if ($primary -eq $candidate) { 'PRIMARY' } elseif ("smtp:$candidate" -in $addresses) { 'ALIAS' } else { 'NOT ON THIS MAILBOX' }
        Write-Host "$candidate : $classification"
    }
    $evidence = [ordered]@{
        tenantId = [string]$connections[0].TenantID
        mailboxObjectId = [string]$mailbox.ExternalDirectoryObjectId
        primarySmtpAddress = $primary
        userPrincipalName = [string]$mailbox.UserPrincipalName
        emailAddresses = $addresses
        recipientTypeDetails = [string]$mailbox.RecipientTypeDetails
        checkedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    }
    $destination = [IO.Path]::GetFullPath($OutputPath)
    if (Test-Path $destination) { throw 'Output already exists. Archive it or choose a new OutputPath.' }
    $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination))
    $evidence | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 -Path $destination
    Write-Host "Exchange identity metadata exported to $destination"
    Write-Host 'Successful inspection proves read access for this administrator, not permission to assign application roles.'
} finally {
    Disconnect-ExchangeOnline -Confirm:$false
}
