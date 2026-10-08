import { EventEmitter } from 'node:events';
import type { SessionRow } from '@pocketshell/core';
import { describe, expect, it } from 'vitest';
import { App } from '../src/tui/index.js';
import { render, renderPlain } from '../src/tui/render.js';
import { describeError, hostRow, reduce, type TuiState } from '../src/tui/state.js';
import { parseKeys } from '../src/tui/keys.js';
import { sanitize } from '../src/tui/text.js';
import { apply, base, NOW, row } from './tuiFixtures.js';

// Host text that tries to retitle the window (OSC 0), clear and home the
// screen (CSI 2J / CSI H), reorder the line (bidi override) and hide text
// (zero-width), in every field the TUI shows.
const RAW_NAME = 'evil:\x1b]0;pwned\x07tag\x1b[2J\x1b[H';
const HOSTILE: SessionRow = row('evil:tag', {
  name: RAW_NAME,
  id: null,
  tag: '\x1b]0;owned\x07x‮evil⁦​',
  workspace: '/home/u/git/ws\nline2\x1b[2J',
  agent: null,
  engine: '\x1b[31mred\x1b[0m',
  agentState: null,
  phase: 'dying\x1b[H',
});
const HOSTILE_ERROR = new Error('`a capture` failed: \x1b[2Jboom\nmore \x1b]0;t\x07‮done');
const ENGINE = {
  id: 'claude',
  label: '\x1b]0;e\x07Claude​\x1b[2J',
  family: 'claude',
  harness: 'claude',
  providerMark: '',
  usageProvider: null,
  enabled: true,
  available: true,
  availableForCreate: true,
  unavailableReason: null,
};

const typeText = (state: TuiState, text: string) =>
  parseKeys(text).reduce((s, key) => reduce(s, { type: 'input', key }).state, state);

function hostileState(): TuiState {
  return apply(base(), {
    type: 'refreshDone',
    generation: 0,
    sessions: [HOSTILE],
    errors: ['\x1b]0;list\x07partial\x1b[2J'],
    workspaces: [{ path: '/srv/\x1b[Hempty', displayPath: '\x1b]0;w\x07empty' }],
    now: NOW,
  });
}

/** Every frame a hostile host can reach: list, preview, prompts, pickers, error lines. */
function hostileFrames(): TuiState[] {
  const listed = hostileState();
  const withEmpty = apply(listed, { type: 'toggleEmpty' });
  const opened = apply(listed, { type: 'togglePreview' });
  const preview = apply(opened, { type: 'captured', key: opened.preview!.key, text: 'ok\x1b]0;cap\x07 line\r\n\x1b[2J\x1b[Hsecond\u202e\tend' });
  const captureFailed = apply(listed, { type: 'togglePreview' }, { type: 'captureFailed', key: preview.preview!.key, message: describeError(HOSTILE_ERROR) });
  const status = apply(listed, { type: 'opFailed', text: describeError(HOSTILE_ERROR) });
  const rawStatus = apply(listed, { type: 'opFailed', text: 'raw \x1b]0;x\x07 \x1b[2J' });
  const refreshFailed = apply(listed, { type: 'refreshFailed', generation: 0, message: 'stderr \x1b[2J\x1b]0;t\x07' });
  const neverLoaded = apply(base(), { type: 'refreshFailed', generation: 0, message: 'cannot \x1b]0;t\x07\x1b[2J connect' });
  const kill = apply(listed, { type: 'startKill' });
  const send = apply(listed, { type: 'startSend' });
  const engines = apply(typeText(apply(listed, { type: 'startNew' }), 'new\r\r'), { type: 'enginesLoaded', engines: [ENGINE] });
  const enginesFailed = apply(listed, { type: 'enginesFailed', message: 'no \x1b[2J engines' });
  const hosts = apply(listed, { type: 'openHosts' }, { type: 'hostsLoaded', hosts: [{ name: 'box\x1b]0;h\x07', mode: 'ssh' }] });
  return [listed, withEmpty, preview, captureFailed, status, rawStatus, refreshFailed, neverLoaded, kill, send, engines, enginesFailed, hosts];
}

