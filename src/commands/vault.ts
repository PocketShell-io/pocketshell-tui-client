/**
 * `psc vault unlock|lock|status|bind`: the PocketShell key vault from the
 * terminal. The logic lives in src/vault; this file only renders it.
 * Nothing here prints a key, a passphrase, a DEK or an AUTH value.
 */
import { InvalidArgumentError, type Command } from 'commander';
import { cleanText } from '../account/index.js';
import { getHost, listHosts, setHostVault, type HostEntry, type HostVaultBinding } from '../hosts/store.js';
import { emit, isJsonMode, setJsonMode } from '../output.js';
import {
  cachedBinding,
  cliAccount,
  hostKey,
  lockVault,
  refreshBindings,
  rememberVault,
  storeFor,
  unlockRemembered,
  VaultError,
  type CachedBinding,
  type KeyVaultStore,
  type VaultAccount,
} from '../vault/index.js';
import { PASSPHRASE_FD_ENV } from '../vault/passphrase.js';
import { keychain, loadRemembered, rememberFile } from '../vault/remember.js';
import { KEYS_URL, RESET_URL, unlockInteractively } from '../vault/session.js';
import { action, jsonOption } from './common.js';

const UNLOCK_HELP = `
Unlocks your PocketShell key vault with the account vault passphrase (set on
the web: ${KEYS_URL}). Hosts bound to a vault key then connect with that key,
held only in memory; psc never writes a private key to disk.

Passphrase input: a no-echo prompt on the terminal, or, for scripts, an open
file descriptor named by ${PASSPHRASE_FD_ENV} (the variable holds the fd
NUMBER, never the passphrase), e.g.
  ${PASSPHRASE_FD_ENV}=3 psc vault unlock --remember 3< <(pass show pocketshell/vault)

Remember on this device:
  --remember        keep the vault key in the OS keychain (Secret Service via
                    secret-tool on Linux, the login keychain on macOS, DPAPI on
                    Windows) so later connects need no passphrase. Refused when
                    there is no keychain.
  --remember-file   keep it in a 0600 file instead
                    (\${XDG_CONFIG_HOME:-~/.config}/pocketshell-tui-client/vault-remember.json).
                    RISK: anyone who can read that file (root, a backup, malware
                    running as you) can decrypt every key in your vault without
                    the passphrase. Use only on a machine you trust.
Without either, nothing is stored: the next connect to a vault-bound host asks
for the passphrase again (or fails VAULT_LOCKED, exit 3, without a terminal).

Wrong passphrase: "That passphrase didn't unlock your vault." and a retry, with
a growing wait after the third miss. Forgot it? ${RESET_URL}`;

function accountOrExplain(): VaultAccount {
  return cliAccount();
}

function describeBinding(store: KeyVaultStore | null, binding: CachedBinding): Record<string, unknown> {
  const key = store?.getKey(binding.keyId) ?? null;
  return {
    keyId: binding.keyId,
    keyName: key ? cleanText(key.name) : null,
    keyType: key?.type ?? null,
    gatewayAuth: binding.gatewayAuth,
    accountAlias: binding.alias,
  };
}

function hostRows(store: KeyVaultStore | null, accountId: string, hosts: readonly HostEntry[]): Array<Record<string, unknown>> {
  return hosts
    .filter((h) => h.mode !== 'local')
    .map((h) => {
      const binding = cachedBinding(accountId, h);
      return { host: h.name, ...(binding ? describeBinding(store, binding) : { keyId: null }) };
    });
}

