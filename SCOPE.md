# PocketShell scope

The [PocketShell product charter](https://github.com/PocketShell-io/pocketshell/blob/main/SCOPE.md)
is the scope policy for this repository, including its in-scope, owner-labelled
NOT and "Removed (Hub owns this)" lists.

This repo: psc/TUI human access and human-initiated scripts. Managed agent
workflows use Hub. psc keeps session listing JSON for inspection and scripts,
and manual create, attach, kill, capture, and keystroke send controls. It does
not automate agent readiness, prompts, or delivery verdicts, and does not
fall back to Hub.

PocketShell must work without Hub. Hub owns managed agent work and may stop/delete
any session, including manual PocketShell/psc sessions; PocketShell owns live human access.
