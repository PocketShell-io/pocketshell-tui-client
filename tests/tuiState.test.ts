import { describe, expect, it } from 'vitest';
import {
  abbreviatePath,
  describeError,
  engineOptions,
  reduce,
  selectedSession,
  visibleItems,
  type TuiState,
} from '../src/tui/state.js';
import { parseKeys } from '../src/tui/keys.js';
import { apply, loaded, NOW, row, SESSIONS } from './tuiFixtures.js';

const typeText = (state: TuiState, text: string) =>
  parseKeys(text).reduce((s, key) => reduce(s, { type: 'input', key }).state, state);

describe('grouping', () => {
  it('groups by workspace alphabetically, sessions by tag, no-workspace last', () => {
    const items = visibleItems(loaded());
    expect(items.map((item) => (item.kind === 'group' ? `[${item.label}]` : item.row.tag))).toEqual([
      '[~/git/alpha]',
      'fix-login',
      'review',
      '[~/git/beta]',
      'docs',
      '[~/git/zeta]',
      'main',
      '[(no workspace)]',
      'loose',
    ]);
    const alpha = items[0]!;
    expect(alpha.kind === 'group' && alpha.waiting).toBe(1);
  });

  it('folds trailing-slash spellings of one workspace into one group', () => {
    const state = loaded([row('a:x', { workspace: '/w/a/' }), row('a:y', { workspace: '/w/a' })]);
    expect(visibleItems(state).filter((item) => item.kind === 'group')).toHaveLength(1);
  });

  it('shows empty workspaces only when toggled on', () => {
    let state = loaded([row('a:x', { workspace: '/w/a' })]);
    state = apply(state, {
      type: 'refreshDone',
      generation: 0,
      sessions: state.sessions,
      errors: [],
      workspaces: [{ path: '/w/a', displayPath: '/w/a' }, { path: '/w/empty', displayPath: '/w/empty' }],
      now: NOW,
    });
    expect(visibleItems(state).filter((item) => item.kind === 'group')).toHaveLength(1);
    const on = reduce(state, { type: 'toggleEmpty' });
    expect(on.effects).toEqual([{ type: 'refresh' }]);
    const groups = visibleItems(on.state).filter((item) => item.kind === 'group');
    expect(groups.map((g) => g.kind === 'group' && g.empty)).toEqual([false, true]);
    // An empty workspace is selectable, and `n` defaults to its path.
    const atEmpty = apply(on.state, { type: 'moveTo', where: 'bottom' });
    expect(atEmpty.selectedKey).toBe('ws:/w/empty');
    const started = reduce(atEmpty, { type: 'startNew' }).state;
    expect(started.mode).toMatchObject({ kind: 'newName', cwd: '/w/empty' });
  });

  it('abbreviates the home directory', () => {
    expect(abbreviatePath('/home/u/git/x', '/home/u')).toBe('~/git/x');
    expect(abbreviatePath('/home/u', '/home/u/')).toBe('~');
    expect(abbreviatePath('/opt/x', '/home/u')).toBe('/opt/x');
    expect(abbreviatePath('/Users/me/src', null)).toBe('~/src');
    expect(abbreviatePath('', null)).toBe('(no workspace)');
  });
});

