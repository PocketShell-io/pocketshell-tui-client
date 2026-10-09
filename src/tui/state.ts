/**
 * TUI state and its pure reducer: (state, action) → { state, effects }.
 *
 * The reducer never does I/O. Anything that talks to the host (refresh,
 * capture, attach, send, create, kill, switching hosts) comes back as an
 * Effect that the shell in index.ts runs, feeding results back as actions.
 */
import { canonicalisePath, type HostEngineInfo, type SessionRow, type WorkspaceMembership } from '@pocketshell/core';
import { safeLine, safeText } from '../sanitize.js';
import type { Key } from './keys.js';
import { editLine, inputValue, lineInput, type LineInput } from './prompt.js';

export type HostModeName = 'local' | 'ssh' | 'gateway';

export interface HostChoice {
  name: string;
  mode: HostModeName;
}

export type Mode =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'filter'; input: LineInput; previous: string }
  | { kind: 'send'; target: string; label: string; input: LineInput }
  | { kind: 'newName'; input: LineInput; cwd: string }
  | { kind: 'newCwd'; name: string; input: LineInput }
  | { kind: 'newEngine'; name: string; cwd: string; cursor: number }
  | { kind: 'newEngineText'; name: string; cwd: string; input: LineInput }
  | { kind: 'confirmKill'; target: string; label: string }
  | { kind: 'hosts'; cursor: number };

export interface Preview {
  key: string;
  full: boolean;
  text: string | null;
  error: string | null;
  loading: boolean;
}

export interface Status {
  text: string;
  kind: 'info' | 'ok' | 'error';
  seq: number;
}

export interface TuiState {
  hostName: string;
  hostMode: HostModeName | null;
  loggedIn: boolean | null;
  /** The host user's home, for `~` abbreviation (null: guess /home/<user>). */
  home: string | null;
  sessions: SessionRow[];
  listErrors: string[];
  workspaces: WorkspaceMembership[] | null;
  showEmpty: boolean;
  loaded: boolean;
  loadError: string | null;
  refreshing: boolean;
  /** Bumped on host switch; results from an older generation are dropped. */
  generation: number;
  filter: string;
  selectedKey: string | null;
  /** Position among selectable items, the fallback when the selected session disappears. */
  selectedIndex: number;
  /** A session to select as soon as a refresh brings it in (just created). */
  pendingSelect: string | null;
  scroll: number;
  width: number;
  height: number;
  mode: Mode;
  preview: Preview | null;
  engines: HostEngineInfo[] | null;
  enginesError: string | null;
  hosts: HostChoice[] | null;
  hostsError: string | null;
  status: Status | null;
  statusSeq: number;
  busy: string | null;
  spinner: number;
  /** Seconds since the epoch, for activity ages (advanced by `tick`). */
  now: number;
}

export type Effect =
  | { type: 'refresh' }
  | { type: 'loadEngines' }
  | { type: 'loadHosts' }
  | { type: 'capture'; row: SessionRow }
  | { type: 'attach'; row: SessionRow }
  | { type: 'send'; row: SessionRow; text: string }
  | { type: 'create'; name: string; cwd: string | null; engine: string | null; attach: boolean }
  | { type: 'kill'; row: SessionRow }
  | { type: 'switchHost'; name: string }
  | { type: 'redraw' }
  | { type: 'quit' };

