# Passaver native messaging host.
#
# Binds the vault to THIS device: a random 256-bit vault key is wrapped twice
# with Windows DPAPI (LocalMachine scope, then CurrentUser scope) plus entropy
# derived from the machine GUID and the user's SID. The wrapped key can only be
# unwrapped by the same Windows user on the same Windows installation, so a
# copied vault + key file is useless anywhere else.
#
# The vault itself is encrypted by the extension (AES-256-GCM, WebCrypto); this
# host only stores ciphertext and hands the key to the extension over the local
# stdio pipe that the browser opens.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$Version   = '1.0.0'
$DataDir   = if ($env:PASSAVER_DATA_DIR) { $env:PASSAVER_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Passaver\data' }
$KeyFile   = Join-Path $DataDir 'device.key'
$VaultFile = Join-Path $DataDir 'vault.bin'
$BackupFile = Join-Path $DataDir 'vault.bak'

$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Get-MachineGuid {
    $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    try {
        $k = $hklm.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
        $guid = $k.GetValue('MachineGuid')
        if (-not $guid) { throw 'MachineGuid not found' }
        return [string]$guid
    } finally { $hklm.Dispose() }
}

function Get-Entropy {
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $seed = "Passaver/device-binding/v1|$(Get-MachineGuid)|$sid"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ,$sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($seed)) } finally { $sha.Dispose() }
}

function Protect-DeviceKey([byte[]]$raw) {
    $e = Get-Entropy
    $machine = [Security.Cryptography.ProtectedData]::Protect($raw, $e, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return ,[Security.Cryptography.ProtectedData]::Protect($machine, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Unprotect-DeviceKey([byte[]]$blob) {
    $e = Get-Entropy
    $machine = [Security.Cryptography.ProtectedData]::Unprotect($blob, $e, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return ,[Security.Cryptography.ProtectedData]::Unprotect($machine, $e, [Security.Cryptography.DataProtectionScope]::LocalMachine)
}

function Get-Revision {
    if (-not (Test-Path -LiteralPath $VaultFile)) { return '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [IO.File]::ReadAllBytes($VaultFile)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Read-Vault {
    if (-not (Test-Path -LiteralPath $VaultFile)) { return $null }
    return [Convert]::ToBase64String([IO.File]::ReadAllBytes($VaultFile))
}

function Get-DeviceKey {
    if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    if (Test-Path -LiteralPath $KeyFile) {
        try {
            return ,(Unprotect-DeviceKey ([IO.File]::ReadAllBytes($KeyFile)))
        } catch {
            # Never regenerate here: that would orphan the existing vault.
            throw 'DEVICE_MISMATCH: the vault key was created on a different device or Windows account and cannot be decrypted here.'
        }
    }
    if (Test-Path -LiteralPath $VaultFile) {
        throw 'KEY_MISSING: a vault exists but its device key is missing. Restore device.key or remove vault.bin to start fresh.'
    }
    $raw = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($raw) } finally { $rng.Dispose() }
    [IO.File]::WriteAllBytes($KeyFile, (Protect-DeviceKey $raw))
    return ,$raw
}

function Save-Vault([string]$b64, [string]$baseRev) {
    $current = Get-Revision
    if ($null -ne $baseRev -and $baseRev -ne $current) {
        return @{ ok = $false; conflict = $true; rev = $current }
    }
    $bytes = [Convert]::FromBase64String($b64)
    if ($bytes.Length -lt 32) { throw 'Refusing to write an invalid vault.' }
    $tmp = "$VaultFile.tmp"
    [IO.File]::WriteAllBytes($tmp, $bytes)
    if (Test-Path -LiteralPath $VaultFile) {
        [IO.File]::Replace($tmp, $VaultFile, $BackupFile)
    } else {
        [IO.File]::Move($tmp, $VaultFile)
    }
    return @{ ok = $true; rev = (Get-Revision) }
}

function Invoke-HostCommand([object]$msg) {
    switch ([string]$msg.cmd) {
        'ping' {
            return @{ ok = $true; version = $Version; device = $env:COMPUTERNAME; hasVault = (Test-Path -LiteralPath $VaultFile) }
        }
        'unlock' {
            $key = Get-DeviceKey
            return @{ ok = $true; version = $Version; device = $env:COMPUTERNAME; key = [Convert]::ToBase64String($key); vault = (Read-Vault); rev = (Get-Revision) }
        }
        'load' {
            return @{ ok = $true; vault = (Read-Vault); rev = (Get-Revision) }
        }
        'save' {
            if (-not $msg.vault) { throw 'Missing vault payload.' }
            return Save-Vault ([string]$msg.vault) $msg.baseRev
        }
        default { throw "Unknown command: $($msg.cmd)" }
    }
}

function Read-Exact([int]$count) {
    $buf = New-Object byte[] $count
    $offset = 0
    while ($offset -lt $count) {
        $n = $stdin.Read($buf, $offset, $count - $offset)
        if ($n -le 0) { return $null }
        $offset += $n
    }
    return ,$buf
}

function Send-Message([hashtable]$obj) {
    $json = ConvertTo-Json -InputObject $obj -Compress -Depth 5
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

while ($true) {
    $header = Read-Exact 4
    if ($null -eq $header) { break }
    $len = [BitConverter]::ToInt32($header, 0)
    if ($len -le 0 -or $len -gt 64MB) { break }
    $body = Read-Exact $len
    if ($null -eq $body) { break }
    try {
        $msg = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
        $reply = Invoke-HostCommand $msg
    } catch {
        $text = $_.Exception.Message
        $code = if ($text -match '^([A-Z_]+):') { $Matches[1] } else { 'HOST_ERROR' }
        $reply = @{ ok = $false; code = $code; error = $text }
    }
    Send-Message $reply
}
