# Installs the Passaver native host for the current Windows user (no admin needed)
# and registers it with Chrome, Edge, Brave and Chromium.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop

param(
    # Fixed by the "key" field in extension/manifest.json. Pass extra IDs if you
    # load the extension under a different ID (e.g. a store build).
    [string[]]$ExtensionId = @('ipgoiopgjfjbkmakfonhapkfagdmdipm')
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.passaver.host'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Passaver\host'

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'passaver_host.ps1'), (Join-Path $PSScriptRoot 'passaver_host.bat') -Destination $InstallDir -Force

$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = 'Passaver device-bound vault host'
    path            = (Join-Path $InstallDir 'passaver_host.bat')
    type            = 'stdio'
    allowed_origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content -Path $manifestPath -Encoding ASCII

$browsers = [ordered]@{
    'Google Chrome'  = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'Microsoft Edge' = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    'Brave'          = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    'Chromium'       = 'HKCU:\Software\Chromium\NativeMessagingHosts'
}
foreach ($name in $browsers.Keys) {
    $key = Join-Path $browsers[$name] $HostName
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
    Write-Host "  registered for $name"
}

Write-Host ''
Write-Host "Passaver host installed to $InstallDir" -ForegroundColor Green
Write-Host "Allowed extension ID(s): $($ExtensionId -join ', ')"
Write-Host 'Vault data will live in' (Join-Path $env:LOCALAPPDATA 'Passaver\data')
Write-Host 'Restart the browser (or reload the extension) to connect.'
