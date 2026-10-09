import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostKeyAlias } from '../src/gateway/endpoint.js';
import {
  addPin,
  fingerprint,
  loadPinEntries,
  parseHostKey,
  PinError,
  pinFilePath,
  removePin,
  requirePinEntry,
} from '../src/gateway/pins.js';

export const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuV1O9rNRp7VtgPq3H6Mze4PugDi32wsIYRrGAzHWLb';
const ED25519_FP = 'SHA256:fsLMalVzTXS0DD6o65vqKTk5hByPaxy61KwmlbaaZiU';
const ECDSA256 =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBND3jrQbAMx3xAOJWwHH88UHnWOr4Y41fwgBTOBX6UCqfyTZx2Gk2IkzZy3RC42jiSaUPyKT6Fl3mAsKnktSvsI=';
const ECDSA384 =
  'ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBGbshUQoSOVor3fpD76Dt0CGs4E8hkErKikpwpYBf7Tj6oXnXjVG/g215KkPk9FN5V+GSIXg5TASwxlL7x16ZNxrEktmGYMgrLVf9m0MyqcrjrrAXsP5LivlCqXtsHFfaQ==';
const RSA1024 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC9+W2/kl+Ye6l+QiTGvkw0o+//S2HFMBft+SV/U/VYXu0EPiI90df28Hq9ZLE18v9ne3+yGRaRjUe90ukdldg3YBZL9Vt9tbbQT4ZAi3Y+Z7ftVBGYVLYxvJAG7W0gpdkbwfW4M7YX8468vFD/MqsCjAft2VFjKCWrfGdDxB6Mcw==';
const RSA2048 =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDCOA7FllPtLKSbQyVoGS6JilLkeC2Abp6XsBRe1XfHzc5m3O8bSN1I58D0mTEhZxWayCQP4EdBKyZ/pWNKYM5NCtCUJzScRdfcHFeJSkEw980f1zGJyrNkbUk+QkLrPtlgrbl7+0WWBojsmBC6VhYo34f3aIVwKFpquo5huSGIEq8A1VKzeLmB46RZ1Nw68fsuY2PIU+blMhwDSM3qjxbrWP40aXrT92FxfUnUlUmhfT/KXWFSJW4Bo+8pA9vm+ddT+5byNDGILz/IyprItW0opMgpI4Vwziy+XAx3nLZPYPwvaXmY6vJ5ums9nJHaJ+vokFalAWNaURsm7Mw7XLzJ';

describe('parseHostKey', () => {
  it('accepts the supported types and computes OpenSSH fingerprints', () => {
    expect(fingerprint(parseHostKey(ED25519))).toBe(ED25519_FP);
    expect(fingerprint(parseHostKey(ECDSA256))).toBe('SHA256:T5+D7j7oOzLkkjO/fBAn06jwTLPzT7o6Lupf83QOtiU');
    expect(fingerprint(parseHostKey(ECDSA384))).toBe('SHA256:8SEmEhL5c8EwNz8s2k77K4+SLtSNS1/ura4aPucSlfE');
    expect(fingerprint(parseHostKey(RSA2048))).toBe('SHA256:WXd4E2mQ5xCwm5uZpJRv9T65XLNyQiKetSpAClMqPDo');
    expect(parseHostKey(`  ${ED25519} `).keyType).toBe('ssh-ed25519');
  });

  const [, b64] = ED25519.split(' ') as [string, string];
  it.each([
    ['rsa < 2048 bits', RSA1024, /1024 bits/],
    ['a comment', `${ED25519} me@host`, /exactly/],
    ['a marker', `@cert-authority ${ED25519}`, /exactly/],
    ['two spaces', `ssh-ed25519  ${b64}`, /exactly/],
    ['a newline', `${ED25519}\n${ED25519}`, /newline/],
    ['a tab', `ssh-ed25519\t${b64}`, /newline/],
    ['unknown type', `ssh-dss ${b64}`, /unsupported/],
    ['type mismatch', `ecdsa-sha2-nistp256 ${b64}`, /not the stated/],
    ['bad base64', 'ssh-ed25519 AAAA*AAA', /base64/],
    ['non-canonical base64', ECDSA256.replace(/I=$/, 'J='), /canonical/],
    ['truncated blob', `ssh-ed25519 ${b64.slice(0, 40)}`, /./],
    ['empty', '', /empty/],
  ])('refuses %s', (_name, line, message) => {
    expect(() => parseHostKey(line)).toThrow(PinError);
    expect(() => parseHostKey(line)).toThrow(message);
  });
});

