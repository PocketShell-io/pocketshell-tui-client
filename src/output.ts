/**
 * Output discipline for an agent-friendly CLI.
 *
 * - `--json` (or PSC_JSON=1): exactly one JSON document on stdout per
 *   command; failures are `{"ok":false,"error":{"code","message"}}` on
 *   stdout too, so an agent parses one stream. Human text never mixes in.
 * - Without it: readable text on stdout, `error: …` on stderr.
 * - Exit codes are stable (see EXIT below) in both modes.
 */
import { HostCliError } from '@pocketshell/core';
import { HostStoreError } from './hosts/store.js';
import { ConnectionError } from './transport/types.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  CONNECT: 4,
  NOT_FOUND: 5,
  HOST_CLI: 6,
} as const;

let jsonMode = process.env.PSC_JSON === '1';

export function setJsonMode(value: boolean): void {
  jsonMode = jsonMode || value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Emit a successful result: `data` as JSON, or `human()` as text. */
export function emit(data: unknown, human?: () => string): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else if (human) {
    const text = human();
    if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Progress or hints for humans; silent in JSON mode, always on stderr. */
export function note(message: string): void {
  if (!jsonMode) process.stderr.write(`${message}\n`);
}

interface Classified {
  code: string;
  message: string;
  exit: number;
}

function classify(error: unknown): Classified {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConnectionError) return { code: error.code, message, exit: error.exitCode };
  if (error instanceof HostStoreError) return { code: 'HOST_STORE', message, exit: EXIT.USAGE };
  if (error instanceof HostCliError) return { code: `HOST_CLI_${error.kind.toUpperCase()}`, message, exit: EXIT.HOST_CLI };
  const code = (error as { code?: unknown })?.code;
  if (code === 'SESSION_NOT_FOUND') return { code, message, exit: EXIT.NOT_FOUND };
  if (code === 'NOT_LOGGED_IN') return { code, message, exit: EXIT.NOT_LOGGED_IN };
  if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) {
    const exit = (error as { exitCode?: unknown }).exitCode;
    return { code, message, exit: typeof exit === 'number' ? exit : EXIT.ERROR };
  }
  return { code: 'ERROR', message, exit: EXIT.ERROR };
}

/** Report a failure in the active output mode and return the exit status. */
export function fail(error: unknown): number {
  const { code, message, exit } = classify(error);
  if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  else process.stderr.write(`error: ${message}\n`);
  return exit;
}
