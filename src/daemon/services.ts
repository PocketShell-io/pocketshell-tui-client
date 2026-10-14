import { requests, type RequestContext } from './context.js';
import { HostClient, pickSession } from '../hostClient.js';
import { noteResidentCapability } from '../hostCapability.js';
import { trace } from '../trace.js';
import { parseHostSessionsList, type SessionRow, type SessionsListing } from '@pocketshell/core';
import type { HostEntry } from '../hosts/store.js';
import { openConnection } from '../transport/index.js';
import { HostChannel, RpcFailure, type EventFrame } from './channel.js';
import { gatewayPolicy } from './policy.js';

/** A replica answer is served only while the last push frame is this fresh. */
export const REPLICA_LIVE_WINDOW_MS = 6_000;
/** A screen mirror nobody captured for this long is unsubscribed. */
const MIRROR_IDLE_MS = 10 * 60_000;
/** Client-side screen-mirror cap (the helper allows 16; keep headroom). */
const MAX_SCREENS = 8;

interface Replica {
  listing: SessionsListing;
  seq: number;
  generation: string;
  receivedAt: number;
  /**
   * A heartbeat with `gap:true` (no data) voided the freshness proof: the
   * topic is not live until one live round trip refreshes it. A snapshot
   * with data always clears this (full state replaces).
   */
  stale: boolean;
}

interface ScreenMirror {
  subscription: string;
  uuid: string;
  row: SessionRow;
  text: string;
  seq: number;
  receivedAt: number;
  lastCapturedAt: number;
  /** Same gap-heartbeat rule as the sessions topic, per mirror. */
  stale: boolean;
}

interface Slot {
  generation: string;
  channel: HostChannel;
  replica?: Replica;
  sessionsSubscription?: string;
  screens: Map<string, ScreenMirror>;
}
const slots = new Map<string, Slot>();
const unsupported = new Map<string, { generation: string; until: number }>();
const backoff = new Map<string, { attempt: number; until: number; generation: string }>();
/**
 * Short-TTL negative cache for gateway refusals that prove the host side is
 * gone (`HOST_OFFLINE`, `DEVICE_NOT_FOUND`): while cached the daemon fails
 * fast with the original refusal instead of minting a token and dialling the
 * gateway again. Auth failures and successes are never cached; the TTL is
 * short so a host coming back online is picked up promptly.
 */
const OFFLINE_CODES = new Set(['HOST_OFFLINE', 'DEVICE_NOT_FOUND']);
const OFFLINE_TTL_MS = 20_000;
const offline = new Map<string, { generation: string; until: number; failure: RpcFailure }>();
export function closeChannels(): void {
  for (const s of slots.values()) s.channel.close();
  slots.clear();
  unsupported.clear();
  backoff.clear();
  offline.clear();
}

/** Route one protocol-2 push frame into the host's replica state. */
function routeEvent(hostName: string, channel: HostChannel, frame: EventFrame): void {
  const slot = slots.get(hostName);
  if (!slot || slot.channel !== channel) return;
  try {
    if (frame.topic === 'sessions') {
      if (frame.subscription !== slot.sessionsSubscription) return;
      if (frame.event === 'snapshot') {
        // Full state, gap or not: replace, never merge; a data frame also
        // clears a gap-heartbeat mark (fresh full state again).
        slot.replica = {
          listing: parseHostSessionsList(JSON.stringify(frame.data)),
          seq: frame.seq,
          generation: frame.generation ?? slot.replica?.generation ?? '',
          receivedAt: Date.now(),
          stale: false,
        };
      } else if (frame.event === 'heartbeat' && slot.replica) {
        if (frame.generation) {
          if (!slot.replica.generation) slot.replica.generation = frame.generation;
          else if (frame.generation !== slot.replica.generation) {
            slot.replica = undefined; // a different helper generation: retire the replica
            return;
          }
        }
        if (frame.gap) {
          // No data: the freshness proof is void. Mark not-live; the next
          // read does one live refresh before serving from it again.
          slot.replica.stale = true;
          return;
        }
        slot.replica.receivedAt = Date.now();
        slot.replica.seq = frame.seq;
      }
      return;
    }
    if (frame.topic.startsWith('screen:')) {
      const mirror = slot.screens.get(frame.topic.slice('screen:'.length));
      if (!mirror || mirror.subscription !== frame.subscription) return;
      if (frame.event === 'ended') {
        slot.screens.delete(mirror.uuid);
        return;
      }
      if (frame.event === 'heartbeat') {
        if (frame.gap) {
          mirror.stale = true;
          return;
        }
        mirror.receivedAt = Date.now();
        mirror.seq = frame.seq;
        return;
      }
      // Screen data frames are full state: replace (gap or not).
      if (frame.event === 'screen') {
        const data = frame.data as { text?: unknown } | undefined;
        if (!data || typeof data.text !== 'string') return;
        mirror.text = data.text;
        try {
          mirror.row = selected(data);
        } catch {
          /* keep the last known row */
        }
        mirror.seq = frame.seq;
        mirror.stale = false;
        mirror.receivedAt = Date.now();
      }
    }
  } catch {
    /* a malformed frame never tears the channel down */
  }
}

