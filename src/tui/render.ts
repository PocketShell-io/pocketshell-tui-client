/**
 * Pure rendering: state → exactly `height` lines of exactly `width` cells.
 *
 * Layout: header, rule, body (session list, optional preview pane, or an
 * overlay box on top), status line, key hints. `renderLines` returns styled
 * lines; `render` serializes them for a given color mode.
 */
import { sessionListErrorNotice, type SessionRow } from '@pocketshell/core';
import { renderInput } from './prompt.js';
import {
  engineOptions,
  layout,
  visibleItems,
  type Item,
  type TuiState,
} from './state.js';
import {
  fitLine,
  lineWidth,
  overlayLine,
  padEnd,
  padStart,
  sanitize,
  textWidth,
  toAnsi,
  truncate,
  truncateLeft,
  wrap,
  type ColorMode,
  type Line,
  type Seg,
  type Style,
} from './text.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function ago(epoch: number | null, now: number): string {
  if (!epoch) return '-';
  const secs = Math.max(0, Math.floor(now - epoch));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function stateCell(row: SessionRow): { text: string; style: Style } {
  switch (row.agentState) {
    case 'working':
      return { text: 'working', style: 'yellow' };
    case 'waiting':
      return { text: 'waiting', style: 'cyanBold' };
    case 'idle':
      return { text: 'idle', style: 'dim' };
    default: {
      const phase = row.phase ?? '';
      if (phase && phase !== 'running') return { text: phase, style: phase === 'exiting' ? 'red' : 'dim' };
      return { text: '-', style: 'dim' };
    }
  }
}

function header(state: TuiState, width: number): Line {
  const total = state.sessions.length;
  const waiting = state.sessions.filter((row) => row.agentState === 'waiting').length;
  const left: Line = [
    { text: ' PocketShell', style: 'title' },
    { text: ' · ', style: 'dim' },
    { text: state.hostName, style: 'bold' },
    { text: state.hostMode ? ` (${state.hostMode})` : '', style: 'dim' },
  ];
  if (state.loaded) {
    left.push({ text: ' · ', style: 'dim' }, { text: `${total} session${total === 1 ? '' : 's'}` });
    if (waiting > 0) left.push({ text: ' · ', style: 'dim' }, { text: `${waiting} waiting`, style: 'cyanBold' });
  }
  if (state.loggedIn !== null) {
    left.push({ text: ' · ', style: 'dim' }, { text: state.loggedIn ? 'logged in' : 'not logged in', style: 'dim' });
  }
  const activity = state.busy ?? (state.refreshing ? 'refreshing' : '');
  const right: Line = activity
    ? [{ text: `${SPINNER[state.spinner % SPINNER.length]} ${activity} `, style: state.busy ? 'yellow' : 'dim' }]
    : [];
  const rightWidth = lineWidth(right);
  if (rightWidth > 0 && rightWidth + 12 <= width) {
    return [...fitLine(left, width - rightWidth), ...right];
  }
  return fitLine(left, width);
}

function rule(state: TuiState, width: number, items: Item[]): Line {
  if (state.filter && state.mode.kind !== 'filter') {
    const shown = items.filter((item) => item.kind === 'session').length;
    const label = ` filter "${state.filter}" · ${shown} of ${state.sessions.length} · esc clears `;
    const lead = '── ';
    return fitLine(
      [
        { text: lead, style: 'dim' },
        { text: label, style: 'yellow' },
        { text: '─'.repeat(Math.max(0, width - textWidth(lead) - textWidth(label))), style: 'dim' },
      ],
      width,
    );
  }
  return [{ text: '─'.repeat(width), style: 'dim' }];
}

function groupLine(item: Extract<Item, { kind: 'group' }>, width: number, selected: boolean): Line {
  const count = item.empty ? 'no sessions' : `${item.count}`;
  const tail: Seg[] = [{ text: `  ${count}`, style: 'dim', invert: selected }];
  if (item.waiting > 0) {
    tail.push({ text: ' · ', style: 'dim', invert: selected }, { text: `${item.waiting} waiting`, style: 'cyan', invert: selected });
  }
  const tailWidth = lineWidth(tail);
  const marker = selected ? '› ' : item.empty ? '  ' : '▾ ';
  const labelRoom = Math.max(1, width - 2 - tailWidth);
  const label = truncateLeft(item.label, labelRoom);
  return fitLine(
    [{ text: marker, style: item.empty ? 'dim' : 'bold', invert: selected }, { text: label, style: item.empty ? 'dim' : 'bold', invert: selected }, ...tail],
    width,
    { text: ' ', invert: selected },
  );
}

