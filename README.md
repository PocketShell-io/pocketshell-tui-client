# pocketshell-client

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
npm link                   # puts `pocketshell-client` and `psc` on PATH
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
psc hosts list|add|remove|default|check
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
logout            {"ok":true,"loggedIn":false,"result","revoked","warning","expiresAt"}
```

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
| `~/.config/pocketshell-client/hosts.json` | saved hosts |
| `~/.config/pocketshell/credentials.json` | login session, shared with the `pocketshell` CLI |
| `~/.config/pocketshell/gateway_known_hosts` | gateway host-key pins, shared with the `pocketshell` CLI |
| `$XDG_RUNTIME_DIR/pocketshell-client/` | OpenSSH control sockets |

## Development

```bash
npm run build       # dist/
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

The Windows branch uses local drive-absolute paths, separate DPAPI-backed account state (`pocketshell-client-account/credentials.dpapi`), and the protected state helper described in `native/psc-security/README.md`. Python's plaintext credentials are neither imported nor overwritten. Device login preflights storage before requesting a grant. Pin parsing, full SSH public-key validation, aliases and explicit replacement checks remain the existing shared logic; Windows storage routes through the protected helper.

Reviewed protected staging must supply `dist/windows-bindings.json`, adjacent to the emitted CLI tree, with exactly these fields: `version` (2), `sshFamily` (`win32-openssh`), absolute `helper`, `ssh`, `node`, `entry`, `systemRoot`, `systemDrive`, `programData`, and lowercase full SHA256 `helperSha256`, `sshSha256`, `nodeSha256`, `entrySha256`. The helper basename is `psc-security.exe`, and SSH is a qualified Win32 OpenSSH `ssh.exe`. Source mode looks for the equivalent `src/windows-bindings.json`; this candidate supplies neither file nor a runtime bypass. The manifest, Node executable, CLI tree and helper must be staged under verified protected ancestors by the parent. Digests bind reviewed files; a writable manifest is not an independent trust anchor. A manifest chosen by environment, cwd, PATH or an SSH override is refused.

The actual Node WSS gateway proxy remains the existing implementation. Windows ProxyCommand quotes a bound Node/CLI argv for the qualified Win32 OpenSSH CreateProcess profile, without a POSIX shell or cmd.exe. Gateway SSH keeps complete out-of-band host-key pins, strict host checking, a protected empty global known-hosts file, public-key-only authentication and disabled connection reuse. Paths inserted in OpenSSH file options currently refuse spaces and unsupported characters; this limitation is explicit and must be respected by staging. Proxy argv quoting has separate round-trip tests.

Windows SSH and native helper children receive a fresh allowlisted environment with bound system directories, fixed `SystemDrive` and `ProgramData`, owned config/runtime/home, fixed SSH directory PATH and an HTTPS broker. Inherited Node options, TLS overrides, proxies, agent/askpass and shell variables are excluded. Native helper invocation is direct, hidden, shell=false, with bounded pipes and generic errors. This is a source candidate: Linux mocks and policy checks are not Windows DPAPI/ACL/SSH runtime acceptance. The parent owns installation, native qualification, deployment and enrollment after independent source review.

Schema v2 requires `systemDrive` to be a drive letter plus colon matching `systemRoot`, and `programData` to be a canonical existing local drive-absolute directory path (not a volume root or redirected path). Both values come only from the protected staging manifest; caller environment values, including alternate casing, are never inherited. Parent supplies the qualified actual paths. The existing protected-prefix ACL policy is unchanged.