describe('the pin file', () => {
  let xdg: string;
  const saved = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), 'psc-pins-'));
    process.env.XDG_CONFIG_HOME = xdg;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(xdg, { recursive: true, force: true });
  });

  it('round-trips in the shared format with private permissions', () => {
    expect(pinFilePath()).toBe(join(xdg, 'pocketshell', 'gateway_known_hosts'));
    expect(addPin('Home-Lab', parseHostKey(ED25519))).toBe(true);
    expect(addPin('Home-Lab', parseHostKey(ED25519))).toBe(false);
    expect(addPin('box-2', parseHostKey(RSA2048))).toBe(true);
    const text = readFileSync(pinFilePath(), 'utf8');
    expect(text).toBe(`${hostKeyAlias('Home-Lab')} ${ED25519} Home-Lab\n${hostKeyAlias('box-2')} ${RSA2048} box-2\n`);
    expect(statSync(pinFilePath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, 'pocketshell')).mode & 0o777).toBe(0o700);
    expect(requirePinEntry('Home-Lab').alias).toBe(hostKeyAlias('Home-Lab'));
    expect(fingerprint(removePin('Home-Lab'))).toBe(ED25519_FP);
    expect([...loadPinEntries().keys()]).toEqual(['box-2']);
    expect(() => removePin('Home-Lab')).toThrow(/no host key is pinned/);
  });

  it('refuses a different key without --replace, and case collisions', () => {
    addPin('home-lab', parseHostKey(ED25519));
    expect(() => addPin('home-lab', parseHostKey(ECDSA256))).toThrow(/--replace/);
    expect(addPin('home-lab', parseHostKey(ECDSA256), { replace: true })).toBe(true);
    expect(() => addPin('Home-Lab', parseHostKey(ED25519))).toThrow(/letter case/);
  });

  it('NOT_PINNED tells the user what to run', () => {
    try {
      requirePinEntry('home-lab');
      expect.unreachable();
    } catch (error) {
      expect((error as PinError).code).toBe('NOT_PINNED');
      expect((error as Error).message).toContain('pocketshell gateway show --host-key');
      expect((error as Error).message).toContain('pocketshell-tui-client gateway pin home-lab');
    }
  });

  it('reads legacy lines and migrates them on the next write', () => {
    mkdirSync(join(xdg, 'pocketshell'), { mode: 0o700 });
    writeFileSync(pinFilePath(), `pocketshell-gateway.Home-Lab ${ED25519}\n`, { mode: 0o600 });
    const entry = requirePinEntry('Home-Lab');
    expect(entry.alias).toBe('pocketshell-gateway.Home-Lab');
    expect(addPin('Home-Lab', parseHostKey(ED25519))).toBe(false);
    expect(readFileSync(pinFilePath(), 'utf8')).toBe(`${hostKeyAlias('Home-Lab')} ${ED25519} Home-Lab\n`);
  });

  function writeRaw(text: string, mode = 0o600): void {
    mkdirSync(join(xdg, 'pocketshell'), { recursive: true, mode: 0o700 });
    writeFileSync(pinFilePath(), text, { mode });
    chmodSync(pinFilePath(), mode);
  }

  it.each([
    ['a marker line', `@cert-authority * ${ED25519}\n`],
    ['a wildcard host', `pocketshell-gateway.* ${ED25519}\n`],
    ['a hashed host', `|1|abc= ${ED25519}\n`],
    ['an alias for another id', `${hostKeyAlias('other')} ${ED25519} home-lab\n`],
    ['a duplicate device', `${hostKeyAlias('home-lab')} ${ED25519} home-lab\n${hostKeyAlias('home-lab')} ${ECDSA256} home-lab\n`],
    ['a case collision', `${hostKeyAlias('home-lab')} ${ED25519} home-lab\n${hostKeyAlias('Home-Lab')} ${ED25519} Home-Lab\n`],
    ['no final newline', `${hostKeyAlias('home-lab')} ${ED25519} home-lab`],
    ['a bad key', `${hostKeyAlias('home-lab')} ${RSA1024} home-lab\n`],
  ])('refuses a file with %s', (_name, text) => {
    writeRaw(text);
    expect(() => loadPinEntries()).toThrow(PinError);
  });

  it('refuses unsafe permissions and symlinks', () => {
    writeRaw(`${hostKeyAlias('home-lab')} ${ED25519} home-lab\n`, 0o622);
    expect(() => loadPinEntries()).toThrow(/writable by group/);
    chmodSync(pinFilePath(), 0o600);
    chmodSync(join(xdg, 'pocketshell'), 0o777);
    expect(() => loadPinEntries()).toThrow(/pin directory .* writable/);
    chmodSync(join(xdg, 'pocketshell'), 0o700);
    const real = join(xdg, 'real');
    writeFileSync(real, `${hostKeyAlias('home-lab')} ${ED25519} home-lab\n`, { mode: 0o600 });
    rmSync(pinFilePath());
    symlinkSync(real, pinFilePath());
    expect(() => loadPinEntries()).toThrow(/symlink/);
  });

  it('interoperates with the Python CLI pin file (when available)', () => {
    const src = '/home/alexey/git/pocketshell-cli/src';
    if (!existsSync(`${src}/pocketshell/gateway/pins.py`)) return;
    const run = (code: string) =>
      execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(src)})\n${code}`], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
      });
    try {
      run(`from pocketshell.gateway import pins\npins.add_pin("Py-Host", pins.parse_host_key(${JSON.stringify(ECDSA256)}))`);
    } catch {
      return; // python deps missing: skip
    }
    expect(fingerprint(requirePinEntry('Py-Host').key)).toBe(fingerprint(parseHostKey(ECDSA256)));
    addPin('ts-host', parseHostKey(ED25519));
    const out = run(
      'from pocketshell.gateway import pins\nfor i, e in sorted(pins.load_pin_entries().items()): print(i, e.alias, e.key.fingerprint)',
    );
    expect(out.trim().split('\n')).toEqual([
      `Py-Host ${hostKeyAlias('Py-Host')} ${fingerprint(parseHostKey(ECDSA256))}`,
      `ts-host ${hostKeyAlias('ts-host')} ${ED25519_FP}`,
    ]);
  });
});