/** Column widths for a session row at this terminal width. */
export function rowColumns(width: number, longestTag = Infinity): { tag: number; agent: number; state: number; age: number } {
  const prefix = 4;
  let agent = 11;
  let age = 4;
  const state = 7;
  let tag = width - prefix - (agent + 1) - (state + 1) - (age + 1);
  if (tag < 14) {
    tag += agent + 1;
    agent = 0;
  }
  if (tag < 8) {
    tag += age + 1;
    age = 0;
  }
  // Keep columns near the names on wide terminals instead of pinned to the far edge.
  tag = Math.min(tag, Math.max(12, longestTag));
  return { tag: Math.max(1, tag), agent, state, age };
}

function sessionLine(row: SessionRow, width: number, selected: boolean, now: number, longestTag: number): Line {
  const cols = rowColumns(width, longestTag);
  const st = stateCell(row);
  const waiting = row.agentState === 'waiting';
  const inv = selected;
  const line: Line = [
    { text: selected ? '› ' : '  ', style: 'bold', invert: inv },
    { text: row.attached ? '●' : ' ', style: 'green', invert: inv },
    { text: ' ', invert: inv },
    { text: padEnd(sanitize(row.tag ?? row.name), cols.tag), style: waiting ? 'bold' : 'plain', invert: inv },
  ];
  if (cols.agent > 0) line.push({ text: ` ${padEnd(sanitize(row.agent ?? row.engine ?? ''), cols.agent)}`, style: 'magenta', invert: inv });
  line.push({ text: ` ${padEnd(st.text, cols.state)}`, style: st.style, invert: inv });
  if (cols.age > 0) line.push({ text: ` ${padStart(ago(row.activityEpoch, now), cols.age)}`, style: 'dim', invert: inv });
  return fitLine(line, width, { text: ' ', invert: inv });
}

function centered(text: string, width: number, style: Style): Line {
  const cut = truncate(text, width);
  const pad = Math.max(0, Math.floor((width - textWidth(cut)) / 2));
  return fitLine([{ text: ' '.repeat(pad) }, { text: cut, style }], width);
}

function listBody(state: TuiState, items: Item[], width: number, height: number): Line[] {
  const lines: Line[] = [];
  const blank = (): Line => [{ text: ' '.repeat(width) }];
  if (items.length === 0) {
    const messages: Array<[string, Style]> = [];
    if (!state.loaded && state.loadError) {
      messages.push([`cannot reach ${state.hostName}`, 'redBold']);
      const room = Math.max(10, Math.min(width - 4, 72));
      const wrapped = wrap(state.loadError, room).slice(0, Math.max(1, height - 3));
      for (const text of wrapped) messages.push([text, 'red']);
      messages.push(['h switches host · r retries · q quits', 'dim']);
    } else if (!state.loaded) {
      messages.push([`loading sessions from ${state.hostName}…`, 'dim']);
    } else if (state.filter) {
      messages.push([`no sessions match "${state.filter}"`, 'plain'], ['esc clears the filter', 'dim']);
    } else {
      messages.push([`no sessions on ${state.hostName}`, 'plain'], ['press n to start one', 'dim']);
    }
    const top = Math.max(0, Math.floor((height - messages.length) / 2));
    for (let i = 0; i < height; i += 1) {
      const message = messages[i - top];
      lines.push(message ? centered(message[0], width, message[1]) : blank());
    }
    return lines;
  }
  const longestTag = Math.max(0, ...items.map((item) => (item.kind === 'session' ? textWidth(sanitize(item.row.tag ?? item.row.name)) : 0)));
  const slice = items.slice(state.scroll, state.scroll + height);
  for (const item of slice) {
    const selected = item.key === state.selectedKey;
    lines.push(item.kind === 'group' ? groupLine(item, width, selected) : sessionLine(item.row, width, selected, state.now, longestTag));
  }
  while (lines.length < height) lines.push(blank());
  // Scroll hints on the last/first rows when there is more.
  if (state.scroll + height < items.length && height > 2) {
    lines[height - 1] = fitLine([{ text: `  ↓ ${items.length - state.scroll - height} more`, style: 'dim' }], width);
  }
  if (state.scroll > 0 && height > 2) {
    lines[0] = fitLine([{ text: `  ↑ ${state.scroll} more`, style: 'dim' }], width);
  }
  return lines;
}

