import { requests } from './context.js';
import { HostClient } from '../hostClient.js';
import { parseHostSessionsList, type SessionRow, type SessionsListing } from '@pocketshell/core';
import type { HostEntry } from '../hosts/store.js';
import { openConnection } from '../transport/index.js';
import { HostChannel, RpcFailure } from './channel.js';
import { gatewayPolicy } from './policy.js';
interface Slot {
  generation: string;
  channel: HostChannel;
}
const slots = new Map<string, Slot>();
const unsupported = new Map<string, { generation: string; until: number }>();
const backoff = new Map<string, { attempt: number; until: number; generation: string }>();
export function closeChannels(): void {
  for (const s of slots.values()) s.channel.close();
  slots.clear();
  unsupported.clear();
  backoff.clear();
}
async function channelFor(host: HostEntry): Promise<HostChannel> {
  let policy;
  try {
    policy = gatewayPolicy(host);
  } catch (error) {
    slots.get(host.name)?.channel.close();
    throw error;
  }
  const old = slots.get(host.name);
  if (old?.generation === policy.generation) {
    await old.channel.ready;
    return old.channel;
  }
  old?.channel.close();
  const previousRetry = backoff.get(host.name);
  const retry = previousRetry?.generation === policy.generation ? previousRetry : undefined;
  if (retry && retry.until > Date.now())
    throw new RpcFailure('RECONNECT_BACKOFF', 'host helper reconnect backoff', true);
  const channel = requests.exit(
    () =>
      new HostChannel(
        host,
        policy.accountExpires,
        (reason, established) => {
          if (slots.get(host.name)?.channel === channel) slots.delete(host.name);
          if (established && reason instanceof RpcFailure && reason.code === 'AUTH_LEASE_EXPIRED')
            void channelFor(host).catch(() => {});
        },
        () => {
          if (gatewayPolicy(host).generation !== policy.generation)
            throw new RpcFailure('POLICY_CHANGED', 'gateway policy changed before dispatch', true);
        },
      ),
  );
  slots.set(host.name, { generation: policy.generation, channel });
  try {
    await channel.ready;
    backoff.delete(host.name);
    return channel;
  } catch (error) {
    const attempt = Math.min(7, (retry?.attempt ?? 0) + 1);
    backoff.set(host.name, {
      generation: policy.generation,
      attempt,
      until: Date.now() + Math.min(30_000, 250 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5),
    });
    throw error;
  }
}
async function request(host: HostEntry, method: string, params: unknown, mutation = false): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const channel = await channelFor(host);
    try {
      return await channel.call(method, params, mutation);
    } catch (error) {
      if (mutation || attempt !== 0 || !(error instanceof RpcFailure) || error.code !== 'CONNECTION_LOST')
        throw error;
      channel.close();
    }
  }
}
/** Schema mapping is negotiated by the helper; the existing Core parser validates rows. */
function listing(value: unknown): SessionsListing {
  return parseHostSessionsList(JSON.stringify(value));
}
function selected(value: unknown): SessionRow {
  const row = (value as { session?: unknown })?.session;
  const parsed = listing({ schema: 3, sessions: [row], errors: [] }).sessions[0];
  if (!parsed) throw new RpcFailure('RPC_PROTOCOL', 'missing session');
  return parsed;
}
class RpcHostClient extends HostClient {
  constructor(private host: HostEntry) {
    super(
      {
        hostName: host.name,
        mode: host.mode,
        exec: async () => {
          throw new RpcFailure('RPC_UNSUPPORTED', 'resident client cannot execute raw commands', true);
        },
        attachInteractive: async () => {
          throw new RpcFailure('RPC_UNSUPPORTED', 'resident client cannot attach', true);
        },
        close: async () => {},
      },
      host.binary,
    );
  }
  override async probe(): Promise<{ pocketshell: string | null; aplexer: string | null }> {
    await request(this.host, 'ping', {});
    const channel = await channelFor(this.host);
    const capabilities = (await channel.ready) as { versions?: { pocketshell?: unknown; aplexer?: unknown } };
    const versions = capabilities.versions;
    return {
      pocketshell: typeof versions?.pocketshell === 'string' ? versions.pocketshell : null,
      aplexer: typeof versions?.aplexer === 'string' ? versions.aplexer : null,
    };
  }
  override async listSessions(): Promise<SessionsListing> {
    return listing(await request(this.host, 'list', { format: 'psc' }));
  }
  override async resolveSession(selector: string): Promise<SessionRow> {
    return selected(await request(this.host, 'status', { selector, selectorMode: 'psc' }));
  }
  override async sendSelected(
    selector: string,
    text: string,
    options: { enter: boolean },
  ): Promise<SessionRow> {
    return selected(
      await request(
        this.host,
        'send',
        { selector, selectorMode: 'psc', payload: text, submit: options.enter },
        true,
      ),
    );
  }
  override async captureSelected(
    selector: string,
    options: { mode: 'screen' | 'raw'; bytes?: number },
  ): Promise<{ row: SessionRow; text: string }> {
    const value = await request(this.host, 'capture', {
      selector,
      selectorMode: 'psc',
      mode: options.mode === 'raw' ? 'history' : 'screenPlain',
      maxBytes: options.bytes ?? (options.mode === 'raw' ? 16 * 1024 : 1024 * 1024),
    });
    const result = value as { text?: unknown; encoding?: unknown; data?: unknown };
    const text =
      typeof result.text === 'string'
        ? result.text
        : result.encoding === 'base64' && typeof result.data === 'string'
          ? Buffer.from(result.data, 'base64').toString('utf8')
          : null;
    if (text === null) throw new RpcFailure('RPC_PROTOCOL', 'capture text missing');
    return { row: selected(value), text };
  }
  override async capture(
    row: SessionRow,
    options: { mode: 'screen' | 'raw'; bytes?: number },
  ): Promise<string> {
    return (await this.captureSelected(row.id ?? row.name, options)).text;
  }
}
export async function daemonClient(host: HostEntry): Promise<HostClient> {
  const legacy = async () => {
    const context = requests.getStore();
    if (context) context.transportPath = 'legacy';
    return new HostClient(await openConnection(host), host.binary, host);
  };
  if (host.mode !== 'gateway' || host.nativeWindowsCli || (host.binary && host.binary !== 'pocketshell')) {
    slots.get(host.name)?.channel.close();
    return legacy();
  }
  let policy;
  try {
    policy = gatewayPolicy(host);
  } catch (error) {
    slots.get(host.name)?.channel.close();
    throw error;
  }
  const absent = unsupported.get(host.name);
  if (absent?.generation === policy.generation && absent.until > Date.now()) return legacy();
  try {
    const channel = await channelFor(host);
    const caps = (await channel.ready) as { pscSchema?: number; selectorModes?: string[] };
    if (caps.pscSchema !== 3 || !caps.selectorModes?.includes('psc')) return legacy();
    const context = requests.getStore();
    if (context) context.transportPath = 'resident';
    return new RpcHostClient(host);
  } catch (error) {
    if (error instanceof RpcFailure && error.code === 'RPC_UNSUPPORTED' && error.notDispatched) {
      unsupported.set(host.name, { generation: policy.generation, until: Date.now() + 30_000 });
      return legacy();
    }
    throw error;
  }
}
export async function warmHost(host: HostEntry): Promise<void> {
  await channelFor(host);
}

export async function pingHost(host: HostEntry): Promise<unknown> {
  const channel = await channelFor(host);
  const start = performance.now();
  const reply = await channel.call('ping', {});
  return { reply, transportMs: performance.now() - start };
}

export function presenceGeneration(hosts: readonly HostEntry[]): string {
  try {
    return JSON.stringify(
      hosts.map((host) =>
        host.mode === 'gateway' && !host.nativeWindowsCli ? gatewayPolicy(host).generation : host,
      ),
    );
  } catch (error) {
    closeChannels();
    throw error;
  }
}