export type Action =
  | { type: 'move'; delta: number }
  | { type: 'page'; dir: -1 | 1 }
  | { type: 'moveTo'; where: 'top' | 'bottom' }
  | { type: 'attach' }
  | { type: 'togglePreview' }
  | { type: 'togglePreviewFull' }
  | { type: 'startSend' }
  | { type: 'startNew' }
  | { type: 'startKill' }
  | { type: 'startFilter' }
  | { type: 'openHosts' }
  | { type: 'openHelp' }
  | { type: 'toggleEmpty' }
  | { type: 'refresh' }
  | { type: 'escape' }
  | { type: 'closeOverlay' }
  | { type: 'quit' }
  | { type: 'redraw' }
  | { type: 'input'; key: Key }
  | { type: 'pickerMove'; delta: number }
  | { type: 'pick'; attach: boolean }
  | { type: 'confirm'; yes: boolean }
  | { type: 'resize'; width: number; height: number }
  | { type: 'tick'; now: number }
  | { type: 'refreshStarted'; generation: number }
  | {
      type: 'refreshDone';
      generation: number;
      sessions: SessionRow[];
      errors: string[];
      workspaces: WorkspaceMembership[] | null;
      now: number;
    }
  | { type: 'refreshFailed'; generation: number; message: string }
  | { type: 'enginesLoaded'; engines: HostEngineInfo[] }
  | { type: 'enginesFailed'; message: string }
  | { type: 'hostsLoaded'; hosts: HostChoice[] }
  | { type: 'hostsFailed'; message: string }
  | { type: 'captured'; key: string; text: string }
  | { type: 'captureFailed'; key: string; message: string }
  | { type: 'busy'; text: string | null }
  | { type: 'opDone'; text: string; selectKey?: string }
  | { type: 'opFailed'; text: string }
  | { type: 'hostSwitched'; name: string; mode: HostModeName; loggedIn: boolean | null; home: string | null }
  | { type: 'loggedIn'; value: boolean | null }
  | { type: 'clearStatus'; seq: number };

export interface Result {
  state: TuiState;
  effects: Effect[];
}

export function initialState(options: {
  hostName: string;
  hostMode: HostModeName | null;
  width: number;
  height: number;
  now: number;
  home?: string | null;
  loggedIn?: boolean | null;
}): TuiState {
  return {
    hostName: safeLine(options.hostName),
    hostMode: options.hostMode,
    loggedIn: options.loggedIn ?? null,
    home: options.home ?? null,
    sessions: [],
    listErrors: [],
    workspaces: null,
    showEmpty: false,
    loaded: false,
    loadError: null,
    refreshing: false,
    generation: 0,
    filter: '',
    selectedKey: null,
    selectedIndex: 0,
    pendingSelect: null,
    scroll: 0,
    width: options.width,
    height: options.height,
    mode: { kind: 'list' },
    preview: null,
    engines: null,
    enginesError: null,
    hosts: null,
    hostsError: null,
    status: null,
    statusSeq: 0,
    busy: null,
    spinner: 0,
    now: options.now,
  };
}

// ── host text boundary ─────────────────────────────────────────────────────
//
// Everything the host says (session fields, engine labels, workspace paths,
// captures, stderr inside error messages) is scrubbed here, as it enters the
// state, so render only ever sees printable text. A session's identity is the
// exception: a scrubbed `name` could address a different session, so the
// host's own row is kept aside and the shell sends commands with that one.

const ROW_TEXT = ['name', 'workspace', 'tag', 'engine', 'profile', 'agent', 'agentState', 'agentStateSource', 'phase'] as const;
const HOST_ROWS = new WeakMap<SessionRow, SessionRow>();

/** A session row safe to display. The same object when nothing needed scrubbing. */
export function displayRow(row: SessionRow): SessionRow {
  let clean: SessionRow | null = null;
  for (const field of ROW_TEXT) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    const safe = safeLine(value);
    if (safe === value) continue;
    clean ??= { ...row };
    (clean as unknown as Record<string, unknown>)[field] = safe;
  }
  if (!clean) return row;
  HOST_ROWS.set(clean, HOST_ROWS.get(row) ?? row);
  return clean;
}

/** The row exactly as the host reported it — what commands (attach, send, kill, capture) must target. */
export function hostRow(row: SessionRow): SessionRow {
  return HOST_ROWS.get(row) ?? row;
}

function displayEngine(engine: HostEngineInfo): HostEngineInfo {
  // The id stays as the host spelled it: it goes back to the host in `create`.
  return { ...engine, label: safeLine(engine.label || engine.id) };
}

function displayWorkspace(ws: WorkspaceMembership): WorkspaceMembership {
  return { ...ws, path: safeLine(ws.path), displayPath: safeLine(ws.displayPath) };
}

// ── derived data ───────────────────────────────────────────────────────────

export function sessionKey(row: SessionRow): string {
  return row.id ? `id:${row.id}` : `name:${row.name}`;
}

