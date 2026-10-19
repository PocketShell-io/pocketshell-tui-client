import { safeText } from './sanitize.js';

export type ScreenModel = 'antigravity' | 'codex';
export interface AgentScreen {
  ready: boolean;
  busy: boolean;
  input: string | null;
  trustKeys: string | null;
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
  if (trust) {
    // Both TUIs default to the affirmative numbered choice. Explicitly select it.
    const yes = /(?:[›❯>●]\s*)?([1-9])[.)]\s*(?:yes|trust)/i.exec(tail);
    return { ready: false, busy: false, input: null, trustKeys: yes ? `${yes[1]}\r` : '\r' };
  }
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
  return { ready: input !== null && !busy, busy, input, trustKeys: null };
}

export function inputContains(input: string | null, text: string): boolean {
  if (input === null) return false;
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const probe = normalize(text).slice(0, 40);
  return (probe.length > 0 && normalize(input).includes(probe)) || /\[Pasted (?:text|content)\b/i.test(input);
}

/** Verified paste/submit for aliases unknown to older host helpers. Never resend text. */
export async function submitWithScreen(
  model: ScreenModel,
  text: string,
  io: { capture(): Promise<string>; write(bytes: string): Promise<void>; frame(text: string): string },
  options: { timeoutMs?: number; pollMs?: number; pause?: (ms: number) => Promise<void> } = {},
): Promise<{ status: 'delivered_working' | 'delivered_idle' | 'failed'; detail: string }> {
  const pause = options.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 250;
  const polls = Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / pollMs));
  let before = '';
  let ready = false;
  for (let i = 0; i < polls; i++) {
    before = await io.capture();
    const screen = agentScreen(model, before);
    if (screen.ready) { ready = true; break; }
    // Trust is handled only by start, never implicitly by send.
    if (screen.trustKeys) return { status: 'failed', detail: 'workspace trust prompt blocks input; use start --prompt to accept it' };
    await pause(pollMs);
  }
  if (!ready) return { status: 'failed', detail: 'agent input did not become ready' };
  await io.write(io.frame(text));
  let typed = text === '';
  for (let i = 0; !typed && i < 12; i++) {
    await pause(pollMs);
    typed = inputContains(agentScreen(model, await io.capture()).input, text);
  }
  if (!typed) return { status: 'failed', detail: 'paste was not visible in the input; text was not resubmitted' };
  await io.write('\r');
  let retries = 0;
  for (let i = 0; i < 40; i++) {
    await pause(pollMs);
    const raw = await io.capture();
    const screen = agentScreen(model, raw);
    if (screen.busy) return { status: 'delivered_working', detail: 'agent started working after submission' };
    if (screen.ready && !inputContains(screen.input, text) && raw !== before)
      return { status: 'delivered_idle', detail: 'input cleared after submission; agent is idle' };
    if (inputContains(screen.input, text) && i % 4 === 3 && retries++ < 2) await io.write('\r');
  }
  return { status: 'failed', detail: 'input did not clear after Enter; submission could not be verified' };
}
