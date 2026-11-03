# Removes the Passaver native host registration.
# Your encrypted vault in %LOCALAPPDATA%\Passaver\data is kept unless -DeleteVault is given.

param([switch]$DeleteVault)

$ErrorActionPreference = 'Stop'
$HostName = 'com.passaver.host'
$roots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts'
)
foreach ($root in $roots) {
    $key = Join-Path $root $HostName
    if (Test-Path $key) { Remove-Item -Path $key -Force }
}
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Passaver\host') -Recurse -Force -ErrorAction SilentlyContinue

if ($DeleteVault) {
    Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'Passaver\data') -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Vault deleted.' -ForegroundColor Yellow
} else {
    Write-Host 'Host removed. Vault kept in' (Join-Path $env:LOCALAPPDATA 'Passaver\data')
}