export type Item =
  | { kind: 'group'; key: string; path: string; label: string; count: number; waiting: number; empty: boolean }
  | { kind: 'session'; key: string; row: SessionRow };

/** `~`-abbreviate a host path: the known home, else a `/home/<user>` / `/Users/<user>` guess. */
export function abbreviatePath(path: string, home: string | null): string {
  if (!path) return '(no workspace)';
  if (home && home !== '/') {
    const h = home.replace(/\/+$/, '');
    if (path === h) return '~';
    if (path.startsWith(`${h}/`)) return `~${path.slice(h.length)}`;
    return path;
  }
  const match = /^\/(?:home\/[^/]+|Users\/[^/]+|root)(?=\/|$)/.exec(path);
  return match ? `~${path.slice(match[0].length)}` : path;
}

export function matchesFilter(row: SessionRow, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.tag, row.agent, row.engine, row.agentState, row.phase, row.workspace]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

const NO_WORKSPACE = '';

function groupPath(row: SessionRow): string {
  return row.workspace?.trim() ? canonicalisePath(row.workspace) : NO_WORKSPACE;
}

/** The body list: workspace headers (alphabetical, no-workspace last), each followed by its sessions by tag. */
export function visibleItems(state: TuiState): Item[] {
  const groups = new Map<string, SessionRow[]>();
  for (const row of state.sessions) {
    if (!matchesFilter(row, state.filter)) continue;
    const path = groupPath(row);
    const list = groups.get(path);
    if (list) list.push(row);
    else groups.set(path, [row]);
  }
  if (state.showEmpty && state.workspaces) {
    const needle = state.filter.trim().toLowerCase();
    for (const ws of state.workspaces) {
      const path = canonicalisePath(ws.path);
      if (groups.has(path)) continue;
      if (needle && !ws.path.toLowerCase().includes(needle) && !ws.displayPath.toLowerCase().includes(needle)) continue;
      groups.set(path, []);
    }
  }
  const labelled = [...groups.entries()].map(([path, rows]) => ({ path, rows, label: abbreviatePath(path, state.home) }));
  labelled.sort((a, b) => {
    if (a.path === NO_WORKSPACE) return 1;
    if (b.path === NO_WORKSPACE) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path);
  });
  const items: Item[] = [];
  for (const group of labelled) {
    const rows = [...group.rows].sort((a, b) =>
      (a.tag ?? a.name).localeCompare(b.tag ?? b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name),
    );
    items.push({
      kind: 'group',
      key: `ws:${group.path}`,
      path: group.path,
      label: group.label,
      count: rows.length,
      waiting: rows.filter((row) => row.agentState === 'waiting').length,
      empty: rows.length === 0,
    });
    for (const row of rows) items.push({ kind: 'session', key: sessionKey(row), row });
  }
  return items;
}

function isSelectable(item: Item): boolean {
  return item.kind === 'session' || item.empty;
}

export function selectedItem(state: TuiState, items = visibleItems(state)): Item | null {
  return items.find((item) => item.key === state.selectedKey) ?? null;
}

export function selectedSession(state: TuiState, items = visibleItems(state)): SessionRow | null {
  const item = selectedItem(state, items);
  return item?.kind === 'session' ? item.row : null;
}

export interface Layout {
  bodyTop: number;
  bodyHeight: number;
  listHeight: number;
  previewHeight: number;
}

/** Rows: header, rule, body (list [+ preview pane, its title row included]), status, key hints. */
export function layout(state: TuiState): Layout {
  const bodyHeight = Math.max(1, state.height - 4);
  if (!state.preview) return { bodyTop: 2, bodyHeight, listHeight: bodyHeight, previewHeight: 0 };
  if (state.preview.full || bodyHeight < 12) return { bodyTop: 2, bodyHeight, listHeight: 0, previewHeight: bodyHeight };
  const listHeight = Math.max(4, Math.floor(bodyHeight * 0.4));
  return { bodyTop: 2, bodyHeight, listHeight, previewHeight: bodyHeight - listHeight };
}

// ── reducer ────────────────────────────────────────────────────────────────

function withStatus(state: TuiState, text: string, kind: Status['kind'] = 'info'): TuiState {
  const seq = state.statusSeq + 1;
  return { ...state, status: { text: safeLine(text), kind, seq }, statusSeq: seq };
}