function previewBody(state: TuiState, items: Item[], width: number, height: number): Line[] {
  const preview = state.preview!;
  const item = items.find((entry) => entry.key === preview.key);
  const name = item?.kind === 'session' ? item.row.name : '';
  const title = name ? ` preview · ${name} ` : ' preview ';
  const hint = preview.full ? ' f split · esc close ' : ' f full · esc close ';
  const lines: Line[] = [
    fitLine(
      [
        { text: '──', style: 'dim' },
        { text: title, style: 'bold' },
        { text: '─'.repeat(Math.max(0, width - 2 - textWidth(title) - textWidth(hint))), style: 'dim' },
        { text: hint, style: 'dim' },
      ],
      width,
    ),
  ];
  const room = height - 1;
  let content: Line[];
  if (!item || item.kind !== 'session') {
    content = [centered('no session selected', width, 'dim')];
  } else if (preview.error && preview.text === null) {
    content = [fitLine([{ text: ` capture failed: ${preview.error}`, style: 'red' }], width)];
  } else if (preview.text === null) {
    content = [fitLine([{ text: ' capturing…', style: 'dim' }], width)];
  } else {
    const raw = preview.text.replace(/\r/g, '').split('\n').map((text) => sanitize(text).replace(/\s+$/, ''));
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    if (raw.length === 0) raw.push('(blank screen)');
    content = raw.slice(-room).map((text) => fitLine([{ text }], width));
    if (preview.error) content = [...content.slice(1 - room), fitLine([{ text: ` ! ${preview.error}`, style: 'red' }], width)];
  }
  for (let i = 0; i < room; i += 1) lines.push(content[i] ?? [{ text: ' '.repeat(width) }]);
  return lines.slice(0, height);
}

/** A centered box with a title, drawn over `body`. Content lines are styled; `cursor` is inverted. */
function boxOver(body: Line[], width: number, title: string, content: Line[], cursor = -1, footer = ''): Line[] {
  const height = body.length;
  const contentWidth = Math.max(...content.map(lineWidth), textWidth(title) + 2, textWidth(footer) + 2, 10);
  const boxWidth = Math.min(width, contentWidth + 4);
  const inner = boxWidth - 4;
  const maxRows = Math.max(0, height - 2);
  let rows = content;
  let offset = 0;
  if (rows.length > maxRows) {
    // Keep the cursor in view.
    offset = cursor >= 0 ? Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), rows.length - maxRows)) : 0;
    const hidden = rows.length - maxRows;
    rows = rows.slice(offset, offset + maxRows);
    if (cursor < 0 && maxRows > 1) rows = [...rows.slice(0, -1), [{ text: `… ${hidden + 1} more (enlarge the terminal)`, style: 'dim' }]];
  }
  const boxHeight = Math.min(height, rows.length + 2);
  const top = Math.max(0, Math.floor((height - boxHeight) / 2));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));
  const titleText = truncate(` ${title} `, Math.max(0, boxWidth - 4));
  const footText = footer ? truncate(` ${footer} `, Math.max(0, boxWidth - 4)) : '';
  const border = (l: string, r: string, label: string, labelStyle: Style): Line => [
    { text: `${l}─`, style: 'dim' },
    { text: label, style: labelStyle },
    { text: '─'.repeat(Math.max(0, boxWidth - 3 - textWidth(label))) + r, style: 'dim' },
  ];
  const out = [...body];
  const put = (row: number, line: Line) => {
    if (row >= 0 && row < height) out[row] = overlayLine(out[row]!, fitLine(line, boxWidth), left, width);
  };
  put(top, border('┌', '┐', titleText, 'bold'));
  rows.forEach((line, i) => {
    if (top + 1 + i >= top + boxHeight - 1) return;
    const selected = offset + i === cursor;
    const cells = fitLine(line.map((seg) => ({ ...seg, invert: selected || seg.invert })), inner, { text: ' ', invert: selected });
    put(top + 1 + i, [{ text: '│ ', style: 'dim' }, ...cells, { text: ' │', style: 'dim' }]);
  });
  if (boxHeight >= 2) put(top + boxHeight - 1, border('└', '┘', footText, 'dim'));
  return out;
}