describe('cursor', () => {
  it('starts on the first session and skips group headers', () => {
    const state = loaded();
    expect(selectedSession(state)?.name).toBe('alpha:fix-login');
    const next = apply(state, { type: 'move', delta: 1 }, { type: 'move', delta: 1 });
    expect(selectedSession(next)?.name).toBe('beta:docs');
  });

  it('clamps at both ends', () => {
    const state = loaded();
    expect(selectedSession(apply(state, { type: 'move', delta: -5 }))?.name).toBe('alpha:fix-login');
    expect(selectedSession(apply(state, { type: 'move', delta: 99 }))?.name).toBe('loose');
    expect(selectedSession(apply(state, { type: 'moveTo', where: 'bottom' }, { type: 'move', delta: 1 }))?.name).toBe('loose');
    expect(selectedSession(apply(state, { type: 'moveTo', where: 'bottom' }, { type: 'moveTo', where: 'top' }))?.name).toBe(
      'alpha:fix-login',
    );
  });

  it('keeps the same session selected across a refresh that reorders rows', () => {
    let state = apply(loaded(), { type: 'move', delta: 3 });
    expect(selectedSession(state)?.name).toBe('zeta:main');
    state = apply(state, {
      type: 'refreshDone',
      generation: 0,
      sessions: [row('aaa:new'), ...SESSIONS],
      errors: [],
      workspaces: null,
      now: NOW,
    });
    expect(selectedSession(state)?.name).toBe('zeta:main');
  });

  it('falls back to the same position when the selected session disappears', () => {
    let state = apply(loaded(), { type: 'move', delta: 1 });
    expect(selectedSession(state)?.name).toBe('alpha:review');
    state = apply(state, {
      type: 'refreshDone',
      generation: 0,
      sessions: SESSIONS.filter((r) => r.name !== 'alpha:review'),
      errors: [],
      workspaces: null,
      now: NOW,
    });
    expect(selectedSession(state)?.name).toBe('beta:docs');
  });

  it('selects a just-created session once a refresh brings it in', () => {
    let state = apply(loaded(), { type: 'opDone', text: 'created x', selectKey: 'id:id-new:one' });
    expect(selectedSession(state)?.name).toBe('alpha:fix-login');
    state = apply(state, {
      type: 'refreshDone',
      generation: 0,
      sessions: [...SESSIONS, row('new:one')],
      errors: [],
      workspaces: null,
      now: NOW,
    });
    expect(selectedSession(state)?.name).toBe('new:one');
  });

  it('scrolls to keep the cursor and its group header visible', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`ws${String(i).padStart(2, '0')}:t`));
    let state = loaded(many, 80, 12); // body = 8 rows
    state = apply(state, { type: 'moveTo', where: 'bottom' });
    const items = visibleItems(state);
    const index = items.findIndex((item) => item.key === state.selectedKey);
    expect(index).toBe(items.length - 1);
    expect(state.scroll).toBe(items.length - 8);
    state = apply(state, { type: 'moveTo', where: 'top' });
    expect(state.scroll).toBe(0);
    state = apply(state, { type: 'page', dir: 1 });
    expect(state.scroll).toBeGreaterThan(0);
  });

  it('drops results from a previous host generation', () => {
    const state = apply(loaded(), { type: 'hostSwitched', name: 'other', mode: 'ssh', loggedIn: null, home: null });
    expect(state.generation).toBe(1);
    const stale = apply(state, { type: 'refreshDone', generation: 0, sessions: SESSIONS, errors: [], workspaces: null, now: NOW });
    expect(stale.sessions).toEqual([]);
    expect(stale.loaded).toBe(false);
  });
});

describe('filter', () => {
  it('filters live while typing and keeps it on Enter', () => {
    let state = reduce(loaded(), { type: 'startFilter' }).state;
    state = typeText(state, 'wait');
    expect(state.filter).toBe('wait');
    expect(visibleItems(state).filter((item) => item.kind === 'session').map((item) => item.key)).toEqual(['id:id-alpha:review']);
    state = typeText(state, '\r');
    expect(state.mode.kind).toBe('list');
    expect(state.filter).toBe('wait');
    expect(selectedSession(state)?.name).toBe('alpha:review');
    // Esc in the list clears it.
    state = apply(state, { type: 'escape' });
    expect(state.filter).toBe('');
  });

  it('matches name, agent, engine and state case-insensitively', () => {
    const shown = (filter: string) =>
      visibleItems({ ...loaded(), filter }).filter((item) => item.kind === 'session').length;
    expect(shown('CODEX')).toBe(1);
    expect(shown('grok')).toBe(1);
    expect(shown('alpha')).toBe(2);
    expect(shown('exiting')).toBe(1);
    expect(shown('nothing-matches')).toBe(0);
  });

  it('Esc while typing cancels the filter', () => {
    let state = reduce(loaded(), { type: 'startFilter' }).state;
    state = typeText(state, 'zeta\x1b');
    expect(state.filter).toBe('');
    expect(state.mode.kind).toBe('list');
  });
});

