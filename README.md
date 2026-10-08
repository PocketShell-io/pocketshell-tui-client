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
psc sessions create NAME [-C DIR] [-e ENGINE] [--attach]
psc sessions send SESSION [TEXT] [--enter]   type into a session (stdin when TEXT is - or omitted)
psc sessions capture SESSION [--raw]  what the session shows right now
psc sessions attach SESSION           take over the terminal (Ctrl-b d detaches); also `psc attach`
psc sessions kill SESSION
psc sessions warnings | ack [SESSION]
psc workspaces list|add|remove
psc engines | profiles
psc exec -- COMMAND...                run a command on the host
psc login | logout | whoami           PocketShell account (device flow)
psc gateway devices|pin|unpin         gateway hosts and their pinned keys
```

`SESSION` is a session name (`workspace:tag`), its aplexer id or a unique id
prefix, or a tag that only one session has.

## For agents

The CLI is meant to be driven by coding agents as well as people:

- `--json` (or `PSC_JSON=1`) prints exactly one JSON document on stdout per
  command. Successes carry `"ok": true`; failures are
  `{"ok": false, "error": {"code": "...", "message": "..."}}`, also on stdout.
  The one exception is `login --json`, which first prints a `pending` line
  holding the code for the human, then the result.
- Nothing prompts when stdin is not a terminal; ssh runs with `BatchMode=yes`
  for commands, so a missing key fails fast instead of hanging.
- Stable exit codes:

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | error |
| 2 | usage / bad host config |
| 3 | not logged in |
| 4 | cannot connect to the host |
| 5 | session not found |
| 6 | the host's `pocketshell` CLI failed, is missing, or is too old |

A typical loop for an agent that drives another agent:

```bash
psc -H box sessions create review -C ~/git/project -e claude --json
psc -H box sessions send review "review the open PR and summarise" --enter --json
psc -H box sessions capture review --json      # poll the screen
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
