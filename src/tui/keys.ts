/**
 * Keys: raw stdin bytes → parsed keys → TUI actions. Pure.
 *
 * Parsing is hand-rolled (not readline's keypress decoder) so a lone Esc is
 * delivered at once instead of after a timeout, and nothing stays attached
 * to stdin while an attached session owns the terminal.
 */
import type { Action, TuiState } from './state.js';

export interface Key {
  /** `char` for printable input (see `ch`), else a named key or the letter of a Ctrl combo. */
  name: string;
  ch?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const CSI_FINAL: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

function controlKey(code: number): Key {
  if (code === 13 || code === 10) return { name: 'enter' };
  if (code === 9) return { name: 'tab' };
  if (code === 127 || code === 8) return { name: 'backspace' };
  if (code === 0) return { name: 'space', ctrl: true };
  if (code === 27) return { name: 'escape' };
  return { name: String.fromCharCode(code + 96), ctrl: true };
}

/** Split one chunk of terminal input into keys. A chunk ending in a bare ESC is the Esc key. */
export function parseKeys(input: string): Key[] {
  const keys: Key[] = [];
  const chars = Array.from(input);
  let i = 0;
  let text = '';
  const flushText = () => {
    // Pasted runs of printable text stay one `char` key per code point.
    for (const ch of text) keys.push({ name: 'char', ch });
    text = '';
  };
  while (i < chars.length) {
    const ch = chars[i]!;
    const code = ch.codePointAt(0)!;
    if (ch === '\x1b') {
      flushText();
      const next = chars[i + 1];
      if (next === undefined || next === '\x1b') {
        keys.push({ name: 'escape' });
        i += 1;
        continue;
      }
      if (next === '[' || next === 'O') {
        // CSI / SS3: parameters then a final byte in @..~
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[0-9;?<>=]/.test(chars[j]!)) {
          params += chars[j];
          j += 1;
        }
        const final = chars[j];
        if (final === undefined) {
          // Truncated sequence: treat as Esc + literal text.
          keys.push({ name: 'escape' });
          i += 1;
          continue;
        }
        const mod = Number(params.split(';')[1] ?? '1') - 1;
        const flags = { shift: Boolean(mod & 1), meta: Boolean(mod & 2), ctrl: Boolean(mod & 4) };
        let name: string | undefined;
        if (final === '~') name = TILDE[params.split(';')[0] ?? ''];
        else name = CSI_FINAL[final];
        if (name) keys.push({ name, ...flags });
        i = j + 1;
        continue;
      }
      // Alt+key
      const code2 = next.codePointAt(0)!;
      if (code2 < 32 || code2 === 127) keys.push({ ...controlKey(code2), meta: true });
      else keys.push({ name: 'char', ch: next, meta: true });
      i += 2;
      continue;
    }
    if (code < 32 || code === 127) {
      flushText();
      keys.push(controlKey(code));
      i += 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  flushText();
  return keys;
}

const is = (key: Key, ch: string) => key.name === 'char' && key.ch === ch && !key.meta;

/** Map a key to an action for the current mode; null when the key means nothing here. */
export function keyToAction(state: TuiState, key: Key): Action | null {
  if (key.ctrl && key.name === 'c') return { type: 'quit' };
  if (key.ctrl && key.name === 'l') return { type: 'redraw' };
  const mode = state.mode;
  switch (mode.kind) {
    case 'help':
      return { type: 'closeOverlay' };
    case 'confirmKill':
      return { type: 'confirm', yes: is(key, 'y') || is(key, 'Y') };
    case 'filter':
    case 'send':
    case 'newName':
    case 'newCwd':
    case 'newEngineText':
      return { type: 'input', key };
    case 'hosts':
    case 'newEngine': {
      if (key.name === 'up' || is(key, 'k')) return { type: 'pickerMove', delta: -1 };
      if (key.name === 'down' || is(key, 'j')) return { type: 'pickerMove', delta: 1 };
      if (key.name === 'home' || is(key, 'g')) return { type: 'pickerMove', delta: -1_000 };
      if (key.name === 'end' || is(key, 'G')) return { type: 'pickerMove', delta: 1_000 };
      if (key.name === 'enter') return { type: 'pick', attach: true };
      if (mode.kind === 'newEngine' && key.name === 'tab') return { type: 'pick', attach: false };
      if (key.name === 'escape' || is(key, 'q') || (mode.kind === 'hosts' && (is(key, 'h') || key.name === 'tab'))) {
        return { type: 'closeOverlay' };
      }
      return null;
    }
    case 'list':
      break;
  }
  if (key.name === 'up' || is(key, 'k') || (key.ctrl && key.name === 'p')) return { type: 'move', delta: -1 };
  if (key.name === 'down' || is(key, 'j') || (key.ctrl && key.name === 'n')) return { type: 'move', delta: 1 };
  if (key.name === 'pageup' || (key.ctrl && key.name === 'b') || (key.ctrl && key.name === 'u')) return { type: 'page', dir: -1 };
  if (key.name === 'pagedown' || (key.ctrl && key.name === 'f') || (key.ctrl && key.name === 'd')) return { type: 'page', dir: 1 };
  if (key.name === 'home' || is(key, 'g')) return { type: 'moveTo', where: 'top' };
  if (key.name === 'end' || is(key, 'G')) return { type: 'moveTo', where: 'bottom' };
  if (key.name === 'enter' || is(key, 'a')) return { type: 'attach' };
  if (is(key, 'p') || is(key, ' ')) return { type: 'togglePreview' };
  if (is(key, 'f')) return { type: 'togglePreviewFull' };
  if (is(key, 's')) return { type: 'startSend' };
  if (is(key, 'n')) return { type: 'startNew' };
  if (is(key, 'x') || is(key, 'd') || key.name === 'delete') return { type: 'startKill' };
  if (is(key, '/')) return { type: 'startFilter' };
  if (is(key, 'h') || key.name === 'tab') return { type: 'openHosts' };
  if (is(key, 'w')) return { type: 'toggleEmpty' };
  if (is(key, 'r')) return { type: 'refresh' };
  if (is(key, '?')) return { type: 'openHelp' };
  if (key.name === 'escape') return { type: 'escape' };
  if (is(key, 'q')) return state.preview ? { type: 'escape' } : { type: 'quit' };
  return null;
}