export function registerVault(program: Command): void {
  const vault = program.command('vault').description('your PocketShell key vault: unlock, lock, status, bind');

  jsonOption(
    vault
      .command('unlock')
      .description('unlock the key vault with your vault passphrase')
      .option('--remember', 'remember on this device (OS keychain)')
      .option('--remember-file', 'remember in a 0600 file (see the risk below)'),
  )
    .addHelpText('after', UNLOCK_HELP)
    .action(
      action(async (opts: { remember?: boolean; rememberFile?: boolean; json?: boolean }) => {
        if (opts.json) setJsonMode(true);
        if (opts.remember && opts.rememberFile) throw new VaultError('pass --remember or --remember-file, not both', 'USAGE', 2);
        const backend = opts.remember ? 'keychain' : opts.rememberFile ? 'file' : null;
        // Refuse before asking for anything when the keychain cannot be used.
        if (backend === 'keychain' && keychain() === null) {
          throw new VaultError(
            'No OS keychain is available here (Linux needs secret-tool and a D-Bus session). ' +
              'Unlock without --remember, or pass --remember-file to keep the vault key in a 0600 file ' +
              '(anyone who can read that file can decrypt your keys).',
            'KEYCHAIN_UNAVAILABLE',
            2,
          );
        }
        const account = accountOrExplain();
        const store = storeFor(account);
        await unlockInteractively(store, isJsonMode() ? { onMessage: (t) => process.stderr.write(`${t}\n`) } : {});
        if (backend !== null) rememberVault(account, store, backend);
        const hosts = listHosts();
        const bindings = await refreshBindings(account, store, hosts);
        const bound = hosts.filter((h) => bindings[hostKey(h)] !== undefined).map((h) => h.name);
        if (backend === 'file') {
          process.stderr.write(
            `warning: the vault key is now in ${rememberFile()} (0600). Anyone who can read it can decrypt your keys; ` +
              '`psc vault lock` removes it.\n',
          );
        }
        emit(
          {
            ok: true,
            unlocked: true,
            vaultId: store.vaultId,
            epoch: store.epoch,
            remembered: backend,
            keys: store.listKeys().length,
            boundHosts: bound,
          },
          () =>
            [
              `Vault unlocked (${store.listKeys().length} key${store.listKeys().length === 1 ? '' : 's'}).`,
              bound.length > 0 ? `Hosts using a vault key: ${bound.join(', ')}` : 'No saved host is bound to a vault key yet.',
              backend === 'keychain'
                ? 'Remembered on this device (OS keychain). `psc vault lock` forgets it.'
                : backend === 'file'
                  ? 'Remembered on this device (0600 file). `psc vault lock` forgets it.'
                  : 'Not remembered: the next connect to a vault-bound host asks again (use --remember to keep it).',
            ].join('\n'),
        );
      }),
    );

  jsonOption(vault.command('lock').description('lock the vault and forget it on this device')).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const account = accountOrExplain();
      const had = loadRemembered(account.id);
      lockVault(account.id);
      emit({ ok: true, locked: true, forgot: had?.backend ?? null }, () =>
        had ? `Vault locked; forgot the remembered key (${had.backend}).` : 'Vault locked (nothing was remembered on this device).',
      );
    }),
  );

  jsonOption(
    vault
      .command('status')
      .description('is the vault unlocked or remembered, its keys and which hosts use them (no secrets)'),
  ).action(
    action(async (opts: { json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const account = accountOrExplain();
      const store = storeFor(account);
      const probe = await store.probe();
      if (probe.kind === 'noVault') {
        emit({ ok: true, vault: false, unlocked: false, remembered: null, keys: [], hosts: [] }, () =>
          `Your account has no key vault yet. Create it on the web: ${KEYS_URL}`,
        );
        return;
      }
      if (probe.kind === 'corrupt') throw new VaultError('The vault on your account is malformed.', 'VAULT_MALFORMED');
      let remembered: string | null = null;
      try {
        remembered = await unlockRemembered(account, store);
      } catch (error) {
        process.stderr.write(`warning: ${(error as Error).message}\n`);
      }
      const unlocked = store.state === 'unlocked';
      const hosts = listHosts();
      if (unlocked) await refreshBindings(account, store, hosts);
      const keys = store.listKeys().map((k) => ({
        keyId: k.keyId,
        name: cleanText(k.name),
        type: k.type,
        fingerprint: k.fingerprint ?? null,
        createdAt: k.createdAt ?? null,
      }));
      const rows = hostRows(unlocked ? store : null, account.id, hosts);
      emit(
        {
          ok: true,
          vault: true,
          vaultId: probe.kind === 'vault' ? probe.vaultId : store.vaultId,
          epoch: probe.kind === 'vault' ? probe.epoch : store.epoch,
          unlocked,
          remembered,
          keychain: keychain()?.name ?? null,
          keys,
          hosts: rows,
        },
        () => {
          const lines = [
            unlocked
              ? `Vault: unlocked (remembered on this device: ${remembered ?? 'no'})`
              : 'Vault: locked (run `psc vault unlock`)',
          ];
          if (unlocked) {
            lines.push(keys.length === 0 ? 'Keys: none (upload on the web)' : 'Keys:');
            for (const k of keys) lines.push(`  ${k.name || '(unnamed)'}  ${k.type}  ${k.fingerprint ?? ''}  [${k.keyId}]`);
          }
          const bound = rows.filter((r) => r.keyId !== null);
          lines.push(bound.length === 0 ? 'Saved hosts using a vault key: none' : 'Saved hosts using a vault key:');
          for (const r of bound) {
            lines.push(`  ${String(r.host)} -> ${String(r.keyName ?? r.keyId)} (gateway auth: ${String(r.gatewayAuth)})`);
          }
          return lines.join('\n');
        },
      );
    }),
  );

  jsonOption(
    vault
      .command('bind <host>')
      .description('override which vault binding a saved host uses (default: matched to the account host automatically)')
      .option('--alias <name>', 'use the vault binding of this account host alias')
      .option('--key <name|keyId>', 'use this vault key directly')
      .option('--gateway-auth <policy>', 'with --key: host | managed | both (default managed)', (v: string) => {
        if (!['host', 'managed', 'both'].includes(v)) throw new InvalidArgumentError('expected host, managed or both');
        return v as 'host' | 'managed' | 'both';
      })
      .option('--clear', 'remove the override'),
  ).action(
    action(async (name: string, opts: { alias?: string; key?: string; gatewayAuth?: 'host' | 'managed' | 'both'; clear?: boolean; json?: boolean }) => {
      if (opts.json) setJsonMode(true);
      const host = getHost(name);
      if (opts.clear) {
        if (opts.alias || opts.key || opts.gatewayAuth) throw new VaultError('--clear takes no other option', 'USAGE', 2);
        setHostVault(host.name, null);
      } else {
        if (!opts.alias && !opts.key) throw new VaultError('pass --alias <name>, --key <name|keyId> or --clear', 'USAGE', 2);
        if (opts.gatewayAuth && !opts.key) throw new VaultError('--gateway-auth goes with --key', 'USAGE', 2);
        const binding: HostVaultBinding = {};
        if (opts.alias) binding.alias = opts.alias;
        if (opts.key) {
          let keyId = opts.key;
          if (!/^[A-Za-z0-9_-]{22}$/.test(keyId)) {
            // A key name needs the unlocked index to resolve.
            const account = accountOrExplain();
            const store = storeFor(account);
            if (store.state !== 'unlocked' && (await unlockRemembered(account, store)) === null) {
              await unlockInteractively(store);
            }
            const matches = store.listKeys().filter((k) => k.name === opts.key || k.keyId === opts.key);
            if (matches.length !== 1) {
              throw new VaultError(
                matches.length === 0 ? `no vault key named ${JSON.stringify(opts.key)} (see \`psc vault status\`)` : `${matches.length} vault keys are named ${JSON.stringify(opts.key)}; pass the key id`,
                'USAGE',
                2,
              );
            }
            keyId = matches[0]!.keyId;
          }
          binding.keyId = keyId;
          if (opts.gatewayAuth) binding.gatewayAuth = opts.gatewayAuth;
        }
        setHostVault(host.name, binding);
      }
      // Re-derive the cache when the vault is open here; otherwise the next unlock does.
      try {
        const account = cliAccount();
        const store = storeFor(account);
        if (store.state === 'unlocked' || (await unlockRemembered(account, store)) !== null) {
          await refreshBindings(account, store, listHosts());
        }
      } catch {
        /* not logged in or offline: the local override still applies */
      }
      const updated = getHost(host.name);
      emit({ ok: true, host: updated.name, vault: updated.vault ?? null }, () =>
        updated.vault ? `${updated.name}: vault binding ${JSON.stringify(updated.vault)}` : `${updated.name}: vault override cleared`,
      );
    }),
  );
}
