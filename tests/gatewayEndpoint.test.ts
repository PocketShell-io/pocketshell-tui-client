import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clientSshUrl,
  devicesUrl,
  EndpointError,
  hostKeyAlias,
  legacyHostKeyAlias,
  resolveEndpoint,
  validateDeviceId,
} from '../src/gateway/endpoint.js';
import { parseControlFrame } from '../src/gateway/proxy.js';
import { JsonFloat, parseStrictJson, sanitizeRemoteText } from '../src/gateway/text.js';

const PY_SRC = '/home/alexey/git/pocketshell-cli/src';

function python(code: string): string | null {
  if (!existsSync(`${PY_SRC}/pocketshell/gateway/endpoint.py`)) return null;
  try {
    return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PY_SRC)})\n${code}`], {
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

describe('device ids and host-key aliases', () => {
  it('validates the gateway grammar', () => {
    for (const ok of ['abc', 'Home-Lab', 'dev:box_1.x', 'a'.repeat(64)]) expect(validateDeviceId(ok)).toBe(ok);
    for (const bad of ['ab', '-abc', '.abc', 'a b', 'a/b', 'a'.repeat(65), 'héllo', 'a%b']) {
      expect(() => validateDeviceId(bad)).toThrow(EndpointError);
    }
  });

  it('matches vectors computed by the Python CLI', () => {
    expect(hostKeyAlias('Home-Lab')).toBe('pocketshell-gateway.home-lab-e8e20353974e');
    expect(hostKeyAlias('home-lab')).toBe('pocketshell-gateway.home-lab-2d478009766c');
    expect(hostKeyAlias('dev:box_1.x')).toBe('pocketshell-gateway.dev:box_1.x-0584a63690c9');
    expect(legacyHostKeyAlias('Home-Lab')).toBe('pocketshell-gateway.Home-Lab');
  });

  it('agrees with the live Python implementation (when available)', () => {
    const ids = ['Home-Lab', 'x.y:z-1', 'ABC_def'];
    const out = python(`from pocketshell.gateway.endpoint import host_key_alias\nfor d in ${JSON.stringify(ids)}: print(host_key_alias(d))`);
    if (out === null) return;
    expect(out.trim().split('\n')).toEqual(ids.map(hostKeyAlias));
  });
});

describe('resolveEndpoint', () => {
  it('defaults to production', () => {
    const ep = resolveEndpoint(undefined);
    expect(ep).toMatchObject({ wsBase: 'wss://gateway.pocketshell.io', httpBase: 'https://gateway.pocketshell.io', isProduction: true });
    expect(clientSshUrl(ep, 'home-lab')).toBe('wss://gateway.pocketshell.io/api/v1/hosts/home-lab/ssh');
    expect(devicesUrl(ep)).toBe('https://gateway.pocketshell.io/identity/v1/devices');
  });

  it('normalizes host case, trailing dot, ports and IPv6', () => {
    expect(resolveEndpoint('wss://RELAY.PocketShell.io.').isProduction).toBe(true);
    expect(resolveEndpoint('wss://gw.example:8443/').wsBase).toBe('wss://gw.example:8443');
    expect(resolveEndpoint('https://gw.example').wsBase).toBe('wss://gw.example');
    expect(resolveEndpoint('wss://[::1]:9000').wsBase).toBe('wss://[::1]:9000');
    expect(resolveEndpoint('wss://gw.example').isProduction).toBe(false);
  });

  it('allows ws:// only with insecure-dev to loopback / localhost / a docker name', () => {
    expect(() => resolveEndpoint('ws://127.0.0.1:8080')).toThrow(/insecure-dev/);
    expect(resolveEndpoint('ws://127.0.0.1:8080', true)).toMatchObject({ wsBase: 'ws://127.0.0.1:8080', secure: false, warning: '' });
    expect(resolveEndpoint('ws://localhost', true).warning).toBe('');
    expect(resolveEndpoint('ws://gateway:8080', true).warning).toMatch(/CLEARTEXT/);
    expect(() => resolveEndpoint('ws://10.0.0.5', true)).toThrow(EndpointError);
    expect(() => resolveEndpoint('ws://gw.example.com', true)).toThrow(EndpointError);
    expect(() => resolveEndpoint('ws://gateway.pocketshell.io', true)).toThrow(EndpointError);
  });

  it.each([
    'wss://gw.example/path',
    'wss://gw.example?x=1',
    'wss://gw.example#f',
    'wss://user:pw@gw.example',
    'wss://gw example',
    "wss://gw.example';id",
    'wss://gw.example:99999',
    'wss://gw.example:abc',
    'ftp://gw.example',
    'wss://bad_host.example',
    'wss://gw.ex%41mple',
    'gw.example',
    '   ',
  ])('refuses %j', (server) => {
    expect(() => resolveEndpoint(server, true)).toThrow(EndpointError);
  });
});

describe('sanitizeRemoteText', () => {
  it('strips ANSI, bidi/zero-width and controls; one line; capped', () => {
    expect(sanitizeRemoteText('\x1b[31mred\x1b[0m‮evil\nline​ two\t end')).toBe('redevil line two end');
    expect(sanitizeRemoteText('\x1b]0;title\x07ok\x9b2J')).toBe('ok2J');
    expect(sanitizeRemoteText('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeRemoteText('x'.repeat(500)).endsWith('…')).toBe(true);
    expect(sanitizeRemoteText(42)).toBe('');
  });

  it('agrees with Python on a hostile sample (when available)', () => {
    const sample = '\x1b[2J\x1bPdcs\x1b\\a b c\ud800de\u0085f';
    const out = python(
      `import json\nfrom pocketshell.gateway.tokens import sanitize_remote_text\nprint(json.dumps(sanitize_remote_text(json.loads(${JSON.stringify(
        JSON.stringify(sample),
      )}))))`,
    );
    if (out === null) return;
    expect(sanitizeRemoteText(sample)).toBe(JSON.parse(out));
  });
});

describe('strict JSON and control frames', () => {
  it('rejects duplicate keys and trailing data, flags floats', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow();
    expect(() => parseStrictJson('{"a":1} x')).toThrow();
    expect(() => parseStrictJson('{"a":NaN}')).toThrow();
    expect(() => parseStrictJson("{'a':1}")).toThrow();
    expect(parseStrictJson('{"v":1.0}')).toEqual({ v: new JsonFloat(1) });
    expect(parseStrictJson('{"x":[1,"\\u00e9",true,null,{"__proto__":2}]}')).toBeTruthy();
  });

  const ready = { type: 'ready', v: 1, device_id: 'home-lab', ssh_host_key: '' };
  it('accepts exact ready/error frames', () => {
    expect(parseControlFrame(JSON.stringify(ready))).toEqual(ready);
    expect(parseControlFrame('{"type":"error","v":1,"code":"host_offline","message":"m"}').type).toBe('error');
  });

  it.each([
    ['extra key', JSON.stringify({ ...ready, extra: 1 })],
    ['missing key', JSON.stringify({ type: 'ready', v: 1, device_id: 'x' })],
    ['duplicate key', '{"type":"ready","v":1,"device_id":"a","device_id":"b","ssh_host_key":""}'],
    ['v float', '{"type":"ready","v":1.0,"device_id":"a","ssh_host_key":""}'],
    ['v bool', '{"type":"ready","v":true,"device_id":"a","ssh_host_key":""}'],
    ['v 2', JSON.stringify({ ...ready, v: 2 })],
    ['non-string', JSON.stringify({ ...ready, device_id: 5 })],
    ['unknown type', JSON.stringify({ ...ready, type: 'hello' })],
    ['array', '[]'],
    ['oversize', JSON.stringify({ ...ready, ssh_host_key: 'x'.repeat(17000) })],
  ])('rejects %s', (_name, text) => {
    expect(() => parseControlFrame(text)).toThrow();
  });
});