/** Keep the selection valid and visible; follow it with the preview. */
function settle(state: TuiState, effects: Effect[]): Result {
  const items = visibleItems(state);
  const selectable = items.filter(isSelectable);
  let next = state;
  if (next.pendingSelect && selectable.some((item) => item.key === next.pendingSelect)) {
    next = { ...next, selectedKey: next.pendingSelect, pendingSelect: null };
  }
  if (selectable.length === 0) {
    next = { ...next, selectedKey: null, selectedIndex: 0, scroll: 0 };
  } else {
    let index = selectable.findIndex((item) => item.key === next.selectedKey);
    if (index < 0) index = Math.min(Math.max(0, next.selectedIndex), selectable.length - 1);
    next = { ...next, selectedKey: selectable[index]!.key, selectedIndex: index };
  }
  // Scroll so the cursor (and its group header, when it is the group's first row) is in view.
  const { listHeight } = layout(next);
  if (listHeight > 0 && next.selectedKey) {
    const row = items.findIndex((item) => item.key === next.selectedKey);
    const above = row > 0 && items[row - 1]!.kind === 'group' ? row - 1 : row;
    let scroll = next.scroll;
    if (above < scroll) scroll = above;
    if (row >= scroll + listHeight) scroll = row - listHeight + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, items.length - listHeight)));
    if (scroll !== next.scroll) next = { ...next, scroll };
  } else if (next.scroll !== 0 && items.length <= listHeight) {
    next = { ...next, scroll: 0 };
  }
  // The preview follows the selected session.
  if (next.preview) {
    const item = items.find((entry) => entry.key === next.selectedKey);
    const key = item?.key ?? '';
    if (next.preview.key !== key) {
      next = { ...next, preview: { ...next.preview, key, text: null, error: null, loading: item?.kind === 'session' } };
      if (item?.kind === 'session') effects = [...effects, { type: 'capture', row: item.row }];
    }
  }
  return { state: next, effects };
}

function moveBy(state: TuiState, delta: number): TuiState {
  const selectable = visibleItems(state).filter(isSelectable);
  if (selectable.length === 0) return state;
  const current = Math.max(0, selectable.findIndex((item) => item.key === state.selectedKey));
  const index = Math.max(0, Math.min(selectable.length - 1, current + delta));
  return { ...state, selectedKey: selectable[index]!.key, selectedIndex: index, pendingSelect: null };
}

/** Engine picker rows: plain shell, the host's creatable engines, then free text. */
export interface EngineOption {
  id: string | null;
  label: string;
  other?: boolean;
}

export function engineOptions(state: TuiState): EngineOption[] {
  const engines = (state.engines ?? []).filter((engine) => engine.availableForCreate);
  return [
    { id: null, label: 'shell (no agent)' },
    ...engines.map((engine) => ({ id: engine.id, label: engine.label || engine.id })),
    { id: null, label: 'other… (type an engine id)', other: true },
  ];
}

function defaultEngineCursor(state: TuiState): number {
  const options = engineOptions(state);
  const current = selectedSession(state);
  const wanted = current?.engine ?? current?.agent ?? null;
  const index = wanted ? options.findIndex((option) => option.id === wanted) : -1;
  if (index >= 0) return index;
  return options.length > 2 ? 1 : 0;
}

export function hostChoiceIndex(state: TuiState): number {
  return Math.max(0, (state.hosts ?? []).findIndex((host) => host.name === state.hostName));
}

