import { describe, expect, it } from 'vitest';
import { agentScreen, screenModel, submitWithScreen } from '../src/screenModels.js';
import { frameForPaste } from '../src/hostClient.js';

const trust = `Accessing workspace:\n/tmp/project\nDo you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n↑/↓ Navigate · enter Confirm`;
const idle = 'Antigravity CLI 1.4.2\n────────────────\n> \n────────────────\n? for shortcuts     Gemini 3.8 Flash · high';

describe('engine screen models', () => {
  it.each(['flash', 'argon', 'antigravity', 'agy'])('recognizes %s as Antigravity', (engine) => {
    expect(screenModel(engine)).toBe('antigravity');
    expect(agentScreen(screenModel(engine)!, idle)).toMatchObject({ ready: true, busy: false, input: '' });
  });
  it('recognizes Codex Orin and its input and busy indicator', () => {
    expect(screenModel('codex-orin')).toBe('codex');
    expect(agentScreen('codex', 'OpenAI Codex\n› Ask Codex to do anything\n? for shortcuts')).toMatchObject({ ready: true });
    expect(agentScreen('codex', 'Working (esc to interrupt)\n› ')).toMatchObject({ ready: false, busy: true });
    expect(screenModel('unknown')).toBeNull();
  });
  it('recognizes the live Antigravity trust dialog without treating its selection as an input', () => {
    expect(agentScreen('antigravity', trust)).toMatchObject({ ready: false, trustKeys: '\r', input: null });
    expect(agentScreen('antigravity', 'Loading Antigravity...')).toMatchObject({ ready: false });
    expect(agentScreen('antigravity', 'Do you want to allow this command?\n> Yes')).toMatchObject({ trustKeys: null });
  });
  it('reads multiline input between the prompt and its closing border', () => {
    expect(agentScreen('antigravity', '────────\n> hello\n  world\n────────\n? for shortcuts').input).toBe('hello\nworld');
  });
});

describe('screen-verified submission', () => {
  function fixture(screens: string[]) {
    let index = 0;
    const writes: string[] = [];
    const io = { capture: async () => screens[Math.min(index++, screens.length - 1)]!,
      write: async (bytes: string) => { writes.push(bytes); }, frame: frameForPaste };
    return { io, writes };
  }
  const options = { timeoutMs: 3, pollMs: 1, pause: async () => {} };
  it('waits through loading, verifies the paste, and submits separately after ingestion', async () => {
    const { io, writes } = fixture(['Loading...', idle, '> hello', 'Thinking... (esc to cancel)\n> ']);
    expect(await submitWithScreen('antigravity', 'hello', io, options)).toMatchObject({ status: 'delivered_working' });
    expect(writes).toEqual(['hello', '\r']);
  });
  it('retries Enter when input remains, without duplicating a multi-line prompt', async () => {
    const { io, writes } = fixture([idle, '> [Pasted text: 2 lines]', ...Array(4).fill('> [Pasted text: 2 lines]'), 'Working (esc to interrupt)\n› ']);
    expect(await submitWithScreen('antigravity', 'hello\nworld', io, options)).toMatchObject({ status: 'delivered_working' });
    expect(writes).toEqual(['\x1b[200~hello\nworld\x1b[201~', '\r', '\r']);
  });
  it('fails without submitting when paste is swallowed or readiness never arrives', async () => {
    for (const screens of [[idle], ['Loading...'], [trust]]) {
      const { io, writes } = fixture(screens);
      expect(await submitWithScreen('antigravity', 'hello', io, options)).toMatchObject({ status: 'failed' });
      expect(writes).not.toContain('\r');
      expect(writes.filter((v) => v === 'hello').length).toBeLessThanOrEqual(1);
    }
  });
  it('does not mistake transcript echoes for a submitted input', async () => {
    const { io, writes } = fixture([idle, 'Previous message: hello\n> ']);
    expect(await submitWithScreen('antigravity', 'hello', io, options)).toMatchObject({ status: 'failed' });
    expect(writes).toEqual(['hello']);
  });
  it('verifies a fast completed response when the input clears', async () => {
    const { io } = fixture([idle, '> hello', 'Hello there!\n> ']);
    expect(await submitWithScreen('antigravity', 'hello', io, options)).toMatchObject({ status: 'delivered_idle' });
  });
});
