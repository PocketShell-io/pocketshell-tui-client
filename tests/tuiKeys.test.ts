import { describe, expect, it } from 'vitest';
import { keyToAction, parseKeys } from '../src/tui/keys.js';
import { editLine, inputValue, lineInput, renderInput } from '../src/tui/prompt.js';
import { reduce } from '../src/tui/state.js';
import { fitLine, takeCells, textWidth, toPlain, truncate, wrap } from '../src/tui/text.js';
import { loaded } from './tuiFixtures.js';

describe('parseKeys', () => {
  it('parses printable text, controls and escape sequences', () => {
    expect(parseKeys('jk')).toEqual([{ name: 'char', ch: 'j' }, { name: 'char', ch: 'k' }]);
    expect(parseKeys('\r')).toEqual([{ name: 'enter' }]);
    expect(parseKeys('\x03')).toEqual([{ name: 'c', ctrl: true }]);
    expect(parseKeys('\x7f')).toEqual([{ name: 'backspace' }]);
    expect(parseKeys('\t')).toEqual([{ name: 'tab' }]);
    expect(parseKeys('\x1b')).toEqual([{ name: 'escape' }]);
    expect(parseKeys('\x1b[A\x1b[B')).toMatchObject([{ name: 'up' }, { name: 'down' }]);
    expect(parseKeys('\x1bOD')).toMatchObject([{ name: 'left' }]);
    expect(parseKeys('\x1b[5~\x1b[6~\x1b[3~')).toMatchObject([{ name: 'pageup' }, { name: 'pagedown' }, { name: 'delete' }]);
    expect(parseKeys('\x1b[1;5C')).toMatchObject([{ name: 'right', ctrl: true }]);
    expect(parseKeys('\x1bx')).toEqual([{ name: 'char', ch: 'x', meta: true }]);
    expect(parseKeys('\x1b\x1b')).toEqual([{ name: 'escape' }, { name: 'escape' }]);
    expect(parseKeys('é●')).toEqual([{ name: 'char', ch: 'é' }, { name: 'char', ch: '●' }]);
    expect(parseKeys('\x1b[Z')).toMatchObject([{ name: 'backtab' }]);
  });
});

describe('keyToAction', () => {
  const list = loaded();
  const act = (text: string, state = list) => parseKeys(text).map((key) => keyToAction(state, key));

  it('maps the list keys', () => {
    expect(act('jk')).toEqual([{ type: 'move', delta: 1 }, { type: 'move', delta: -1 }]);
    expect(act('\x1b[A\x1b[B')).toEqual([{ type: 'move', delta: -1 }, { type: 'move', delta: 1 }]);
    expect(act('gG')).toEqual([{ type: 'moveTo', where: 'top' }, { type: 'moveTo', where: 'bottom' }]);
    expect(act('\x1b[5~\x1b[6~')).toEqual([{ type: 'page', dir: -1 }, { type: 'page', dir: 1 }]);
    expect(act('\ra')).toEqual([{ type: 'attach' }, { type: 'attach' }]);
    expect(act('p ')).toEqual([{ type: 'togglePreview' }, { type: 'togglePreview' }]);
    expect(act('snxd/')).toEqual([
      { type: 'startSend' },
      { type: 'startNew' },
      { type: 'startKill' },
      { type: 'startKill' },
      { type: 'startFilter' },
    ]);
    expect(act('h\tw?r')).toEqual([
      { type: 'openHosts' },
      { type: 'openHosts' },
      { type: 'toggleEmpty' },
      { type: 'openHelp' },
      { type: 'refresh' },
    ]);
    expect(act('q')).toEqual([{ type: 'quit' }]);
    expect(act('\x03')).toEqual([{ type: 'quit' }]);
    expect(act('Z')).toEqual([null]);
  });

  it('q closes the preview before it quits', () => {
    const previewing = reduce(list, { type: 'togglePreview' }).state;
    expect(act('q', previewing)).toEqual([{ type: 'escape' }]);
  });

  it('text modes send keys to the line editor (so q and j are text), Ctrl+C still quits', () => {
    const filtering = reduce(list, { type: 'startFilter' }).state;
    expect(act('q', filtering)).toEqual([{ type: 'input', key: { name: 'char', ch: 'q' } }]);
    expect(act('\x03', filtering)).toEqual([{ type: 'quit' }]);
  });

  it('confirm, help and pickers', () => {
    const confirming = reduce(list, { type: 'startKill' }).state;
    expect(act('y', confirming)).toEqual([{ type: 'confirm', yes: true }]);
    expect(act('n', confirming)).toEqual([{ type: 'confirm', yes: false }]);
    expect(act('\r', confirming)).toEqual([{ type: 'confirm', yes: false }]);
    const help = reduce(list, { type: 'openHelp' }).state;
    expect(act('x', help)).toEqual([{ type: 'closeOverlay' }]);
    const hosts = reduce(list, { type: 'openHosts' }).state;
    expect(act('j\r\x1b', hosts)).toEqual([{ type: 'pickerMove', delta: 1 }, { type: 'pick', attach: true }, { type: 'closeOverlay' }]);
  });
});

describe('line editor', () => {
  const type = (text: string, start = lineInput()) =>
    parseKeys(text).reduce((input, key) => editLine(input, key).input, start);

  it('inserts, deletes, moves, and kills words', () => {
    expect(inputValue(type('hello'))).toBe('hello');
    expect(inputValue(type('hello\x7f\x7f'))).toBe('hel');
    expect(inputValue(type('helo\x1b[Dl'))).toBe('hello');
    expect(inputValue(type('one two\x17'))).toBe('one ');
    expect(inputValue(type('abc\x01X'))).toBe('Xabc');
    expect(inputValue(type('abc\x15'))).toBe('');
    expect(inputValue(type('a●b\x1b[D\x7f'))).toBe('ab');
  });

  it('reports submit and cancel', () => {
    expect(editLine(lineInput('x'), { name: 'enter' }).done).toBe('submit');
    expect(editLine(lineInput('x'), { name: 'escape' }).done).toBe('cancel');
  });

  it('renders with a drawn cursor, scrolled to keep it visible', () => {
    const line = renderInput('> ', 'key', lineInput('abcdefghijklmnop'), 10);
    const text = toPlain(line);
    expect(textWidth(text)).toBeLessThanOrEqual(10);
    expect(text.startsWith('> ')).toBe(true);
    expect(text).toContain('mnop');
    expect(line.some((seg) => seg.invert)).toBe(true);
  });
});

describe('text cells', () => {
  it('measures wide and combining characters', () => {
    expect(textWidth('abc')).toBe(3);
    expect(textWidth('日本')).toBe(4);
    expect(textWidth('é')).toBe(1);
    expect(textWidth('●─│')).toBe(3);
  });

  it('truncates with an ellipsis without splitting wide chars', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(truncate('日本語', 4)).toBe('日 …');
    expect(takeCells('日本', 3)).toBe('日 ');
    expect(textWidth(toPlain(fitLine([{ text: '日本語テキスト' }], 7)))).toBe(7);
  });

  it('wraps words and hard-breaks long ones', () => {
    expect(wrap('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});
