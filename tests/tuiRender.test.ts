import { describe, expect, it } from 'vitest';
import { render, renderPlain, rowColumns } from '../src/tui/render.js';
import { reduce } from '../src/tui/state.js';
import { textWidth } from '../src/tui/text.js';
import { apply, base, loaded, row } from './tuiFixtures.js';

const assertFrame = (lines: string[], width: number, height: number) => {
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(textWidth(line)).toBe(width);
};

const trimmed = (lines: string[]) => lines.map((line) => line.replace(/\s+$/, ''));

describe('render', () => {
  it('80x24 session list', () => {
    const frame = renderPlain(loaded());
    assertFrame(frame, 80, 24);
    expect(trimmed(frame)).toMatchInlineSnapshot(`
      [
        " PocketShell · local (local) · 5 sessions · 1 waiting",
        "────────────────────────────────────────────────────────────────────────────────",
        "▾ ~/git/alpha  2 · 1 waiting",
        "› ● fix-login    claude      working   5s",
        "    review       claude      waiting   2m",
        "▾ ~/git/beta  1",
        "    docs         grok        idle      2h",
        "▾ ~/git/zeta  1",
        "    main         codex       working   2s",
        "▾ (no workspace)  1",
        "    loose                    exiting    -",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        " ↵ attach  p preview  s send  n new  x kill  / filter  h hosts  ? help  q quit",
      ]
    `);
  });

  it('40x12 truncates, drops the agent column, and shows a scroll hint', () => {
    const sessions = [
      row('a-very-long-workspace-name-that-goes-on:an-extremely-long-session-tag', { agentState: 'waiting' }),
      ...Array.from({ length: 8 }, (_, i) => row(`w:t${i}`)),
    ];
    const frame = renderPlain(loaded(sessions, 40, 12));
    assertFrame(frame, 40, 12);
    expect(trimmed(frame)).toMatchInlineSnapshot(`
      [
        " PocketShell · local (local) · 9 sessio…",
        "────────────────────────────────────────",
        "▾ …pace-name-that-goes-on  1 · 1 waiting",
        "›   an-extremely-long-sess… waiting  30s",
        "▾ ~/git/w  8",
        "    t0                      idle     30s",
        "    t1                      idle     30s",
        "    t2                      idle     30s",
        "    t3                      idle     30s",
        "  ↓ 3 more",
        "",
        " ↵ attach  p preview  s send  n new",
      ]
    `);
  });

  it('empty, loading and error states', () => {
    const loading = renderPlain(base(40, 12));
    assertFrame(loading, 40, 12);
    expect(loading.some((line) => line.includes('loading sessions from local…'))).toBe(true);

    const empty = renderPlain(loaded([], 40, 12));
    expect(empty.some((line) => line.includes('no sessions on local'))).toBe(true);
    expect(empty.some((line) => line.includes('press n to start one'))).toBe(true);

    const failed = renderPlain(
      apply(base(60, 14), {
        type: 'refreshFailed',
        generation: 0,
        message: 'not logged in: run `pocketshell-client login` and then try this host again please',
      }),
    );
    assertFrame(failed, 60, 14);
    expect(trimmed(failed).filter(Boolean)).toMatchInlineSnapshot(`
      [
        " PocketShell · local (local)",
        "────────────────────────────────────────────────────────────",
        "                     cannot reach local",
        "   not logged in: run \`pocketshell-client login\` and then",
        "                 try this host again please",
        "           h switches host · r retries · q quits",
        " ↵ attach  p preview  s send  n new  x kill  / filter",
      ]
    `);

    const noMatch = renderPlain({ ...loaded(), filter: 'zzz' });
    expect(noMatch.some((line) => line.includes('no sessions match "zzz"'))).toBe(true);
    expect(noMatch[1]).toContain('filter "zzz" · 0 of 5');
  });

  it('stale data stays on screen with the error on the status line', () => {
    const state = apply(loaded(), { type: 'refreshFailed', generation: 0, message: 'connection lost' });
    const frame = renderPlain(state);
    expect(frame[3]).toContain('fix-login');
    expect(frame[22]).toContain('connection lost');
  });

  it('inline prompts take the status line', () => {
    let state = reduce(loaded(), { type: 'startSend' }).state;
    state = reduce(state, { type: 'input', key: { name: 'char', ch: 'h' } }).state;
    const frame = renderPlain(state);
    expect(frame[22]).toMatch(/^ send → alpha:fix-login: h {2}/);
    expect(frame[23]).toContain('↵ send + Enter');
    const kill = renderPlain(reduce(loaded(), { type: 'startKill' }).state);
    expect(kill[22]).toContain('kill alpha:fix-login? [y/N]');
  });

  it('help overlay is a box over the list', () => {
    const frame = renderPlain(reduce(loaded(), { type: 'openHelp' }).state);
    assertFrame(frame, 80, 24);
    expect(frame.some((line) => line.includes('┌─ keys'))).toBe(true);
    expect(frame.some((line) => line.includes('attach (Ctrl-b d detaches)'))).toBe(true);
    const small = renderPlain({ ...reduce(loaded(), { type: 'openHelp' }).state, width: 40, height: 12 });
    assertFrame(small, 40, 12);
    expect(small.some((line) => line.includes('more (enlarge the terminal)'))).toBe(true);
  });

  it('preview pane shows the bottom of the captured screen', () => {
    let state = reduce(loaded(), { type: 'togglePreview' }).state;
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n\n\n';
    state = apply(state, { type: 'captured', key: state.preview!.key, text });
    const frame = renderPlain(state);
    assertFrame(frame, 80, 24);
    const title = frame.findIndex((line) => line.includes('preview · alpha:fix-login'));
    expect(title).toBeGreaterThan(2);
    expect(frame[21]!.trim()).toBe('line 39');
    const full = renderPlain(apply(state, { type: 'togglePreviewFull' }));
    expect(full[2]).toContain('preview · alpha:fix-login');
  });

  it('colors waiting and working distinctly; NO_COLOR keeps only attributes', () => {
    const color = render(loaded(), 'full');
    expect(color[4]).toContain('\x1b[1;36m waiting');
    expect(color[3]).toContain('\x1b[33;7m working'); // selected row: inverted
    const mono = render(loaded(), 'mono').join('\n');
    expect(mono).not.toMatch(/\x1b\[(3[0-7]|1;3[0-7])/);
    expect(mono).toContain('\x1b[7m');
  });

  it('column plan narrows gracefully', () => {
    expect(rowColumns(80)).toMatchObject({ agent: 11, age: 4 });
    expect(rowColumns(40)).toMatchObject({ agent: 0, age: 4 });
    expect(rowColumns(20)).toMatchObject({ agent: 0, age: 0 });
    expect(rowColumns(200, 10).tag).toBe(12);
  });

  it('survives absurdly small terminals', () => {
    for (const [w, h] of [
      [1, 1],
      [5, 3],
      [12, 5],
    ] as const) {
      const frame = renderPlain(loaded(undefined, w, h));
      expect(frame.length).toBeLessThanOrEqual(h);
      for (const line of frame) expect(textWidth(line)).toBeLessThanOrEqual(w);
    }
  });
});
