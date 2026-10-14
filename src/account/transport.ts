/**
 * One transport-policy decision for broker traffic (fail-closed, explicit
 * trust). Every broker request — bearer or not — goes through
 * `resolveBrokerTransport`: the device code and the issued tokens in the JSON
 * bodies are credentials too, so a per-call "has bearer" flag is not enough.
 *
 * The decision is pure: it reads only its arguments, never `process.env`
 * directly (callers pass `process.env` / `process.execArgv` in). Policy unit
 * tests pass `env` explicitly.
 *
 * - `direct`: no environment proxy is in effect for this URL, or `NO_PROXY`
 *   bypasses the broker host. The caller must use an explicit transport that
 *   ignores environment proxies (Node's `http`/`https` with a fresh agent —
 *   they never read `HTTP(S)_PROXY`; only undici's global fetch does, and
 *   only under `NODE_USE_ENV_PROXY`).
 * - `trusted-proxy`: the explicit, reviewed opt-in. `PSC_TRUSTED_PROXY` names
 *   exactly the effective environment proxy (scheme/host/port; userinfo is
 *   ignored for the comparison), the broker URL is `https:` (the CONNECT
 *   tunnel carries end-to-end TLS, so the proxy never sees the bearer), and
 *   TLS verification is not weakened. Proxy userinfo is sent only as
 *   `Proxy-Authorization` to that proxy, never anywhere else.
 * - `refused`: an environment proxy is in effect, not bypassed, not trusted.
 *   The reason names the fixes (NO_PROXY, PSC_TRUSTED_PROXY, or unsetting
 *   NODE_USE_ENV_PROXY) and never contains proxy credentials.
 */
import { isIP } from 'node:net';

export const ENV_TRUSTED_PROXY = 'PSC_TRUSTED_PROXY';

export type BrokerTransport =
  | { kind: 'direct' }
  | { kind: 'trusted-proxy'; proxy: URL }
  | { kind: 'refused'; reason: string };

/** Split a `NO_PROXY`-style list on commas and/or whitespace. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function stripTrailingDots(host: string): string {
  return host.replace(/\.+$/, '');
}

/**
 * Whether a `NO_PROXY`/`no_proxy` value bypasses `hostname:port`.
 * Node/undici semantics: `*` matches everything; `example.com` and
 * `.example.com` both match the domain and its subdomains; an optional
 * `:port` restricts the match to that port; exact IP literals, including
 * bracketed IPv6; case-insensitive; trailing dots ignored. Unparseable
 * entries never match (fail closed).
 */