function onInput(state: TuiState, key: Key): Result {
  const mode = state.mode;
  if (!('input' in mode)) return { state, effects: [] };
  const { input, done } = editLine(mode.input, key);
  const value = inputValue(input).trim();
  switch (mode.kind) {
    case 'filter':
      if (done === 'cancel') return settle({ ...state, filter: '', mode: { kind: 'list' } }, []);
      if (done === 'submit') return settle({ ...state, filter: value, mode: { kind: 'list' } }, []);
      return settle({ ...state, filter: inputValue(input), mode: { ...mode, input } }, []);
    case 'send': {
      if (done === 'cancel') return { state: withStatus({ ...state, mode: { kind: 'list' } }, 'send cancelled'), effects: [] };
      if (done === 'submit') {
        const row = state.sessions.find((entry) => sessionKey(entry) === mode.target);
        const next = { ...state, mode: { kind: 'list' } as Mode };
        if (!row) return { state: withStatus(next, 'that session is gone', 'error'), effects: [] };
        return { state: next, effects: [{ type: 'send', row, text: inputValue(input) }] };
      }
      return { state: { ...state, mode: { ...mode, input } }, effects: [] };
    }
    case 'newName':
      if (done === 'cancel') return { state: { ...state, mode: { kind: 'list' } }, effects: [] };
      if (done === 'submit') {
        if (!value) return { state: withStatus(state, 'a session needs a name', 'error'), effects: [] };
        if (/\s/.test(value)) return { state: withStatus(state, 'session names cannot contain spaces', 'error'), effects: [] };
        return { state: { ...state, mode: { kind: 'newCwd', name: value, input: lineInput(mode.cwd) } }, effects: [] };
      }
      return { state: { ...state, mode: { ...mode, input } }, effects: [] };
    case 'newCwd':
      if (done === 'cancel') return { state: { ...state, mode: { kind: 'list' } }, effects: [] };
      if (done === 'submit') {
        return {
          state: { ...state, mode: { kind: 'newEngine', name: mode.name, cwd: value, cursor: defaultEngineCursor(state) } },
          effects: [],
        };
      }
      return { state: { ...state, mode: { ...mode, input } }, effects: [] };
    case 'newEngineText':
      if (done === 'cancel') {
        return { state: { ...state, mode: { kind: 'newEngine', name: mode.name, cwd: mode.cwd, cursor: 0 } }, effects: [] };
      }
      if (done === 'submit') {
        return {
          state: { ...state, mode: { kind: 'list' } },
          effects: [{ type: 'create', name: mode.name, cwd: mode.cwd || null, engine: value || null, attach: true }],
        };
      }
      return { state: { ...state, mode: { ...mode, input } }, effects: [] };
  }
}