/** Subscribe the sessions push stream once a protocol-2 channel is ready. */
async function primeReplica(hostName: string, channel: HostChannel): Promise<void> {
  if (channel.negotiated.protocol !== 2) return;
  try {
    const { subscription } = await channel.subscribe(['sessions'], { format: 'psc' });
    const slot = slots.get(hostName);
    if (slot?.channel === channel) slot.sessionsSubscription = subscription;
  } catch {
    /* no push stream: reads simply stay request/response */
  }
}

/** Retire screen mirrors nobody captured recently. */
let sweeper: NodeJS.Timeout | undefined;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const slot of slots.values()) {
      for (const [uuid, mirror] of slot.screens) {
        if (Date.now() - mirror.lastCapturedAt > MIRROR_IDLE_MS) {
          slot.screens.delete(uuid);
          void slot.channel.unsubscribe(mirror.subscription).catch(() => {});
        }
      }
    }
  }, 60_000);
  sweeper.unref();
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
  const knownOffline = offline.get(host.name);
  if (knownOffline?.generation === policy.generation && knownOffline.until > Date.now()) {
    trace('offline_cache_hit');
    throw knownOffline.failure;
  }
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
  channel.onEvent = (frame) => routeEvent(host.name, channel, frame);
  slots.set(host.name, { generation: policy.generation, channel, screens: new Map() });
  try {
    await channel.ready;
    backoff.delete(host.name);
    offline.delete(host.name);
    void primeReplica(host.name, channel);
    return channel;
  } catch (error) {
    if (error instanceof RpcFailure && OFFLINE_CODES.has(error.code)) {
      offline.set(host.name, {
        generation: policy.generation,
        until: Date.now() + OFFLINE_TTL_MS,
        failure: error,
      });
    }
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
  constructor(host: HostEntry) {
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
      host,
    );
  }

  /** The established slot for this host, when its channel is still usable. */
  private async liveSlot(): Promise<Slot | undefined> {
    // Re-check policy on every read, including replica reads: an unsafe or
    // deleted credential must refuse before dispatch even when the answer
    // could come from the local replica.
    let policy;
    try {
      policy = gatewayPolicy(this.host!);
    } catch (error) {
      slots.get(this.host!.name)?.channel.close();
      throw error;
    }
    const slot = slots.get(this.host!.name);
    if (!slot || slot.generation !== policy.generation) return undefined;
    try {
      await slot.channel.ready;
      return slot;
    } catch {
      return undefined;
    }
  }

  private static replicaLive(slot: Slot): boolean {
    return Boolean(
      slot.replica && !slot.replica.stale && Date.now() - slot.replica.receivedAt <= REPLICA_LIVE_WINDOW_MS,
    );
  }

  private static mirrorLive(slot: Slot, uuid: string): boolean {
    const mirror = slot.screens.get(uuid);
    return Boolean(mirror && !mirror.stale && Date.now() - mirror.receivedAt <= REPLICA_LIVE_WINDOW_MS);
  }

  /**
   * One live round trip that also refreshes the stored replica: the answer
   * after a gap mark, an expiry, or `--fresh`. Never serves silently stale
   * data; the refreshed replica serves subsequent reads.
   */
  private async refreshReplica(): Promise<SessionsListing> {
    const fresh = listing(await request(this.host!, 'list', { format: 'psc' }));
    const slot = slots.get(this.host!.name);
    if (slot) {
      slot.replica = {
        listing: fresh,
        seq: slot.replica?.seq ?? 0,
        generation: slot.replica?.generation ?? '',
        receivedAt: Date.now(),
        stale: false,
      };
    }
    return fresh;
  }

  /** Record the source of the answer for the command's JSON meta. */
  private static noteRead(context: RequestContext | undefined, meta: RequestContext['replicaMeta']): void {
    if (context) context.replicaMeta = meta;
  }

  override async probe(): Promise<{ pocketshell: string | null; aplexer: string | null }> {
    await request(this.host!, 'ping', {});
    const channel = await channelFor(this.host!);
    const capabilities = (await channel.ready) as { versions?: { pocketshell?: unknown; aplexer?: unknown } };
    const versions = capabilities.versions;
    return {
      pocketshell: typeof versions?.pocketshell === 'string' ? versions.pocketshell : null,
      aplexer: typeof versions?.aplexer === 'string' ? versions.aplexer : null,
    };
  }

  override async listSessions(options: { fresh?: boolean } = {}): Promise<SessionsListing> {
    const context = requests.getStore();
    const slot = await this.liveSlot();
    if (!options.fresh && slot && RpcHostClient.replicaLive(slot) && slot.replica) {
      RpcHostClient.noteRead(context, {
        source: 'replica',
        seq: slot.replica.seq,
        ageMs: Date.now() - slot.replica.receivedAt,
      });
      return slot.replica.listing;
    }
    RpcHostClient.noteRead(context, { source: 'live' });
    // Every live listing through a live slot refreshes the stored replica
    // (`--fresh` included): the next read is served locally again.
    if (slot) return this.refreshReplica();
    return listing(await request(this.host!, 'list', { format: 'psc' }));
  }

  override async resolveSession(selector: string, options: { fresh?: boolean } = {}): Promise<SessionRow> {
    const context = requests.getStore();
    const slot = await this.liveSlot();
    if (!options.fresh && slot && RpcHostClient.replicaLive(slot) && slot.replica) {
      const row = pickSession(slot.replica.listing.sessions, selector);
      RpcHostClient.noteRead(context, {
        source: 'replica',
        seq: slot.replica.seq,
        ageMs: Date.now() - slot.replica.receivedAt,
      });
      return row;
    }
    // One live refresh (a full listing, not a single status) so the stored
    // replica is current again before anything is served from it.
    if (slot && !options.fresh) {
      RpcHostClient.noteRead(context, { source: 'live' });
      return pickSession((await this.refreshReplica()).sessions, selector);
    }
    RpcHostClient.noteRead(context, { source: 'live' });
    return selected(await request(this.host!, 'status', { selector, selectorMode: 'psc' }));
  }

  override async sendSelected(
    selector: string,
    text: string,
    options: { enter: boolean },
  ): Promise<SessionRow> {
    return selected(
      await request(
        this.host!,
        'send',
        { selector, selectorMode: 'psc', payload: text, submit: options.enter },
        true,
      ),
    );
  }

  override async captureSelected(
    selector: string,
    options: { mode: 'screen' | 'raw'; bytes?: number; fresh?: boolean },
  ): Promise<{ row: SessionRow; text: string }> {
    const context = requests.getStore();
    const slot = await this.liveSlot();
    // The mirror carries rendered screens only; raw history always round-trips.
    if (!options.fresh && options.mode === 'screen' && slot && RpcHostClient.replicaLive(slot) && slot.replica) {
      const resolved = pickSession(slot.replica.listing.sessions, selector);
      if (resolved.id && RpcHostClient.mirrorLive(slot, resolved.id)) {
        const mirror = slot.screens.get(resolved.id)!;
        mirror.lastCapturedAt = Date.now();
        RpcHostClient.noteRead(context, {
          source: 'replica',
          seq: mirror.seq,
          ageMs: Date.now() - mirror.receivedAt,
        });
        return { row: mirror.row, text: mirror.text };
      }
    }
    const value = await request(this.host!, 'capture', {
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
    const captured = selected(value);
    RpcHostClient.noteRead(context, { source: 'live' });
    if (options.mode === 'screen' && captured.id && slot)
      await RpcHostClient.ensureMirror(slot, captured.id, { row: captured, text });
    return { row: captured, text };
  }

  /** Subscribe (or refresh) the screen mirror for a just-captured session. */
  private static async ensureMirror(
    slot: Slot,
    uuid: string,
    initial: { row: SessionRow; text: string },
  ): Promise<void> {
    ensureSweeper();
    const existing = slot.screens.get(uuid);
    if (existing) {
      // A live round trip after a gap mark or expiry re-primes the mirror:
      // the subscription is still valid helper-side, only the content and
      // the freshness proof needed renewal.
      existing.row = initial.row;
      existing.text = initial.text;
      existing.receivedAt = Date.now();
      existing.lastCapturedAt = Date.now();
      existing.stale = false;
      return;
    }
    if (slot.channel.negotiated.protocol !== 2) return;
    if (slot.screens.size >= MAX_SCREENS) {
      // Evict the least recently captured mirror to stay inside the budget.
      let oldest: string | undefined;
      for (const [key, mirror] of slot.screens)
        if (oldest === undefined || mirror.lastCapturedAt < slot.screens.get(oldest)!.lastCapturedAt) oldest = key;
      if (oldest !== undefined) {
        const evicted = slot.screens.get(oldest)!;
        slot.screens.delete(oldest);
        void slot.channel.unsubscribe(evicted.subscription).catch(() => {});
      }
    }
    try {
      const { subscription } = await slot.channel.subscribe([`screen:${uuid}`], { selectorMode: 'psc' });
      slot.screens.set(uuid, {
        subscription,
        uuid,
        row: initial.row,
        text: initial.text,
        seq: 0,
        receivedAt: Date.now(),
        lastCapturedAt: Date.now(),
        stale: false,
      });
    } catch {
      /* mirror unavailable: later captures keep round-tripping */
    }
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
    // The negotiation itself proved the helper: remember that this host has
    // `a`, so a later classic fallback serves `a --json snapshot` in one
    // connection instead of re-probing through the wrapper.
    noteResidentCapability(host, true);
    const context = requests.getStore();
    if (context) context.transportPath = 'resident';
    return new RpcHostClient(host);
  } catch (error) {
    if (error instanceof RpcFailure && error.code === 'RPC_UNSUPPORTED' && error.notDispatched) {
      noteResidentCapability(host, false);
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