export function matchesNoProxy(hostname: string, port: number, noProxy: string | undefined): boolean {
  const host = stripTrailingDots(hostname.toLowerCase());
  if (!host) return false;
  const hostIsIp = isIP(host) !== 0;
  for (const raw of splitList(noProxy)) {
    const entry = raw.toLowerCase();
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort: number | null = null;
    if (entry.startsWith('[')) {
      // [v6-literal] or [v6-literal]:port
      const close = entry.indexOf(']');
      if (close < 0) continue;
      entryHost = entry.slice(1, close);
      const rest = entry.slice(close + 1);
      if (rest) {
        if (!rest.startsWith(':')) continue;
        entryPort = parsePort(rest.slice(1));
        if (entryPort === null) continue;
      }
    } else {
      const colons = (entry.match(/:/g) ?? []).length;
      if (colons > 1) {
        // A bare IPv6 literal: no port form exists without brackets.
        entryHost = entry;
      } else if (colons === 1) {
        const idx = entry.lastIndexOf(':');
        entryPort = parsePort(entry.slice(idx + 1));
        if (entryPort === null) continue;
        entryHost = entry.slice(0, idx);
      }
    }
    entryHost = stripTrailingDots(entryHost.startsWith('.') ? entryHost.slice(1) : entryHost);
    if (!entryHost) continue;
    if (entryPort !== null && entryPort !== port) continue;
    if (hostIsIp || isIP(entryHost) !== 0) {
      // IP literals match exactly only (no subdomain rule).
      if (host === entryHost) return true;
      continue;
    }
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Parse a proxy env value leniently (a bare `host:port` means http). Null when unusable. */
export function parseProxyUrl(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  const candidate = text.includes('://') ? text : `http://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/** `scheme://host:port`, lower-cased, without userinfo (safe to print). */
export function proxyIdentifier(url: URL): string {
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

/** Equal after normalization (scheme, host, port; userinfo ignored). */
export function proxiesEqual(a: URL, b: URL): boolean {
  if (a.protocol.toLowerCase() !== b.protocol.toLowerCase()) return false;
  if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
  const portOf = (url: URL): number => (url.port ? Number(url.port) : defaultPort(url.protocol));
  return portOf(a) === portOf(b);
}

/** Remove any credentials from a proxy display string (defensive redaction). */
function redactRawProxy(raw: string): string {
  const parsed = parseProxyUrl(raw);
  if (parsed) return proxyIdentifier(parsed);
  // Unparseable: hide a possible `user:pass@` part rather than echoing it.
  return raw
    .replace(/\/\/[^/\s]*@/g, '//***@')
    .replace(/^[^/\s:]*:[^/\s]*@/g, '***@')
    .slice(0, 120);
}

/**
 * The proxy the environment would route `scheme` through (null when none).
 * `https:` consults `HTTPS_PROXY`/`https_proxy`, falling back to
 * `HTTP_PROXY`/`http_proxy` — the conservative superset, so a proxy that
 * could see the CONNECT tunnel is never missed. `http:` uses `HTTP_PROXY`/
 * `http_proxy`. A present-but-unparseable value is returned as a broken
 * marker so callers fail closed rather than treating it as absent.
 */
export interface EffectiveProxy {
  url: URL | null;
  raw: string;
}

export function effectiveProxyForScheme(scheme: string, env: NodeJS.ProcessEnv): EffectiveProxy | null {
  const names =
    scheme === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
      : ['HTTP_PROXY', 'http_proxy'];
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    // A value of only whitespace counts as set-but-broken (fail closed).
    const url = parseProxyUrl(raw);
    return { url, raw };
  }
  return null;
}

function noProxyValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.NO_PROXY ?? env.no_proxy;
}

/** Whether `NODE_USE_ENV_PROXY=1` / `--use-env-proxy` opts into env proxies. */
export function envProxyOptIn(env: NodeJS.ProcessEnv, execArgv: readonly string[], nodeOptions: string | undefined): boolean {
  if (env.NODE_USE_ENV_PROXY === '1') return true;
  if (execArgv.includes('--use-env-proxy')) return true;
  return splitList(nodeOptions).includes('--use-env-proxy');
}

const TLS_DOWNGRADE_FLAGS = ['--insecure-http-parser'];

/** True when TLS verification to the broker may be weakened. Fail closed. */
export function tlsVerificationWeakened(
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return true;
  const flags = [...execArgv, ...splitList(nodeOptions)];
  return flags.some((flag) => TLS_DOWNGRADE_FLAGS.includes(flag) || flag.startsWith('--tls-'));
}

function effectiveBrokerPort(url: URL): number {
  return url.port ? Number(url.port) : defaultPort(url.protocol);
}

/**
 * The single transport-policy decision for one broker URL. Pure: `env`,
 * `execArgv` and `nodeOptions` are passed in (production: `process.env`,
 * `process.execArgv`, `process.env.NODE_OPTIONS`).
 */
export function resolveBrokerTransport(
  url: URL,
  env: NodeJS.ProcessEnv,
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): BrokerTransport {
  const brokerHost = stripTrailingDots(url.hostname.toLowerCase());
  if (!envProxyOptIn(env, execArgv, nodeOptions)) return { kind: 'direct' };
  const effective = effectiveProxyForScheme(url.protocol, env);
  if (!effective) return { kind: 'direct' };
  if (matchesNoProxy(url.hostname, effectiveBrokerPort(url), noProxyValue(env))) return { kind: 'direct' };

  const shownProxy = effective.url ? proxyIdentifier(effective.url) : redactRawProxy(effective.raw);
  const fixes =
    `add '${brokerHost}' to NO_PROXY to connect directly, ` +
    `or set ${ENV_TRUSTED_PROXY}=${shownProxy} to trust this proxy for https broker traffic, ` +
    `or unset NODE_USE_ENV_PROXY to disable environment proxies`;

  if (!effective.url) {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the environment proxy (${shownProxy}): ` +
        `its URL could not be parsed. ${fixes}.`,
    };
  }

  const trustedRaw = env[ENV_TRUSTED_PROXY];
  if (trustedRaw === undefined || trustedRaw === '') {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the environment proxy (${shownProxy}); ` +
        `the proxy would see the login. ${fixes}.`,
    };
  }
  const trusted = parseProxyUrl(trustedRaw);
  if (!trusted) {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the environment proxy (${shownProxy}): ` +
        `${ENV_TRUSTED_PROXY} could not be parsed. ${fixes}.`,
    };
  }
  if (!proxiesEqual(trusted, effective.url)) {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the environment proxy (${shownProxy}): ` +
        `${ENV_TRUSTED_PROXY} (${proxyIdentifier(trusted)}) does not match it. ${fixes}.`,
    };
  }
  if (url.protocol !== 'https:') {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the trusted proxy (${shownProxy}): ` +
        `${ENV_TRUSTED_PROXY} only applies to https broker URLs, where the CONNECT tunnel carries ` +
        `end-to-end TLS the proxy cannot read. ${fixes}.`,
    };
  }
  if (tlsVerificationWeakened(env, execArgv, nodeOptions)) {
    return {
      kind: 'refused',
      reason:
        `Refusing to send PocketShell broker credentials through the trusted proxy (${shownProxy}): ` +
        `TLS verification looks weakened (NODE_TLS_REJECT_UNAUTHORIZED=0 or a --tls-*/--insecure-http-parser ` +
        `flag). Remove the downgrade and try again.`,
    };
  }
  return { kind: 'trusted-proxy', proxy: effective.url };
}