export const HELP: Array<[string, string]> = [
  ['↑↓ j k', 'move'],
  ['PgUp PgDn', 'page'],
  ['g G', 'top / bottom'],
  ['↵ a', 'attach (Ctrl-b d detaches)'],
  ['p space', 'preview pane'],
  ['f', 'preview full screen'],
  ['s', 'send text (+Enter)'],
  ['n', 'new session'],
  ['x d', 'kill session'],
  ['/', 'filter'],
  ['h tab', 'switch host'],
  ['w', 'show empty workspaces'],
  ['r', 'refresh now'],
  ['esc', 'close / clear filter'],
  ['?', 'this help'],
  ['q ^C', 'quit'],
];

function helpContent(width: number): Line[] {
  const keyWidth = 10;
  const entry = ([key, text]: [string, string]): Line => [{ text: padEnd(key, keyWidth), style: 'key' }, { text }];
  if (width >= 84) {
    const half = Math.ceil(HELP.length / 2);
    const lines: Line[] = [];
    for (let i = 0; i < half; i += 1) {
      const leftEntry = entry(HELP[i]!);
      const pad = 38 - lineWidth(leftEntry);
      const right = HELP[i + half];
      lines.push([...leftEntry, { text: ' '.repeat(Math.max(1, pad)) }, ...(right ? entry(right) : [])]);
    }
    return lines;
  }
  return HELP.map(entry);
}

function hints(state: TuiState): Array<[string, string]> {
  switch (state.mode.kind) {
    case 'filter':
      return [['type', 'to filter'], ['↵', 'keep'], ['esc', 'clear']];
    case 'send':
      return [['↵', 'send + Enter'], ['esc', 'cancel']];
    case 'newName':
      return [['↵', 'next: directory'], ['esc', 'cancel']];
    case 'newCwd':
      return [['↵', 'next: engine'], ['esc', 'cancel']];
    case 'newEngine':
      return [['↵', 'create + attach'], ['tab', 'create only'], ['↑↓', 'choose'], ['esc', 'cancel']];
    case 'newEngineText':
      return [['↵', 'create + attach'], ['esc', 'back']];
    case 'confirmKill':
      return [['y', 'kill'], ['other', 'cancel']];
    case 'hosts':
      return [['↵', 'switch'], ['↑↓', 'choose'], ['esc', 'close']];
    case 'help':
      return [['any key', 'closes']];
    case 'list':
      break;
  }
  if (state.preview) {
    return [['↵', 'attach'], ['j/k', 'move'], ['f', state.preview.full ? 'split' : 'full'], ['s', 'send'], ['esc', 'close'], ['?', 'help']];
  }
  return [
    ['↵', 'attach'],
    ['p', 'preview'],
    ['s', 'send'],
    ['n', 'new'],
    ['x', 'kill'],
    ['/', 'filter'],
    ['h', 'hosts'],
    ['?', 'help'],
    ['q', 'quit'],
  ];
}

function hintLine(state: TuiState, width: number): Line {
  const line: Line = [{ text: ' ' }];
  for (const [key, text] of hints(state)) {
    const piece: Line = [{ text: key, style: 'key' }, { text: ` ${text}  `, style: 'dim' }];
    if (lineWidth(line) + lineWidth(piece) > width && line.length > 1) break;
    line.push(...piece);
  }
  return fitLine(line, width);
}

