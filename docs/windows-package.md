# Windows x64 package

The v0.3.1 release workflow builds `psc-windows-x64-0.3.1.zip` on Linux,
checks that exact zip on `windows-latest`, then attaches it and its SHA256 file
to the GitHub release when the release owner pushes the version tag.
The zip contains official Node 24.13.1, emitted PSC and pinned Core sources,
the locked commander/ws packages, the reviewed Windows PTY closure, and the
Go security helper. The Node archive SHA256 is pinned in the builder.

Run this in a regular, non-administrator PowerShell terminal after v0.3.1 is
released (use the corresponding version for later releases):

```powershell
$v='0.3.1'; $u="https://github.com/PocketShell-io/pocketshell-tui-client/releases/download/v$v"; $z="$env:TEMP\psc-windows-x64-$v.zip"; Invoke-WebRequest "$u/psc-windows-x64-$v.zip" -OutFile $z; Invoke-WebRequest "$u/psc-windows-x64-$v.zip.sha256" -OutFile "$z.sha256"; if ((Get-FileHash $z).Hash.ToLowerInvariant() -ne (Get-Content "$z.sha256").Split(' ')[0]) { throw 'PSC zip hash differs' }; $d="$env:TEMP\psc-install-$v"; Expand-Archive $z $d; & "$d\install.ps1"; & "$env:LOCALAPPDATA\PocketShell\psc\bin\psc.cmd" login; & "$env:LOCALAPPDATA\PocketShell\psc\bin\psc.cmd" hosts sync
```

Approve the device code using the URL printed by `psc login`. Windows stores
credentials with current-user DPAPI in the protected PSC account directory.
No Python credentials or existing account state are imported or overwritten.
Open a new terminal after installation to use `psc` through the user PATH.

For each synced gateway device, obtain its full public host key independently
by running `pocketshell gateway show --host-key` on that host, then pin it:

```powershell
psc gateway pin DEVICE_ID 'ssh-ed25519 FULL_PUBLIC_KEY_BASE64'
psc hosts
psc hetzner ls
psc hetzner connect
```

Replace the device ID, public key, and host alias with the real values.
`hosts sync` does not silently trust advertised keys. Pin each remote device,
including Windows devices, before connecting. `connect` attaches to the
remote default shell using Win32 OpenSSH.

Installation requires Windows x64 and the Windows OpenSSH Client feature
(`C:\Windows\System32\OpenSSH\ssh.exe`). If absent, the installer fails with
an explicit prerequisite message. An already installed reviewed Win32
OpenSSH may be selected with `install.ps1 -SshPath C:\plain\ssh.exe`.
The installed executable paths and user profile must contain no spaces;
redirected directories are refused. Profiles with spaces fail before copying.
Do not use short-path aliases or relax the helper ACL policy to bypass this.

The installer copies into `%LOCALAPPDATA%\PocketShell\psc\<version>`, protects
every copied directory/file with current user + SYSTEM ACLs, and generates the
13-field version-2 `psc\dist\windows-bindings.json` using absolute paths and
actual SHA256 hashes. Native preflight checks the helper, executable and state
ACLs before publishing `%LOCALAPPDATA%\PocketShell\psc\bin\psc.cmd` and
adding that directory to HKCU Environment PATH. State directories retain the
existing Windows PSC identity under `%LOCALAPPDATA%\PocketShell`.

Versions are immutable: installing the same version twice refuses. Upgrades
retain previous versions and switch only the shim; account, host and pin state
are preserved. To roll back, point `psc\bin\psc.cmd` at the retained version's
`psc.cmd`. To uninstall, remove the PSC bin entry from the user PATH and delete
only the version directories and bin shim. Keep the separate account/host
directories if you want to retain login and pins.

Build from a clean checkout with Node dependencies installed, Go from
`native/psc-security/go.mod`, and Core commit
`07174896ce7041370bcbf4f791ec513870b9535f` emitted next to the client:

```sh
python3 scripts/build-windows-package.py --go /usr/local/go/bin/go
```

The workflow runs installed `psc --version`, `psc hosts`, native protected
storage/DPAPI smoke checks, Windows boundary unit tests and Go tests. It does
not log in to real accounts or claim live connectivity to specific machines.
Those routes require the release owner's installation and host-key approval.
