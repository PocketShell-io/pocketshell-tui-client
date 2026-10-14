# Corporate / environment proxies

PocketShell credentials (the session token, the device code, the gateway JWT)
are bearer secrets: whoever holds them _is_ you. The client is **fail-closed**
when an environment proxy could see them.

## The default: refuse, don't leak

Node's global `fetch` routes through `HTTP(S)_PROXY` once the process opts in
(`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`). The broker client therefore
never uses the global fetch: every broker request goes through one
transport-policy decision (`src/account/transport.ts`,
`resolveBrokerTransport`), over an explicit `node:http`/`node:https` stack
that never consults environment proxies.

| Situation | Decision |
| --- | --- |
| No `NODE_USE_ENV_PROXY=1` / `--use-env-proxy`, or no proxy configured for the URL scheme | `direct` |
| `NO_PROXY`/`no_proxy` matches the broker host | `direct` (bypass) |
| `PSC_TRUSTED_PROXY` equals the effective env proxy, broker URL is `https:`, TLS verification intact | `trusted-proxy` (explicit CONNECT tunnel) |
| Anything else (proxy in effect, not bypassed, not trusted) | `refused` — before any byte is sent |

A refusal fails _before_ any network I/O. Device login refuses before
`/auth/device/start`, so you are never sent to the browser only to fail at
the session check afterwards. The error names the three fixes:

- add the broker host to `NO_PROXY` to connect directly, or
- set `PSC_TRUSTED_PROXY=<the proxy URL>` to trust this proxy for `https:`
  broker traffic, or
- unset `NODE_USE_ENV_PROXY` to disable environment proxies.

Proxy credentials are never printed (userinfo is stripped from messages).

## `NO_PROXY` matching

Comma- or space-separated entries; `*` matches everything; `example.com` and
`.example.com` both match the domain and its subdomains; an optional `:port`
restricts the match to that port; exact IP literals including bracketed IPv6
(`[::1]`, `[::1]:8080`); case-insensitive; trailing dots ignored. Unparseable
entries never match.

```bash
export NO_PROXY='localhost,127.0.0.1,::1,corp-broker.example.com'
```

## Trusting a proxy (`PSC_TRUSTED_PROXY`)

The explicit, reviewed opt-in for a TLS-intercepting corporate proxy you
trust. It must equal the effective environment proxy for the scheme after
normalization (scheme, host, port — userinfo is ignored for the comparison):

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY='http://proxy.corp.example:8080'
export PSC_TRUSTED_PROXY='http://proxy.corp.example:8080'
```

Rules:

- Only for `https:` broker URLs: the CONNECT tunnel carries end-to-end TLS
  to the broker, so the proxy sees the authority (`host:port`) but never the
  bearer. A trusted proxy is refused for plain-`http` brokers.
- Refused when TLS verification is weakened (`NODE_TLS_REJECT_UNAUTHORIZED=0`
  or `--insecure-http-parser` / `--tls-*` downgrade flags).
- Proxy userinfo (`http://user:pass@proxy:8080`) is sent only as a
  `Proxy-Authorization` header to that proxy, never anywhere else.

## Revoke failures are surfaced

`logout` revokes the session best-effort and always deletes the local
credentials, but a failed server revoke is no longer silent:

- human mode prints `warning: server-side revoke failed (…); the session
  stays valid until …`;
- `--json` reports `"revoked": false` plus `"revokeError": {"code", "message"}`;
- the exit code is 1 (the session stays valid until `expiresAt`).

The login-cleanup revoke (an issued-but-unsaved token after a failed session
check) warns the same way and never masks the original error.

## Other credential paths (audited)

- `gateway proxy` (the WebSocket to the gateway, whose first frame carries the
  JWT) uses a fresh `http`/`https` agent per connection — never the global
  agent — and the `ws` library has no environment-proxy support, so the token
  goes only to the gateway you named.
- `gateway devices` (`GET …/devices` with the broker JWT) uses explicit
  `node:http`/`node:https` requests with fresh agents: no proxy involved.
- Everything else that sends a credential (`login`, `logout`, `whoami`,
  gateway-token minting for `hosts`/`gateway` commands) funnels through the
  broker client above, so the same policy applies.
