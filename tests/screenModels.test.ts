import { describe, expect, it } from 'vitest';
import { agentScreen, screenModel } from '../src/screenModels.js';

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
    expect(agentScreen('antigravity', trust)).toMatchObject({ ready: false, input: null });
    expect(agentScreen('antigravity', 'Loading Antigravity...')).toMatchObject({ ready: false });
    expect(agentScreen('antigravity', 'Do you want to allow this command?\n> Yes')).toMatchObject({ ready: true });
  });
  it('reads multiline input between the prompt and its closing border', () => {
    expect(agentScreen('antigravity', '────────\n> hello\n  world\n────────\n? for shortcuts').input).toBe('hello\nworld');
  });
});
