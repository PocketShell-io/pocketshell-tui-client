import { safeText } from './sanitize.js';

export type ScreenModel = 'antigravity' | 'codex';
export interface AgentScreen {
  ready: boolean;
  busy: boolean;
  input: string | null;
}

export function screenModel(engine: string | null | undefined): ScreenModel | null {
  switch (engine?.trim().toLowerCase()) {
    case 'flash': case 'argon': case 'antigravity': case 'agy': return 'antigravity';
    case 'codex-orin': return 'codex';
    default: return null;
  }
}

/** Read the live input area, never a prompt echoed in the transcript. */
export function agentScreen(model: ScreenModel, raw: string): AgentScreen {
  const text = safeText(raw);
  const lines = text.split('\n');
  const tail = lines.slice(-18).join('\n');
  const trust = /(?:trust (?:the files in |this |all files in )?(?:folder|directory|workspace)|do you trust|folder trust)/i.test(text)
    && /(?:yes|trust|continue)/i.test(tail);
  if (trust) return { ready: false, busy: false, input: null };
  const busy = model === 'codex'
    ? /(?:esc to (?:interrupt|cancel)|interrupt to stop)/i.test(tail)
    : /(?:esc to (?:cancel|interrupt)|(?:thinking|working|generating)\s*(?:\.{2,}|…))/i.test(tail);
  let input: string | null = null;
  // These prompts are anchored to a screen row, close to the footer.
  const inputLines = lines.slice(-12);
  for (let i = 0; i < inputLines.length; i++) {
    const line = inputLines[i]!;
    const match = /^\s*(?:[│┃]\s*)?[›❯>]\s?(.*?)(?:\s*[│┃])?\s*$/.exec(line);
    if (match) {
      const content = [match[1]!.trim()];
      for (const next of inputLines.slice(i + 1)) {
        if (/^\s*[─━═└╰]|^\s*\? for shortcuts|^\s*[›❯>]/.test(next)) break;
        content.push(next.replace(/^\s*[│┃]\s?/, '').replace(/[│┃]\s*$/, '').trim());
      }
      input = content.join('\n').trim();
    }
  }
  return { ready: input !== null && !busy, busy, input };
}