function statusLine(state: TuiState, width: number): Line {
  const mode = state.mode;
  switch (mode.kind) {
    case 'filter':
      return fitLine(renderInput(' / ', 'key', mode.input, width), width);
    case 'send':
      return fitLine(renderInput(` send → ${truncate(mode.label, Math.max(8, Math.floor(width / 3)))}: `, 'key', mode.input, width), width);
    case 'newName':
      return fitLine(renderInput(' new session name: ', 'key', mode.input, width, 'e.g. fix-login'), width);
    case 'newCwd':
      return fitLine(renderInput(` ${mode.name} in directory: `, 'key', mode.input, width, "(host default)"), width);
    case 'newEngineText':
      return fitLine(renderInput(` ${mode.name} engine: `, 'key', mode.input, width), width);
    case 'confirmKill':
      return fitLine([{ text: ` kill ${mode.label}? `, style: 'redBold' }, { text: '[y/N]', style: 'bold' }], width);
    default:
      break;
  }
  if (state.status) {
    const style: Style = state.status.kind === 'error' ? 'red' : state.status.kind === 'ok' ? 'green' : 'plain';
    return fitLine([{ text: ` ${state.status.text}`, style }], width);
  }
  const notice = sessionListErrorNotice(state.listErrors.map((message) => ({ message })));
  if (notice) return fitLine([{ text: ` ${notice}`, style: 'yellow' }], width);
  if (state.loadError && state.loaded) return fitLine([{ text: ` ${state.loadError} (showing last good list)`, style: 'red' }], width);
  return [{ text: ' '.repeat(width) }];
}

export function renderLines(state: TuiState): Line[] {
  const width = Math.max(1, state.width);
  const height = Math.max(1, state.height);
  const items = visibleItems(state);
  const { bodyHeight, listHeight, previewHeight } = layout(state);
  let body: Line[] = [];
  if (listHeight > 0) body.push(...listBody(state, items, width, listHeight));
  if (previewHeight > 0) {
    body.push(...previewBody(state, items, width, previewHeight));
  }
  while (body.length < bodyHeight) body.push([{ text: ' '.repeat(width) }]);
  body = body.slice(0, bodyHeight);

  const mode = state.mode;
  if (mode.kind === 'help') {
    body = boxOver(body, width, 'keys', helpContent(width), -1, 'any key closes');
  } else if (mode.kind === 'hosts') {
    const hosts = state.hosts ?? [];
    const content: Line[] = state.hostsError
      ? [[{ text: state.hostsError, style: 'red' }]]
      : hosts.length === 0
        ? [[{ text: 'loading…', style: 'dim' }]]
        : hosts.map((host) => [
            { text: host.name === state.hostName ? '● ' : '  ', style: 'green' },
            { text: padEnd(host.name, Math.max(...hosts.map((h) => textWidth(h.name)), 8)) },
            { text: `  ${host.mode}`, style: 'dim' },
          ]);
    body = boxOver(body, width, 'hosts', content, state.hostsError ? -1 : mode.cursor, '↵ switch · esc close');
  } else if (mode.kind === 'newEngine') {
    const options = engineOptions(state);
    const content: Line[] = options.map((option) => [{ text: option.label, style: option.other || option.id === null ? 'dim' : 'plain' }]);
    if (state.engines === null && !state.enginesError) content.splice(1, 0, [{ text: 'loading engines…', style: 'dim' }]);
    if (state.enginesError) content.push([{ text: `engines: ${state.enginesError}`, style: 'red' }]);
    const cursor = state.engines === null && !state.enginesError && mode.cursor >= 1 ? mode.cursor + 1 : mode.cursor;
    body = boxOver(body, width, `engine for ${mode.name}`, content, cursor, '↵ create+attach · tab create');
  }

  const lines: Line[] = [header(state, width), rule(state, width, items), ...body, statusLine(state, width), hintLine(state, width)];
  // Tiny terminals: keep the header, the body's start, and the status line.
  if (lines.length > height) {
    if (height === 1) return [lines[0]!];
    return [...lines.slice(0, height - 1), lines[lines.length - 2]!];
  }
  return lines;
}

/** Serialize a frame. Every line is exactly `width` cells. */
export function render(state: TuiState, color: ColorMode): string[] {
  return renderLines(state).map((line) => toAnsi(line, color));
}

/** Plain-text frame for tests. */
export function renderPlain(state: TuiState): string[] {
  return renderLines(state).map((line) => line.map((seg) => seg.text).join(''));
}
