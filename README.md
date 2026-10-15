# pocketshell-tui-client

PocketShell in the terminal. It's the same client as the desktop, web and
Android apps (hosts → workspaces → agent sessions), for machines and moments
where all you have is a terminal: an SSH session on a remote box, a headless
server, or a tmux pane next to your editor.

It is the **client** side. The `pocketshell` Python CLI
([pocketshell-cli](https://github.com/PocketShell-io/pocketshell-cli)) is the
host-side helper this client talks to; the two share the login and the
gateway pins, so you log in once.

Built on [`@pocketshell/core`](../pocketshell-core): the host CLI contract
(`HostCliCore`), session parsing and the command builders are the same code
the other clients run.

```bash
npm install && npm run build
npm link                   # puts `pocketshell-tui-client` and `psc` on PATH
psc                        # interactive UI
psc sessions list --json   # the same data, for scripts and agents
```

## Connection modes

| Mode | Use it when | How it connects |
| --- | --- | --- |
| `local` | PocketShell runs on this machine | Runs the host CLI directly. No SSH. Built in as the host named `local`. |
| `ssh` | The host accepts SSH | Your system OpenSSH, so `~/.ssh/config`, agents, ProxyJump and known_hosts all apply. Connections are multiplexed (ControlMaster), so repeat calls are fast. |
| `gateway` | The host has no inbound SSH (laptop behind NAT) | OpenSSH through the PocketShell gateway tunnel. Needs `psc login` and a pinned host key. |

```bash
psc hosts add box --ssh box.example.com -l alexey --default
psc hosts add laptop --gateway home-lab -l alexey
psc login                          # device flow, once per machine (shared with `pocketshell login`)
psc gateway pin home-lab           # paste the line from `pocketshell gateway show --host-key` on the host
psc hosts check laptop
```

## Commands

Every command takes `-H/--host NAME` (default: the default host, else `local`)
and `--json`.

```text
psc                                   interactive UI (same as `psc tui`)
psc a ...                             remote aplexer command family (see below)
psc hosts list|add|alias|sync|remove|default|check
psc sessions list                     sessions on the host
psc sessions create NAME [-C DIR] [-e ENGINE] [--profile P] [--attach]
psc sessions send SESSION [TEXT] [--enter]   type into a session (stdin when TEXT is - or omitted)
psc sessions capture SESSION [--raw [--bytes N]] [--wait-for REGEX [--timeout S]]
psc sessions attach SESSION           take over the terminal (Ctrl-b d detaches); also `psc attach`
psc sessions kill SESSION [--if-exists]
psc sessions warnings | ack [SESSION]
psc workspaces list|add|remove
psc engines | profiles
psc exec [-t SECONDS] -- COMMAND...   run a command on the host
psc login | logout | whoami           PocketShell account (device flow)
psc gateway devices|pin|unpin         gateway hosts and their pinned keys
```

## Credentials

`psc login` is an [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)-style
device login: it prints a short code and a URL, you approve the code in a
browser on a machine you trust, and the CLI polls until you confirm. The device
flow is the only issuance path: an existing token cannot be imported (there is
no `--token-stdin`, and no token environment variable).

The session is stored in
`${XDG_CONFIG_HOME:-~/.config}/pocketshell/credentials.json`, mode `0600`
inside a `0700` directory, and every write replaces the file atomically (temp
file + rename). On POSIX it is shared with the Python `pocketshell` CLI. A
session expires after 30 days, or after 14 days without use; `psc logout`
revokes it, and every session can be listed and revoked from the web
(`psc whoami` prints the URL).

## Key vault (`psc vault`)

SSH keys and host passwords are uploaded once on the web
(https://app.pocketshell.io/keys) into your account's end-to-end encrypted
key vault, unlocked by one account vault passphrase. psc only reads it: the
server never sees the passphrase or a plaintext key, and psc never writes a
private key to disk.

```bash
psc vault unlock                 # no-echo passphrase prompt
psc vault unlock --remember      # also keep the vault key in the OS keychain
psc vault status [--json]        # locked/unlocked, keys, which hosts use them (no secrets)
psc vault lock                   # wipe it here and forget the remembered key
psc vault bind <host> --alias <account-host> | --key <name|keyId> | --clear
```

- **Connect.** A saved host whose account host (same name, same gateway
  device, or a unique `user@host:port` match in your synced host list) is
  bound to a vault key connects with that key: psc decrypts it into memory,
  serves it to OpenSSH from an in-process ssh-agent on a private 0700 socket,
  and writes only the public key next to it. Vault passwords use an
  `SSH_ASKPASS` helper on the same private socket (ssh mode only; gateway
  connections are key-only). Gateway policy `host`, or no binding, keeps the
  usual key resolution (`-i`, ssh-agent, `~/.ssh`).
- **Locked.** A connect to a vault-bound host while locked asks for the
  passphrase on a terminal; without one it fails `VAULT_LOCKED` (exit 3).
  Unbound hosts never touch the vault.
- **Scripts.** Pass the passphrase on an inherited file descriptor and name
  it in `PSC_VAULT_PASSPHRASE_FD` (the variable holds the fd number, never the
  passphrase): `PSC_VAULT_PASSPHRASE_FD=3 psc vault unlock 3< <(pass show pocketshell/vault)`.
- **Remember on this device.** `--remember` stores the vault data key (not the
  passphrase) in the OS keychain: Secret Service via `secret-tool` on Linux,
  the login keychain on macOS, current-user DPAPI on Windows. Without a
  keychain it is refused; `--remember-file` keeps it in a `0600` file instead,
  which anyone able to read that file (root, a backup, malware running as you)
  can use to decrypt every key in the vault. Without either, nothing is
  stored and the next connect asks again.
- **Wrong passphrase.** "That passphrase didn't unlock your vault." and a
  retry, waiting 1 s, 2 s, 4 s… (up to 30 s) after the third miss; the server
  may lock unlocking for a while after repeated misses. A forgotten passphrase
  cannot be recovered: reset the vault at https://app.pocketshell.io/keys?reset=1
  and upload the keys again.

## Remote aplexer (`psc a`)

`psc a` is a short, predictable command family for non-interactively driving
agent sessions across your hosts (plain text by default, `--json` everywhere,
same exit-code contract):

```text
psc a hosts [--check]                 saved hosts (presence online/offline; --check pings each in parallel)
psc a <host> ls                       sessions on <host> (name, engine, state, workspace) — plain table
psc a <host> start <tag> [-C DIR] [-e ENGINE] [--profile P] [--prompt TEXT | --prompt -] [--ready-timeout S]
psc a <host> send <session> [TEXT|-] [--no-enter]
psc a <host> capture <session> [--lines N] [--wait-for RE] [--timeout S] [--raw]
psc a <host> wait <session> [--idle S] [--timeout S]
psc a <host> stop <session> [--if-exists]
psc a <host> status <session>
```

`<host>` accepts an exact saved host name (or `local`), an enrolled gateway
device id (`hetzner-rmthz`, `host-laptop-…`), or a unique case-insensitive
prefix/substring (`hetzner`, `laptop`, `desktop`). Ambiguous selectors fail with
`HOST_AMBIGUOUS` (exit 2) and list the matching candidates.

```bash
# Populate saved gateway hosts from enrolled account devices (and optionally TOFU-pin keys):
psc hosts sync --user alexey --trust-advertised
psc hosts alias win35 desktop

# Inspect hosts (online/offline from broker presence, or --check for full SSH + version probes):
psc a hosts
psc a hosts --check

# Start or reuse a session, wait for readiness, and submit an initial prompt:
psc a hetzner start e2e-test -C '~/git/project' -e claude --prompt 'reply with just the word PONG'
psc a hetzner wait e2e-test --timeout 60
psc a hetzner capture e2e-test --wait-for PONG --lines 15

# Send a multi-line prompt as one bracketed-paste message and submit (Enter is default):
printf 'line1\nline2: reply LINES-OK\n' | psc a hetzner send e2e-test
psc a hetzner capture e2e-test --wait-for LINES-OK --lines 20
psc a hetzner status e2e-test
psc a hetzner stop e2e-test --if-exists
```


### Sessions: names and selectors

`sessions create NAME -C DIR` makes a session named `<basename of DIR>:NAME`
(`create review -C '~/git/project'` → `project:review`). Without `-e/--engine`
the session is a plain shell; with one it launches that agent (see `psc engines`).
Creating a name that is already live reuses it (`"created": false`).

`-C` is a path **on the host**. Quote a leading `~` (`-C '~/git/project'`) so
your local shell doesn't expand it to your local home: it must reach the host
unexpanded and is resolved there.

A `SESSION` argument is matched in this order:

1. the full name (`project:review`) or the aplexer id, exactly;
2. a tag (`review`) that exactly one session carries;
3. a unique prefix (4+ characters) of the aplexer id.

A selector that matches more than one session (a shared tag, several id
prefixes, or a tag and a prefix pointing at different sessions) fails with
`SESSION_AMBIGUOUS` and the candidates; no match fails with `SESSION_NOT_FOUND`.
Both exit 5.

### Driving a session

- `send` types the text but does **not** submit it; add `--enter` to press
  Enter. Text from stdin loses exactly one trailing newline, so
  `echo 'run the tests' | psc sessions send review --enter` submits once.
- `capture` prints the rendered screen as plain text (`--raw`: recent raw
  output bytes, `--bytes N` with `--raw` only). systemd-run's
  `Running as unit: …` banner is stripped.
- `capture --wait-for REGEX [--timeout S]` polls the screen about every 500 ms
  until the JavaScript regex matches (multiline: `^`/`$` match per line), then
  prints it (`"matched": true, "match": "…"`). Default timeout 30 s; on timeout
  it fails with `TIMEOUT`, exit 124, and the last capture in `error.text`.
- `kill` of a session that no longer exists is `SESSION_NOT_FOUND` (exit 5);
  with `--if-exists` it succeeds with `"killed": false, "alreadyGone": true`.

### exec

One word is a shell command line run as-is by the host's `sh`
(`psc exec 'cd ~/git/x && make test'`); several words are an argv and each is
shell-quoted (`psc exec -- ls -la /tmp` runs `'ls' '-la' '/tmp'`). Put `--`
before the command so its flags aren't read as psc options. `-t/--timeout`
(seconds, default 60) kills the command; in `local` mode its whole process
tree is killed, over ssh/gateway the remote command may keep running.

## The resident daemon and the classic path

On Linux and macOS `psc` routes the read-heavy commands (`ls`, `status`,
`capture`, `send`, `hosts`, `hosts --check`) through a per-user resident
daemon by default: one open gateway channel to the host helper
(`a rpc --stdio`), so a warm `psc hetzner ls` costs about one network round
trip instead of a fresh WebSocket + SSH handshake per call. The daemon is
started on demand, is idle-reaped, lives behind a peer-UID-checked unix
socket in `$XDG_RUNTIME_DIR` (or a private `/tmp` fallback when that is
unset, e.g. for non-interactive agents), and never holds ambient
credentials.

- `PSC_DAEMON=0` opts out and runs every command on the classic path.
- On Windows the default is the classic path; `PSC_DAEMON=1` opts in to the
  named-pipe daemon (below).
- Every daemon failure falls back transparently to the classic path: an
  unsafe or refused socket, a spawn failure, or a host helper without
  `a rpc` (the request is then served `transport: legacy`). An unusable
  runtime directory (unsafe ownership or modes) is detected before any
  spawn and costs nothing; a serve child that dies without listening is
  remembered for 60 s so later calls skip the attempt. Under `PSC_TRACE=1`
  the one-line reason is reported.

A resident channel outlives its routing token: the daemon's proxy opts into
in-band reauth (`caps: ["reauth"]`), and when the gateway supports it, mints
a fresh token and sends it over the open stream ~60 s before the current one
expires, rewriting its lease receipt on every acknowledgement. Without the
capability (an older gateway) the channel still closes at token expiry and
the daemon reconnects as before.

The daemon also **pre-warms** the hosts you used in the last 24 h: on start
and whenever the network changes underneath it, channels are opened in the
background (bounded concurrency, the usual offline negative cache and
backoff). Usage is recorded in
`~/.config/pocketshell-tui-client/daemon-usage.json` (0600, pruned after a
week; in-memory only on Windows). Pre-warm traffic does not keep the daemon
alive — idle exit still counts only real client requests.

### The local replica (reads under 10 ms)

When the host helper speaks PSC-RPC-2 (`a rpc --stdio --protocol 2`), the
daemon subscribes to its push stream and answers `ls` and `status` from a
local replica instead of a network round trip: typically 1–5 ms on any
host, at any distance. `capture` answers from a screen mirror subscribed on
first capture (unsubscribed after 10 minutes idle); `--lines` slicing stays
local and exact.

- JSON output gains `meta: { source: "replica" | "live", seq, ageMs }`.
  The replica is live while its channel is up and the last frame (snapshot
  or heartbeat) arrived within 6 s; activity-derived fields (agent activity
  state, CPU/process counts) may be up to 5 s old by helper design.
- `--fresh` on `ls`, `status` and `capture` forces a live round trip (and
  refreshes the replica).
- A gap mark with data replaces wholesale; a gap mark on a heartbeat voids
  that topic's freshness, and the next read does one live refresh first.
  If the replica is not live — stream down, heartbeat late, auth closing —
  reads fall back to a live round trip and never serve stale data silently.
  After an auth close the replica is dropped immediately.
- Writes stay request/response (exactly one round trip) and are never
  replayed when uncertain. `send` returns after the helper acknowledges;
  `--wait` additionally confirms prompt delivery synchronously (against the
  replica when live) and reports the outcome, while without it the daemon
  only observes delivery in the background (PSC_TRACE stages
  `send_observed`/`send_unconfirmed`) and never resends.

### Windows named-pipe daemon (opt-in)

`PSC_DAEMON=1` on Windows routes the same commands through a resident daemon
over `\\.\pipe\psc-…`, named for the user SID (or profile identity) and the
daemon namespace. The listener is the native relay binary, not Node: the
pipe carries an explicit owner-only security descriptor (remote and other
local principals are denied by the DACL), and every connection must
additionally present a 256-bit secret from
`%LOCALAPPDATA%\PocketShell\psc-daemon-….secret` (created exclusively,
inheriting the profile ACL, compared in constant time). Any failure — the
secret unreadable, the pipe refused, the daemon not starting — falls back to
the classic path.

The classic path itself is one connection per command wherever possible:

- psc prefers a **direct `a --json snapshot`** over the `pocketshell`
  wrapper whenever the host's `a` is known to work — the snapshot answers in
  ~80 ms where the wrapper costs ~260 ms. The tradeoff: a snapshot listing
  does not carry the wrapper's per-workspace `errors[]` rows (warnings that
  part of the session list could not be read), and any wrapper-only field
  arrives only on wrapper-served hosts. A host whose `a` breaks falls back
  to the wrapper automatically.
- Which backend serves a host is probed **once** (one combined exec: the
  wrapper listing, `command -v a` under the user-bin PATH, and an
  `a --json snapshot` validation) and the verdict is persisted for 24 h in
  `~/.config/pocketshell-tui-client/backend-cache.json` (0600, keyed by
  host name + host-key fingerprint, pruned after a week). Failures that
  suggest the backend changed — a wrapper error, `a` no longer resolving,
  a wrapper usage error on a verb (tray builds without `sessions create`)
  — invalidate the entry and re-probe once.
- `start -C '~'` expands `~` **on the host** (to its real profile
  directory, `$USERPROFILE` on Windows hosts), so a Windows host never gets
  an MSYS-internal home as its workspace.

## For agents

The CLI is meant to be driven by coding agents as well as people:

- `--json` (or `PSC_JSON=1`) prints exactly one JSON document on stdout per
  command — including usage errors (bad flags, missing arguments). Successes
  carry `"ok": true`; failures are
  `{"ok": false, "error": {"code": "...", "message": "...", ...details}}`, also
  on stdout. Some errors add fields to `error`: `candidates: [{name, id}]` for
  `SESSION_AMBIGUOUS`, `text` (the last capture) for a `--wait-for` timeout.
  The one exception is `login --json`, which first prints a `pending` line
  (`{"event":"pending","userCode","verificationUri","verificationUriComplete","expiresIn"}`)
  holding the code for the human, then the result.
- JSON keys are camelCase everywhere.
- Nothing prompts when stdin is not a terminal; ssh runs with `BatchMode=yes`
  for commands, so a missing key fails fast instead of hanging.
- Stable exit codes:

| Exit | Meaning | `error.code` |
| --- | --- | --- |
| 0 | ok | |
| 1 | error | `ERROR`, `HOST_COMMAND_FAILED`, account errors, … |
| 2 | usage / bad host config | `USAGE`, `HOST_STORE`, `BAD_HOST` |
| 3 | not logged in | `NOT_LOGGED_IN` |
| 4 | cannot connect to the host (or the connection dropped) | `CONNECT_FAILED`, `AUTH_FAILED`, `HOST_OFFLINE`, `CONNECTION_LOST`, … |
| 5 | session not found, or the selector is ambiguous | `SESSION_NOT_FOUND`, `SESSION_AMBIGUOUS` |
| 6 | the host's `pocketshell` CLI failed, is missing, or is too old | `HOST_CLI_FAILED`, `HOST_CLI_MISSING`, `HOST_CLI_TOO_OLD`, `HOST_CLI_MALFORMED` |
| 124 | a host command timed out (it may still complete on the host) | `TIMEOUT` |
| N | `exec`: the remote command's own exit code | `COMMAND_FAILED` |

Result shapes worth knowing:

```text
sessions create   {"ok":true,"host","name","id","created","session":{"name","id","created"}}
sessions send     {"ok":true,"host","session":{"name","id"},"bytes","enter"}
sessions capture  {"ok":true,"host","session":{"name","id"},"mode","text"[,"matched","match"]}
sessions kill     {"ok":true,"host","session":{"name","id"},"killed","alreadyGone"}
exec              {"ok","host","command","exitCode","stdout","stderr","timedOut"[,"error"]}
                  non-zero exit N → ok:false, error {"code":"COMMAND_FAILED","message":"exit N"}, exit N
                  timeout → error TIMEOUT, exit 124; no exit status → error CONNECTION_LOST, exit 4
hosts check       {"ok","host","mode","ms","pocketshell","aplexer"} (cannot connect → exit 4)
whoami            {"ok":true,"loggedIn":true,"email","label","brokerUrl","expiresAt","tokenId","verified"}
logout            {"ok":true,"loggedIn":false,"result","revoked","warning","expiresAt"[,"revokeError"]}
```

A failed server revoke still deletes the local credentials but exits 1 with
`"revoked":false` and `"revokeError":{"code","message"}` — the session stays
valid until `expiresAt`. See [Corporate / environment proxies](docs/corporate-proxy.md)
for `NO_PROXY` / `PSC_TRUSTED_PROXY` behavior (fail-closed under `NODE_USE_ENV_PROXY`).

A typical loop for an agent that drives another agent:

```bash
psc -H box sessions create review -C '~/git/project' -e claude --json   # → project:review
psc -H box sessions send review "review the open PR and summarise" --enter --json
psc -H box sessions capture review --wait-for 'summary' --timeout 600 --json  # block until it shows up
psc -H box sessions list --json                # agentState: working / waiting / idle
```

## State

| Path | What |
| --- | --- |
| `~/.config/pocketshell-tui-client/hosts.json` | saved hosts |
| `~/.config/pocketshell-tui-client/backend-cache.json` | per-host session-backend verdicts (24 h TTL) |
| `~/.config/pocketshell-tui-client/daemon-usage.json` | hosts used recently, for pre-warm (24 h window) |
| `~/.config/pocketshell-tui-client/vault-bindings.json` | which saved host uses which vault key id (0600, no secrets) |
| `~/.config/pocketshell-tui-client/vault-remember.json` | only with `psc vault unlock --remember-file`: the vault data key (0600) |
| `~/.config/pocketshell/credentials.json` | login session, shared with the `pocketshell` CLI |
| `~/.config/pocketshell/gateway_known_hosts` | gateway host-key pins, shared with the `pocketshell` CLI |
| `$XDG_RUNTIME_DIR/pocketshell-tui-client/` | OpenSSH control sockets |
| `$XDG_RUNTIME_DIR/psc-daemon-<uid>/` | resident daemon socket (0700, peer-UID checked) |
| `%LOCALAPPDATA%\PocketShell\psc-daemon-….secret` | Windows pipe connection secret (owner-only) |

## Development

```bash
npm run build       # dist/
npm run bundle      # dist-bundle/psc.mjs (standalone single-file bundle + npm pack tarball)
npm run typecheck
npm test            # vitest
```

`@pocketshell/core` is linked from the sibling checkout (`file:../pocketshell-core`);
rebuild it there (`npm run build`) after changing it.
# Provisioned native Windows gateway hosts

A trusted enrollment/provisioning record can opt a saved gateway host into the
native Windows CLI contract. Supply the actual protected console path and
canonical enrolled device ID; neither a Windows-looking display alias nor a
drive path automatically selects this adapter. The endpoint must use the
independently qualified Windows OpenSSH/Git Bash shell transport. For example,
after replacing every provisioning placeholder with its independently verified
value:

```sh
psc hosts add win35-native --gateway YOUR_ENROLLED_DEVICE_ID --user user \
  --native-windows-cli 'C:/PROVISIONED_RUNTIME/Scripts/pocketshell.exe' \
  --native-transport openssh-git-bash
```

The stored `nativeWindowsCli` policy contains `executable`, explicit
`transport: "openssh-git-bash"` and a `deviceId` exactly matching `gateway.deviceId`.
It cannot coexist with a legacy `--binary` override or a direct/local host.
Protected installation/source/RECORD/bundled-payload hash custody is established
out of band during provisioning, as in Desktop; this client does not claim to
verify the remote executable hash. Existing independent SSH-key pin and account
authorization remain the gateway transport's responsibility. Changing a display
alias does not change the native workspace registry identity.

Each connection validates the actual CLI version0.5.8 and platform schema1,
win32/nt and advertised capabilities. It uses the quoted absolute executable for
schema3 sessions, workspace registration, capability-gated create/kill and
interactive full-UUID attach, with the accepted distinct NONPTY/PTY quoting.
Full workspace paths and immutable UUIDs distinguish repeated display names;
ambiguous names refuse. Capture/send, warning/catalog verbs are not implemented
by this reviewed native profile and fail explicitly; no raw PATH `a`, shim,
tmux or POSIX PATH-wrapper fallback is attempted. It makes no tree cache writes,
so it does not manufacture CAS versions or tag-based tree identities.

An uncertain create (timeout, lost or malformed result) triggers an authoritative
session reread and reports uncertainty without automatic retry or adopting a
guessed UUID. A failed reread blocks subsequent creation on that client instance
until an explicit successful list. A new CLI process is a new instance; the user
must deliberately check the listing before retrying. Definite backend failures
remain failures. Native CMD/Bash-hex transport and actual end-to-end gateway
runtime qualification are separate gates; this source adapter does not approve
them. Hosts without the explicit native policy retain their Linux/POSIX behavior.

## Windows outgoing client source candidate

For the per-user offline Windows x64 zip, installation, account bootstrap and
release checks, see [Windows package installation](docs/windows-package.md).

The Windows branch uses local drive-absolute paths, separate DPAPI-backed account state (`pocketshell-client-account/credentials.dpapi`), and the protected state helper described in `native/psc-security/README.md`. Python's plaintext credentials are neither imported nor overwritten. Device login preflights storage before requesting a grant. Pin parsing, full SSH public-key validation, aliases and explicit replacement checks remain the existing shared logic; Windows storage routes through the protected helper.

Reviewed protected staging must supply `dist/windows-bindings.json`, adjacent to the emitted CLI tree, with exactly these fields: `version` (2), `sshFamily` (`win32-openssh`), absolute `helper`, `ssh`, `node`, `entry`, `systemRoot`, `systemDrive`, `programData`, and lowercase full SHA256 `helperSha256`, `sshSha256`, `nodeSha256`, `entrySha256`. The helper basename is `psc-security.exe`, and SSH is a qualified Win32 OpenSSH `ssh.exe`. Source mode looks for the equivalent `src/windows-bindings.json`; this candidate supplies neither file nor a runtime bypass. The manifest, Node executable, CLI tree and helper must be staged under verified protected ancestors by the parent. Digests bind reviewed files; a writable manifest is not an independent trust anchor. A manifest chosen by environment, cwd, PATH or an SSH override is refused.

The actual Node WSS gateway proxy remains the existing implementation. Windows ProxyCommand quotes a bound Node/CLI argv for the qualified Win32 OpenSSH CreateProcess profile, without a POSIX shell or cmd.exe. Gateway SSH keeps complete out-of-band host-key pins, strict host checking, a protected empty global known-hosts file, public-key-only authentication and disabled connection reuse. Paths inserted in OpenSSH file options currently refuse spaces and unsupported characters; this limitation is explicit and must be respected by staging. Proxy argv quoting has separate round-trip tests.

Windows SSH and native helper children receive a fresh allowlisted environment with bound system directories, fixed `SystemDrive` and `ProgramData`, owned config/runtime/home, fixed SSH directory PATH and an HTTPS broker. Inherited Node options, TLS overrides, proxies, agent/askpass and shell variables are excluded. Native helper invocation is direct, hidden, shell=false, with bounded pipes and generic errors. This is a source candidate: Linux mocks and policy checks are not Windows DPAPI/ACL/SSH runtime acceptance. The parent owns installation, native qualification, deployment and enrollment after independent source review.

Schema v2 requires `systemDrive` to be a drive letter plus colon matching `systemRoot`, and `programData` to be a canonical existing local drive-absolute directory path (not a volume root or redirected path). Both values come only from the protected staging manifest; caller environment values, including alternate casing, are never inherited. Parent supplies the qualified actual paths. The existing protected-prefix ACL policy is unchanged.
