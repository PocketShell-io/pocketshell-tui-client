param([string]$SshPath = "$env:SystemRoot\System32\OpenSSH\ssh.exe")
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-PlainPath([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\s%"<>|?*]' -or $Path.Substring(2).Contains(':')) {
        throw "PSC requires a local absolute path without spaces or shell characters: $Path"
    }
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "PSC refuses redirected paths: $cursor" }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
function Protect-Item([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "PSC refuses links: $Path" }
    if ($item.PSIsContainer) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($owner, $system)) {
        # No inheritance flags: the helper requires explicit ACEs on private objects.
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$manifest = Get-Content -LiteralPath "$PSScriptRoot\package-manifest.json" -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid PSC package version' }
$base = "$env:LOCALAPPDATA\PocketShell\psc"
$dest = "$base\$($manifest.version)"
$bin = "$base\bin"
foreach ($p in @($env:USERPROFILE, $env:LOCALAPPDATA, $base, $dest, $bin, $SshPath, $env:SystemRoot, $env:ProgramData)) { Assert-PlainPath $p }
if (!(Test-Path -LiteralPath $SshPath -PathType Leaf) -or (Split-Path -Leaf $SshPath) -ine 'ssh.exe') {
    throw 'Win32 OpenSSH ssh.exe is required; install the Windows OpenSSH Client feature first.'
}
$sshSource = $SshPath
$SshPath = "$dest\ssh.exe"
$fresh = !(Test-Path -LiteralPath $dest)
# Verify the entire offline payload before publishing it.
$expected = @($manifest.files.PSObject.Properties.Name) | Sort-Object
$actual = @(Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File | ForEach-Object {
    $_.FullName.Substring($PSScriptRoot.Length + 1).Replace('\', '/')
} | Where-Object { $_ -ne 'package-manifest.json' }) | Sort-Object
if (Compare-Object $expected $actual) { throw 'PSC package file inventory differs' }
foreach ($row in $manifest.files.PSObject.Properties) {
    if ($row.Name -match '(^/|(^|/)\.\.(/|$)|:|\\)') { throw 'Unsafe package member' }
    if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $row.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $row.Value) {
        throw "PSC payload hash differs: $($row.Name)"
    }
}
New-Item -ItemType Directory -Path $base -Force | Out-Null
if ($fresh) {
    New-Item -ItemType Directory -Path $dest | Out-Null
    Protect-Item $dest
} else {
    # Reinstalling the identical package is read-only for the version tree.
    $installedNames = @($expected | Where-Object { $_ -ne 'install.ps1' }) + 'psc/dist/windows-bindings.json' + 'ssh.exe'
    $installedActual = @(Get-ChildItem -LiteralPath $dest -Recurse -File | ForEach-Object {
        $_.FullName.Substring($dest.Length + 1).Replace('\', '/')
    } | Where-Object { $_ -ne 'package-manifest.json' })
    if (Compare-Object ($installedNames | Sort-Object) ($installedActual | Sort-Object)) { throw 'Existing PSC version inventory differs; use a fresh version' }
    foreach ($row in $manifest.files.PSObject.Properties) {
        if ($row.Name -eq 'install.ps1') { continue }
        if ((Get-FileHash -LiteralPath (Join-Path $dest $row.Name)).Hash.ToLowerInvariant() -ne $row.Value) {
            throw "Existing PSC version differs: $($row.Name); use a fresh version"
        }
    }
}
try {
    if ($fresh) {
    Copy-Item -LiteralPath "$PSScriptRoot\node.exe", "$PSScriptRoot\psc-security.exe", "$PSScriptRoot\psc.cmd", "$PSScriptRoot\NODE-LICENSE.txt", "$PSScriptRoot\package-manifest.json" -Destination $dest
    Copy-Item -LiteralPath "$PSScriptRoot\psc" -Destination $dest -Recurse
    # Inbox Windows files can be hardlinked or carry ACLs rejected by the helper.
    # Copy only the client, verify Microsoft's signature on the actual copy,
    # then give it the same protected descriptor as the rest of this version.
    Copy-Item -LiteralPath $sshSource -Destination $SshPath
    $signature = Get-AuthenticodeSignature -LiteralPath $SshPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
        throw 'PSC requires a valid Microsoft-signed Win32 OpenSSH client'
    }
    Get-ChildItem -LiteralPath $dest -Recurse -Force | ForEach-Object { Protect-Item $_.FullName }
    }
    $helper = "$dest\psc-security.exe"
    $node = "$dest\node.exe"
    $entry = "$dest\psc\dist\cli.js"
    $bindings = [ordered]@{
        version = 2; sshFamily = 'win32-openssh'
        helper = $helper; helperSha256 = (Get-FileHash $helper).Hash.ToLowerInvariant()
        ssh = $SshPath; sshSha256 = (Get-FileHash $SshPath).Hash.ToLowerInvariant()
        node = $node; nodeSha256 = (Get-FileHash $node).Hash.ToLowerInvariant()
        entry = $entry; entrySha256 = (Get-FileHash $entry).Hash.ToLowerInvariant()
        systemRoot = $env:SystemRoot; systemDrive = $env:SystemDrive; programData = $env:ProgramData
    }
    $bindingPath = "$dest\psc\dist\windows-bindings.json"
    if ($fresh) {
        [IO.File]::WriteAllText($bindingPath, ($bindings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Protect-Item $bindingPath
    } else {
        $existing = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
        if (@($existing.PSObject.Properties).Count -ne 13) { throw 'Existing PSC binding schema differs' }
        foreach ($key in $bindings.Keys) {
            if ($existing.$key -cne $bindings[$key]) { throw "Existing PSC binding differs: $key; use a fresh version" }
        }
    }
    # Native preflight creates private state without changing existing state ACLs.
    foreach ($root in @("$env:LOCALAPPDATA\PocketShell\pocketshell-client", "$env:LOCALAPPDATA\PocketShell\pocketshell-client-account", "$env:LOCALAPPDATA\PocketShell\pocketshell-client-runtime")) {
        $reply = @{version=1; op='preflight'; root=$root} | ConvertTo-Json -Compress | & $helper
        if ($LASTEXITCODE -ne 0 -or !(($reply | ConvertFrom-Json).ok)) { throw "PSC protected state preflight refused: $root" }
    }
    foreach ($path in @($node, $entry, $SshPath)) {
        $reply = @{version=1; op='check-executable'; root=$dest; path=$path} | ConvertTo-Json -Compress | & $helper
        if ($LASTEXITCODE -ne 0 -or !(($reply | ConvertFrom-Json).ok)) { throw "PSC executable preflight refused: $path" }
    }
    & $node $entry --version
    if ($LASTEXITCODE -ne 0) { throw 'PSC installed version check failed' }
    & $node $entry hosts
    if ($LASTEXITCODE -ne 0) { throw 'PSC installed hosts check failed' }
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    Protect-Item $bin
    $shim = "@echo off`r`ncall `"$dest\psc.cmd`" %*`r`nexit /b %errorlevel%`r`n"
    [IO.File]::WriteAllText("$bin\psc.cmd", $shim, [Text.UTF8Encoding]::new($false))
    Protect-Item "$bin\psc.cmd"
    $oldPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if ($bin -notin ($oldPath -split ';')) {
        [Environment]::SetEnvironmentVariable('Path', (($oldPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
    }
    $env:Path = "$bin;$env:Path"
    # Explorer refreshes its environment for subsequently opened terminals.
    if (!(('PscEnvironmentNotify' -as [type]))) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PscEnvironmentNotify {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg,
        UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $notification = [UIntPtr]::Zero
    [void][PscEnvironmentNotify]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$notification)
    Write-Host "PSC installed. Open a new terminal, then run psc login and psc hosts sync. Shim: $bin\psc.cmd"
} catch {
    if ($fresh) { Remove-Item -LiteralPath $dest -Recurse -Force }
    throw
}