describe('actions → effects', () => {
  it('attach targets the selected session', () => {
    const { effects } = reduce(loaded(), { type: 'attach' });
    expect(effects).toEqual([{ type: 'attach', row: expect.objectContaining({ name: 'alpha:fix-login' }) }]);
  });

  it('send: prompt, then a send effect with the typed text', () => {
    let state = reduce(loaded(), { type: 'startSend' }).state;
    expect(state.mode).toMatchObject({ kind: 'send', label: 'alpha:fix-login' });
    state = typeText(state, 'run the tests');
    const result = reduce(state, { type: 'input', key: { name: 'enter' } });
    expect(result.state.mode.kind).toBe('list');
    expect(result.effects).toEqual([
      { type: 'send', row: expect.objectContaining({ name: 'alpha:fix-login' }), text: 'run the tests' },
    ]);
  });

  it('kill asks first; only y kills', () => {
    const asking = reduce(loaded(), { type: 'startKill' }).state;
    expect(asking.mode).toMatchObject({ kind: 'confirmKill', label: 'alpha:fix-login' });
    expect(reduce(asking, { type: 'confirm', yes: false }).effects).toEqual([]);
    expect(reduce(asking, { type: 'confirm', yes: true }).effects).toEqual([
      { type: 'kill', row: expect.objectContaining({ name: 'alpha:fix-login' }) },
    ]);
  });

  it('new session: name → directory (default: the workspace) → engine', () => {
    let result = reduce(loaded(), { type: 'startNew' });
    expect(result.effects).toEqual([{ type: 'loadEngines' }]);
    let state = typeText(result.state, 'hot fix\r');
    expect(state.status?.kind).toBe('error'); // spaces rejected
    state = typeText(state, '\x08\x08\x08\x08-fix\r');
    expect(state.mode).toMatchObject({ kind: 'newCwd', name: 'hot-fix' });
    state = typeText(state, '\r');
    expect(state.mode).toMatchObject({ kind: 'newEngine', name: 'hot-fix', cwd: '/home/u/git/alpha' });
    state = apply(state, {
      type: 'enginesLoaded',
      engines: [
        { id: 'claude', label: 'Claude', family: 'claude', harness: 'claude', providerMark: '', usageProvider: null, enabled: true, available: true, availableForCreate: true, unavailableReason: null },
        { id: 'off', label: 'Off', family: 'x', harness: 'x', providerMark: '', usageProvider: null, enabled: false, available: false, availableForCreate: false, unavailableReason: 'no' },
      ],
    });
    expect(engineOptions(state).map((o) => o.label)).toEqual(['shell (no agent)', 'Claude', 'other… (type an engine id)']);
    result = reduce(state, { type: 'pick', attach: false });
    expect(result.effects).toEqual([{ type: 'create', name: 'hot-fix', cwd: '/home/u/git/alpha', engine: 'claude', attach: false }]);
    // "other…" goes to free text.
    state = apply(state, { type: 'pickerMove', delta: 10 }, { type: 'pick', attach: true });
    expect(state.mode.kind).toBe('newEngineText');
    state = typeText(state, 'zcodex');
    expect(reduce(state, { type: 'input', key: { name: 'enter' } }).effects).toEqual([
      { type: 'create', name: 'hot-fix', cwd: '/home/u/git/alpha', engine: 'zcodex', attach: true },
    ]);
  });

  it('preview opens with a capture and follows the selection', () => {
    const opened = reduce(loaded(), { type: 'togglePreview' });
    expect(opened.effects).toEqual([{ type: 'capture', row: expect.objectContaining({ name: 'alpha:fix-login' }) }]);
    const moved = reduce(opened.state, { type: 'move', delta: 1 });
    expect(moved.state.preview?.key).toBe('id:id-alpha:review');
    expect(moved.effects).toEqual([{ type: 'capture', row: expect.objectContaining({ name: 'alpha:review' }) }]);
    // A capture for a session no longer previewed is ignored.
    const late = apply(moved.state, { type: 'captured', key: 'id:id-alpha:fix-login', text: 'old' });
    expect(late.preview?.text).toBeNull();
    const fresh = apply(moved.state, { type: 'captured', key: 'id:id-alpha:review', text: 'hello' });
    expect(fresh.preview?.text).toBe('hello');
    expect(apply(fresh, { type: 'escape' }).preview).toBeNull();
  });

  it('host switch picks from the list and resets the view', () => {
    let state = reduce(loaded(), { type: 'openHosts' }).state;
    state = apply(state, { type: 'hostsLoaded', hosts: [{ name: 'local', mode: 'local' }, { name: 'box', mode: 'ssh' }] });
    expect(state.mode).toMatchObject({ kind: 'hosts', cursor: 0 });
    const picked = reduce(apply(state, { type: 'pickerMove', delta: 1 }), { type: 'pick', attach: true });
    expect(picked.effects).toEqual([{ type: 'switchHost', name: 'box' }]);
    const switched = reduce(picked.state, { type: 'hostSwitched', name: 'box', mode: 'ssh', loggedIn: null, home: null });
    expect(switched.effects).toEqual([{ type: 'refresh' }]);
    expect(switched.state).toMatchObject({ hostName: 'box', sessions: [], loaded: false, generation: 1 });
  });

  it('a refresh failure keeps the last good data', () => {
    const state = apply(loaded(), { type: 'refreshFailed', generation: 0, message: 'ssh: timed out' });
    expect(state.sessions).toHaveLength(SESSIONS.length);
    expect(state.status).toMatchObject({ kind: 'error', text: 'ssh: timed out' });
  });

  it('describes connection errors with their hints', () => {
    const err = Object.assign(new Error('no session'), { code: 'NOT_LOGGED_IN' });
    expect(describeError(err)).toContain('pocketshell-client login');
    expect(describeError(new Error('line one\nline two'))).toBe('line one · line two');
  });
});
