/**
 * Marker-delimited answers for the combined session-backend probe in
 * hostClient.detectSessionBackend, so fake connections can speak the same
 * protocol the real probe script emits.
 */
export const PROBE_MARK = '__PSC_BACKEND__';

export interface ProbeAnswer {
  /** The `pocketshell sessions list` section; omit for a wrapper that never answered. */
  wrapper?: { output?: string; exit?: number };
  /** The `command -v a` answer; omit the key entirely for "no line emitted". */
  apath?: string;
  /** The `a --json snapshot` section; omit when the script found no `a`. */
  snapshot?: { output?: string; exit?: number };
}

export function probeStdout(answer: ProbeAnswer): string {
  const lines: string[] = [];
  if (answer.wrapper !== undefined) {
    lines.push(`${PROBE_MARK}wrapper`);
    if (answer.wrapper.output !== undefined) lines.push(...answer.wrapper.output.split('\n'));
    lines.push(`${PROBE_MARK}wexit ${answer.wrapper.exit ?? 0}`);
  }
  if ('apath' in answer) lines.push(`${PROBE_MARK}apath ${answer.apath ?? ''}`);
  if (answer.snapshot !== undefined) {
    lines.push(`${PROBE_MARK}snapshot`);
    if (answer.snapshot.output !== undefined) lines.push(...answer.snapshot.output.split('\n'));
    lines.push(`${PROBE_MARK}sexit ${answer.snapshot.exit ?? 0}`);
  }
  return lines.join('\n');
}

/** True when the command is the combined probe exec (wrapped by pathAwareCommand). */
export function isProbeExec(command: string): boolean {
  return command.includes('pocketshell sessions list --json') && command.includes(`${PROBE_MARK}wrapper`);
}

/** True when the command is the raw-PATH aplexer probe exec (not pathAware-wrapped). */
export function isRawAplexerExec(command: string): boolean {
  return command.startsWith('a_path=$(command -v a');
}
