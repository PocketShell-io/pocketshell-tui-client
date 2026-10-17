# PocketShell client setup for dots (Linux)

Use `psc` to drive Alexey's agent sessions. Account approval, SSH user
authorization, and host-key pinning are three separate requirements.

## 1. Install

Requires Linux x86-64, Node.js **20 or newer** (tested with 24.13.1), npm,
curl, and OpenSSH (`ssh`, `ssh-keygen`). The npm package is not public;
install the self-contained Linux release asset, not the registry package.

Latest verified release on 2026-10-15: [v0.6.0](https://github.com/PocketShell-io/pocketshell-tui-client/releases/tag/v0.6.0).
It includes device-login commit `655e43f`; no new release is needed.
Use the Linux x64 asset below to get the native daemon launcher. The generic
tarball works on other Node platforms but does not provide that fast launcher.

```bash
node --version                        # >=20
uname -m                              # x86_64 for this asset
mkdir -p "$HOME/tmp/psc-install"
cd "$HOME/tmp/psc-install"
curl -fL --show-error \
  https://github.com/PocketShell-io/pocketshell-tui-client/releases/download/v0.6.0/pocketshell-tui-client-0.6.0-linux-x64.tgz \
  -o psc.tgz
echo 'cf617d9b866d4eb23acb2e28fa950ef31e16aba0479e7d7581c5a9e9a0592c8e  psc.tgz' | sha256sum -c -
npm install --global --prefix "$HOME/.local/psc" ./psc.tgz
export PATH="$HOME/.local/psc/bin:$PATH"
psc --version                         # 0.6.0
```

Keep the PATH export in your shell startup configuration. For later upgrades,
check the latest release's asset name and checksum before substituting them.

## 2. Set the proxy policy, then log in

**0.6.0 supports this environment safely, but refuses an untrusted proxy.**
With `NODE_USE_ENV_PROXY=1` and HTTP(S) proxies set, login returns
`TRANSPORT_REFUSED` before sending any device or account credentials unless
the broker is bypassed or the proxy is explicitly trusted.

Use this direct-connection recipe in every shell that runs psc, before the
daemon first starts. Leave HTTP_PROXY and HTTPS_PROXY available for other tools.

```bash
unset NODE_USE_ENV_PROXY PSC_TRUSTED_PROXY
export NO_PROXY="${NO_PROXY:-${no_proxy:-}},a7sota2qic.execute-api.eu-west-1.amazonaws.com"
psc login --no-open --label 'dots cloud'
```

Alternatively, keep `NODE_USE_ENV_PROXY=1` and apply just that `NO_PROXY`
export: the exact default broker hostname bypasses the proxy. This also works
if Node has `--use-env-proxy` in NODE_OPTIONS. Preserve existing bypass entries;
do not use `NO_PROXY=*`. If using an explicitly configured broker, bypass its
actual hostname instead. Direct HTTPS/WSS egress must be allowed. If it is
blocked, ask Alexey for a reviewed network route; do not disable TLS checks or
set PSC_TRUSTED_PROXY merely to silence the refusal.

Login prints `https://app.pocketshell.io/device?code=…` (or the `/device`
URL plus a separate short code) and waits. Privately send Alexey the printed
URL and short code. He opens it on his phone, signs in, checks the `dots cloud`
label/code, and approves. Keep the command running until `Logged in as …`.
Use the newly printed code each attempt; codes expire (currently 10 minutes).
Do not request or import Alexey's token. Avoid `--force` on an existing login.

```bash
psc whoami                            # expect verified: yes
```

Credentials stay in `${XDG_CONFIG_HOME:-$HOME/.config}/pocketshell/credentials.json`
(0600, inside a 0700 directory). Never print or copy that file. `login --json`
streams a pending record followed by a result; never dump it into public logs.

## 3. Authorize your SSH key, pin hosts, and save aliases

Generate a key **on dots' computer**, once. Keep the private file there.

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
test -f "$HOME/.ssh/id_ed25519_psc" || \
  ssh-keygen -q -t ed25519 -N '' -C dots-psc -f "$HOME/.ssh/id_ed25519_psc"
cat "$HOME/.ssh/id_ed25519_psc.pub"     # public key only; send privately to Alexey
psc gateway devices
```

Alexey uses an existing trusted connection or local console on **each host**
to add this `.pub` line to the authorized-keys file read by its PocketShell
private SSH endpoint, for the correct user. On Hetzner the endpoint accepts
`~alexey/.ssh/authorized_keys` and its endpoint-specific authorized_keys file;
on laptop use user `alexey`, on win35 use `dev` and that endpoint's configured
file. Linux directory/file modes should be 0700/0600. Windows needs the
endpoint's owner-only ACLs. Adding a key only to an unrelated system sshd's
file will not help. Alexey never sends you a private key; you never send yours.

Ask Alexey to confirm the current laptop device ID matching
`host-laptop-pha6tcnc-*`; never pass `*` literally. Both `…-yfoe` and `…-75fu`
were enrolled but offline at verification. The active Hetzner ID is `hetzner`;
`hetzner-rmthz` is an older offline enrollment.

For each selected device, Alexey obtains its **host public key** over a
trusted host console using `pocketshell gateway show --host-key` with the
running agent's actual `--config-dir`. On Hetzner that is
`~/git/pocketshell-cli/.venv/bin/pocketshell gateway show --host-key --config-dir ~/.config/pocketshell-link-private`.
Use an up-to-date host-side CLI; the default installed command may be older.
Ask him to send the public key line and fingerprint privately. Save the three
verified `ssh-ed25519 BASE64…` lines as the files below. Do not trust a key
solely because `gateway devices` advertises it; do not use `--trust-advertised`.

```bash
read -r -p 'Alexey-confirmed full laptop device ID: ' LAPTOP_ID
psc gateway pin hetzner < hetzner.hostkey
psc gateway pin "$LAPTOP_ID" < laptop.hostkey
psc gateway pin host-desktop-fp4op26-radg < win35.hostkey
psc hosts add hetzner --gateway hetzner --user alexey --identity "$HOME/.ssh/id_ed25519_psc"
psc hosts add laptop --gateway "$LAPTOP_ID" --user alexey --identity "$HOME/.ssh/id_ed25519_psc"
psc hosts add win35 --gateway host-desktop-fp4op26-radg --user dev --identity "$HOME/.ssh/id_ed25519_psc"
```

Pins are stored in `${XDG_CONFIG_HOME:-$HOME/.config}/pocketshell/gateway_known_hosts`.
Compare each printed fingerprint with Alexey's trusted value. A changed pin
requires Alexey to verify the rekey before using `gateway pin --replace`.
For an existing alias, inspect `psc hosts list` before deliberately replacing it.

## 4. Verify and use

```bash
psc hosts check hetzner
psc hosts check laptop
psc hosts check win35
psc hetzner ls
psc daemon status
time psc hetzner ls
```

Linux's native launcher starts the per-user daemon on demand; status should
show `running: true`. Expect about **7 ms** for warm replica-backed `ls`
(measured 5–8 ms on Hetzner). The first call establishes the connection and
costs more. The host needs a recent aplexer helper for the fast path;
`PSC_DAEMON=0` opts out. Offline laptop checks cannot pass until it reconnects.

Daily commands (replace `hetzner` with `laptop` or `win35` as needed):

```bash
psc hetzner ls
psc hetzner start dots-smoke -C /tmp    # creates a plain shell on the host
psc hetzner send dots-smoke "printf 'DOTS_SETUP_OK\\n'"
psc hetzner capture dots-smoke --wait-for DOTS_SETUP_OK --timeout 15 --lines 10
psc hetzner stop dots-smoke --if-exists
```

For an assistant session, add `-e ENGINE` and optionally `--prompt TEXT` to
`start`, choosing an installed engine and an existing host workspace with
`-C`. Quote paths beginning with `~` so dots' shell does not expand them
locally. `send` submits Enter by default and waits for the same delivery
verdict as `a send --enter`: exit 0 means the text was submitted (and the
agent started working, or this engine cannot be checked), exit 3 means it
was submitted but the agent stayed idle, exit 1 means it was not submitted.
A typed-but-unsent draft or a paste the agent dropped is not a success.
Use `--no-enter` to leave a draft. Capture can contain sensitive host output.

**No public posts:** do not post session output, screenshots, login codes,
account details, or credentials publicly. Communicate with Alexey privately;
starting an agent does not authorize it to publish posts or comments.

## Troubleshooting

- **No host key pinned / NOT_PINNED:** obtain the host's public key through
  Alexey's trusted connection and run `psc gateway pin` for the exact device ID.
  Never disable host-key checking or copy an advertised key blindly.
- **Permission denied (publickey) / AUTH_FAILED:** verify `--user`, the saved
  `--identity` path, and that this computer's `.pub` line is authorized by that
  private endpoint. Login approval does not authorize an SSH key.
- **host_offline / HOST_OFFLINE:** confirm the current device ID and ask Alexey
  to wake/reconnect the host and check its outbound gateway agent/private SSH
  endpoint. Do not install a public system sshd or open port 22.
- **TRANSPORT_REFUSED:** reapply section 2 in the invoking environment. Never
  weaken TLS or send a token through an unreviewed proxy. `whoami` may exit 0
  with cached account data and `verified: no`; that is not a verified connection.

Validation: release asset downloaded, checksum/install/version checked on
Hetzner with Node 24.13.1; simulated HTTP(S) proxy `http://127.0.0.1:9`.
Unbypassed calls refused; both direct recipes reached the broker and Hetzner.
Live login reached pending and was cancelled before human approval; full login
and secure credential saving passed synthetic-broker tests (128 account/CLI/
transport tests total). Host add/pin/check and the daily shell sequence ran
successfully on Hetzner; win35 check/list also passed with existing authorization.
A fresh unauthorized key failed as expected; laptop returned HOST_OFFLINE.
No remote host was provisioned with a new key by this validation. Never reuse
test credentials or transfer an existing machine's credentials to dots.