export function reduce(state: TuiState, action: Action): Result {
  const mode = state.mode;
  switch (action.type) {
    case 'move':
      return settle(moveBy(state, action.delta), []);
    case 'page': {
      const step = Math.max(1, layout(state).listHeight - 2);
      return settle(moveBy(state, action.dir * step), []);
    }
    case 'moveTo':
      return settle(moveBy(state, action.where === 'top' ? -1e9 : 1e9), []);
    case 'attach': {
      const row = selectedSession(state);
      if (!row) return { state: withStatus(state, 'no session selected — n starts one', 'error'), effects: [] };
      return { state, effects: [{ type: 'attach', row }] };
    }
    case 'togglePreview': {
      if (state.preview) return settle({ ...state, preview: null }, []);
      const row = selectedSession(state);
      if (!row) return { state: withStatus(state, 'no session selected', 'error'), effects: [] };
      return {
        state: { ...state, preview: { key: sessionKey(row), full: false, text: null, error: null, loading: true } },
        effects: [{ type: 'capture', row }],
      };
    }
    case 'togglePreviewFull': {
      if (!state.preview) {
        const opened = reduce(state, { type: 'togglePreview' });
        if (!opened.state.preview) return opened;
        return settle({ ...opened.state, preview: { ...opened.state.preview, full: true } }, opened.effects);
      }
      return settle({ ...state, preview: { ...state.preview, full: !state.preview.full } }, []);
    }
    case 'startSend': {
      const row = selectedSession(state);
      if (!row) return { state: withStatus(state, 'no session selected', 'error'), effects: [] };
      return { state: { ...state, mode: { kind: 'send', target: sessionKey(row), label: row.name, input: lineInput() } }, effects: [] };
    }
    case 'startNew': {
      const item = selectedItem(state);
      const cwd = item?.kind === 'session' ? item.row.workspace ?? '' : item?.kind === 'group' ? item.path : '';
      return {
        state: { ...state, mode: { kind: 'newName', input: lineInput(), cwd } },
        effects: state.engines ? [] : [{ type: 'loadEngines' }],
      };
    }
    case 'startKill': {
      const row = selectedSession(state);
      if (!row) return { state: withStatus(state, 'no session selected', 'error'), effects: [] };
      return { state: { ...state, mode: { kind: 'confirmKill', target: sessionKey(row), label: row.name } }, effects: [] };
    }
    case 'startFilter':
      return { state: { ...state, mode: { kind: 'filter', input: lineInput(state.filter), previous: state.filter } }, effects: [] };
    case 'openHosts':
      return { state: { ...state, mode: { kind: 'hosts', cursor: hostChoiceIndex(state) } }, effects: [{ type: 'loadHosts' }] };
    case 'openHelp':
      return { state: { ...state, mode: { kind: 'help' } }, effects: [] };
    case 'toggleEmpty': {
      const showEmpty = !state.showEmpty;
      const next = withStatus({ ...state, showEmpty }, showEmpty ? 'showing workspaces without sessions' : 'hiding empty workspaces');
      return settle(next, showEmpty ? [{ type: 'refresh' }] : []);
    }
    case 'refresh':
      return { state, effects: [{ type: 'refresh' }] };
    case 'escape':
      if (state.preview) return settle({ ...state, preview: null }, []);
      if (state.filter) return settle({ ...state, filter: '' }, []);
      return { state, effects: [] };
    case 'closeOverlay':
      return { state: { ...state, mode: { kind: 'list' } }, effects: [] };
    case 'quit':
      return { state, effects: [{ type: 'quit' }] };
    case 'redraw':
      return { state, effects: [{ type: 'redraw' }] };
    case 'input':
      return onInput(state, action.key);
    case 'pickerMove': {
      if (mode.kind === 'hosts') {
        const count = state.hosts?.length ?? 0;
        if (count === 0) return { state, effects: [] };
        const cursor = Math.max(0, Math.min(count - 1, mode.cursor + action.delta));
        return { state: { ...state, mode: { ...mode, cursor } }, effects: [] };
      }
      if (mode.kind === 'newEngine') {
        const count = engineOptions(state).length;
        const cursor = Math.max(0, Math.min(count - 1, mode.cursor + action.delta));
        return { state: { ...state, mode: { ...mode, cursor } }, effects: [] };
      }
      return { state, effects: [] };
    }
    case 'pick': {
      if (mode.kind === 'hosts') {
        const host = state.hosts?.[mode.cursor];
        const next = { ...state, mode: { kind: 'list' } as Mode };
        if (!host) return { state: next, effects: [] };
        if (host.name === state.hostName) return { state: next, effects: [{ type: 'refresh' }] };
        return { state: withStatus(next, `connecting to ${host.name}…`), effects: [{ type: 'switchHost', name: host.name }] };
      }
      if (mode.kind === 'newEngine') {
        const option = engineOptions(state)[mode.cursor];
        if (!option) return { state, effects: [] };
        if (option.other) {
          return { state: { ...state, mode: { kind: 'newEngineText', name: mode.name, cwd: mode.cwd, input: lineInput() } }, effects: [] };
        }
        return {
          state: { ...state, mode: { kind: 'list' } },
          effects: [{ type: 'create', name: mode.name, cwd: mode.cwd || null, engine: option.id, attach: action.attach }],
        };
      }
      return { state, effects: [] };
    }
    case 'confirm': {
      if (mode.kind !== 'confirmKill') return { state, effects: [] };
      const next = { ...state, mode: { kind: 'list' } as Mode };
      if (!action.yes) return { state: withStatus(next, 'kill cancelled'), effects: [] };
      const row = state.sessions.find((entry) => sessionKey(entry) === mode.target);
      if (!row) return { state: withStatus(next, 'that session is already gone', 'error'), effects: [] };
      return { state: next, effects: [{ type: 'kill', row }] };
    }
    case 'resize':
      return settle({ ...state, width: Math.max(1, action.width), height: Math.max(1, action.height) }, []);
    case 'tick':
      return { state: { ...state, now: action.now, spinner: state.refreshing || state.busy ? state.spinner + 1 : state.spinner }, effects: [] };
    case 'refreshStarted':
      if (action.generation !== state.generation) return { state, effects: [] };
      return { state: { ...state, refreshing: true }, effects: [] };
    case 'refreshDone': {
      if (action.generation !== state.generation) return { state, effects: [] };
      const next: TuiState = {
        ...state,
        sessions: action.sessions.map(displayRow),
        listErrors: action.errors.map(safeLine),
        workspaces: action.workspaces ? action.workspaces.map(displayWorkspace) : state.workspaces,
        loaded: true,
        loadError: null,
        refreshing: false,
        now: action.now,
      };
      return settle(next, []);
    }
    case 'refreshFailed': {
      if (action.generation !== state.generation) return { state, effects: [] };
      const message = safeLine(action.message);
      const next = { ...state, refreshing: false, loadError: message };
      // Before the first good list the body shows the error; after, the status line does (over the last good data).
      const same = state.status?.kind === 'error' && state.status.text === message;
      return { state: same || !state.loaded ? next : withStatus(next, message, 'error'), effects: [] };
    }
    case 'enginesLoaded': {
      let next: TuiState = { ...state, engines: action.engines.map(displayEngine), enginesError: null };
      if (mode.kind === 'newEngine' && mode.cursor === 0) next = { ...next, mode: { ...mode, cursor: defaultEngineCursor(next) } };
      return { state: next, effects: [] };
    }
    case 'enginesFailed':
      return { state: { ...state, enginesError: safeLine(action.message) }, effects: [] };
    case 'hostsLoaded': {
      const hosts = action.hosts.map((host) => ({ ...host, name: safeLine(host.name) }));
      const next = { ...state, hosts, hostsError: null };
      if (mode.kind === 'hosts') return { state: { ...next, mode: { ...mode, cursor: hostChoiceIndex(next) } }, effects: [] };
      return { state: next, effects: [] };
    }
    case 'hostsFailed':
      return { state: { ...state, hostsError: safeLine(action.message) }, effects: [] };
    case 'captured':
      if (!state.preview || state.preview.key !== action.key) return { state, effects: [] };
      return { state: { ...state, preview: { ...state.preview, text: safeText(action.text), error: null, loading: false } }, effects: [] };
    case 'captureFailed':
      if (!state.preview || state.preview.key !== action.key) return { state, effects: [] };
      return { state: { ...state, preview: { ...state.preview, error: safeLine(action.message), loading: false } }, effects: [] };
    case 'busy':
      return { state: { ...state, busy: action.text === null ? null : safeLine(action.text) }, effects: [] };
    case 'opDone': {
      let next = withStatus({ ...state, busy: null }, action.text, 'ok');
      if (action.selectKey) next = { ...next, selectedKey: action.selectKey, pendingSelect: action.selectKey };
      return settle(next, []);
    }
    case 'opFailed':
      return { state: withStatus({ ...state, busy: null }, action.text, 'error'), effects: [] };
    case 'hostSwitched': {
      const next: TuiState = {
        ...state,
        hostName: safeLine(action.name),
        hostMode: action.mode,
        loggedIn: action.loggedIn,
        home: action.home,
        generation: state.generation + 1,
        sessions: [],
        listErrors: [],
        workspaces: null,
        loaded: false,
        loadError: null,
        refreshing: false,
        engines: null,
        enginesError: null,
        selectedKey: null,
        selectedIndex: 0,
        pendingSelect: null,
        scroll: 0,
        preview: null,
        filter: '',
        mode: { kind: 'list' },
        busy: null,
      };
      return settle(withStatus(next, `switched to ${next.hostName}`, 'ok'), [{ type: 'refresh' }]);
    }
    case 'loggedIn':
      return { state: { ...state, loggedIn: action.value }, effects: [] };
    case 'clearStatus':
      if (state.status?.seq !== action.seq) return { state, effects: [] };
      return { state: { ...state, status: null }, effects: [] };
  }
}

/** One line, never a stack trace: what a person should read about a failure. */
export function describeError(error: unknown): string {
  const message = safeLine((error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' · ')).trim();
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'NOT_LOGGED_IN') {
    return /login/.test(message) ? message : `not logged in — run \`pocketshell-tui-client login\` (${message})`;
  }
  if (code === 'NOT_PINNED' && !/pin/i.test(message)) return `host key not pinned: ${message}`;
  return message || 'unknown error';
}