const OWN_SGR = /\x1b\[[0-9;]*m/g;

describe('hostile host text', () => {
  it('the shared scrub drops escapes, controls, bidi and zero-width characters', () => {
    expect(sanitize('a\x1b]0;title\x07b\x1b[2Jc‮d⁦e​f\tg\nh\x9bi')).toBe('abcdef  g hi');
  });

  it('never reaches the terminal as control: no OSC, no CSI J/H, only the TUI own SGR', () => {
    const frames = hostileFrames();
    for (const state of frames) {
      for (const mode of ['full', 'mono', 'none'] as const) {
        const ansi = render(state, mode).join('\n');
        expect(ansi).not.toContain('\x1b]');
        expect(ansi).not.toMatch(/\x1b\[[0-9;]*[JH]/);
        expect(ansi.replace(OWN_SGR, '')).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f​-‏‪-‮⁠-⁩﻿]/);
      }
      const plain = renderPlain(state).join('\n');
      expect(plain).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f​-‏‪-‮⁠-⁩﻿]/);
      expect(plain).not.toMatch(/pwned|owned|\]0;/);
    }
  });

  it('shows the printable remainder where the raw text was', () => {
    const [listed, withEmpty, preview, captureFailed, status, , , neverLoaded, kill, send, engines, , hosts] = hostileFrames();
    const text = (state: TuiState) => renderPlain(state).join('\n');
    expect(text(listed)).toContain('~/git/ws line2'); // workspace newline → space, one group line
    expect(text(listed)).toContain('xevil'); // tag
    expect(text(listed)).toContain('red'); // engine in the agent column
    expect(text(listed)).toContain('Some sessions may be missing: partial');
    expect(text(withEmpty)).toContain('/srv/empty');
    expect(text(preview)).toContain('preview · evil:tag');
    expect(text(preview)).toContain('ok line');
    expect(text(preview)).toContain('second  end');
    expect(text(captureFailed)).toContain('capture failed: `a capture` failed: boom · more done');
    expect(text(status)).toContain('`a capture` failed: boom · more done');
    expect(text(neverLoaded)).toContain('cannot connect');
    expect(text(kill)).toContain('kill evil:tag?');
    expect(text(send)).toContain('send → evil:tag');
    expect(engines.mode.kind).toBe('newEngine');
    expect(text(engines)).toContain('Claude');
    expect(text(hosts)).toContain('box');
  });

  it('commands still target the session exactly as the host named it', () => {
    const state = hostileState();
    const shown = state.sessions[0]!;
    expect(shown.name).toBe('evil:tag');
    expect(hostRow(shown)).toBe(HOSTILE);
    const attach = reduce(state, { type: 'attach' }).effects[0];
    expect(attach).toMatchObject({ type: 'attach', row: { name: 'evil:tag' } });
    expect(hostRow((attach as { row: SessionRow }).row).name).toBe(RAW_NAME);
    const kill = reduce(apply(state, { type: 'startKill' }), { type: 'confirm', yes: true }).effects[0] as { row: SessionRow };
    expect(hostRow(kill.row).name).toBe(RAW_NAME);
    // A clean row is passed through untouched.
    const clean = row('alpha:main');
    expect(apply(base(), { type: 'refreshDone', generation: 0, sessions: [clean], errors: [], workspaces: null, now: NOW }).sessions[0]).toBe(clean);
  });

  it('describeError scrubs host stderr', () => {
    expect(describeError(HOSTILE_ERROR)).toBe('`a capture` failed: boom · more done');
  });
});

// ── signals during attach ──────────────────────────────────────────────────

class FakeInput extends EventEmitter {
  isTTY = false;
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  setRawMode() {
    return this;
  }
}

function fakeApp(attach: () => Promise<number | null>) {
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: false,
    write(chunk: string) {
      writes.push(String(chunk));
      return true;
    },
  });
  const input = new FakeInput();
  const app = new App({ name: 'local', mode: 'local' }, input as never, output as never);
  const inner = app as unknown as { client: unknown; attachTerminal(): void; attach(row: SessionRow): Promise<void> };
  inner.client = { attach };
  inner.attachTerminal();
  return { app, inner, writes, input };
}

describe('SIGTERM / SIGHUP while attached', () => {
  it('outside an attach the signal handler exits right away', () => {
    const { app } = fakeApp(async () => 0);
    expect(app.terminate(143)).toBe(true);
    void app.finish(0);
  });

  it('defers to the child: nothing is written while it owns the tty, then the TUI quits with the signal code', async () => {
    let release!: (code: number) => void;
    const { app, inner, writes } = fakeApp(() => new Promise((resolve) => (release = resolve)));
    const attaching = inner.attach(row('alpha:main'));
    await Promise.resolve();
    const mark = writes.length;
    expect(writes.join('')).toContain('attaching to alpha:main');
    expect(app.terminate(143)).toBe(false);
    expect(app.terminate(129)).toBe(false); // first signal wins
    expect(writes.length).toBe(mark); // no restore sequence under the child
    release(0);
    await attaching;
    await expect(app.done).resolves.toBe(143);
    // Never re-entered the alternate screen, never drew a frame.
    expect(writes.slice(mark).join('')).not.toContain('\x1b[');
  });

  it('a hangup while waiting on "press any key" after a failed attach ends the wait', async () => {
    const { app, inner, writes } = fakeApp(async () => 1);
    const attaching = inner.attach(row('alpha:main'));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(writes.join('')).toContain('press any key');
    expect(app.terminate(129)).toBe(false);
    await attaching;
    await expect(app.done).resolves.toBe(129);
  });
});
