/**
 * Output discipline for an agent-friendly CLI.
 *
 * - `--json` (or PSC_JSON=1): exactly one JSON document on stdout per
 *   command; failures are `{"ok":false,"error":{"code","message",...}}` on
 *   stdout too, so an agent parses one stream. Human text never mixes in.
 * - Without it: readable text on stdout, `error: …` on stderr.
 * - Exit codes are stable (see EXIT below) in both modes.
 */
import { HostCliError, HostCliFailed } from '@pocketshell/core';
import { stripSystemdNoise } from './hostClient.js';
import { HostStoreError } from './hosts/store.js';
import { safeText } from './sanitize.js';
import { ConnectionError } from './transport/types.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_LOGGED_IN: 3,
  CONNECT: 4,
  NOT_FOUND: 5,
  HOST_CLI: 6,
  /** Same as coreutils `timeout`. */
  TIMEOUT: 124,
} as const;

let jsonMode = process.env.PSC_JSON === '1';

export function setJsonMode(value: boolean): void {
  jsonMode = jsonMode || value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * A failure with an explicit machine code, exit status and optional extra
 * fields for the JSON error document (`details` is merged into `error`).
 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = EXIT.ERROR,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** A usage error (bad flags or arguments): code USAGE, exit 2. */
export function usageError(message: string): CliError {
  return new CliError('USAGE', message, EXIT.USAGE);
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

export interface Classified {
  code: string;
  message: string;
  exit: number;
  details?: Record<string, unknown>;
}

/** `error`, its `cause`, the cause's cause … (bounded, cycle-safe). */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function codeOf(error: unknown): string | null {
  // Node system errors (`ENOENT`, `EPIPE`) carry `errno`; they are not our codes.
  if (typeof (error as { errno?: unknown } | null)?.errno === 'number') return null;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : null;
}

function detailsOf(error: unknown): Record<string, unknown> | undefined {
  const details = (error as { details?: unknown } | null)?.details;
  return details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined;
}

/** A core HostCliFailed message whose detail is systemd-run's banner gets the real stderr line instead. */
function hostCliMessage(error: HostCliError): string {
  if (!(error instanceof HostCliFailed) || !/Running (?:scope )?as unit/.test(error.message)) return error.message;
  const detail = stripSystemdNoise(error.stderr).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return `\`${error.command}\` failed on the host (exit ${error.exitCode})${detail ? `: ${detail.slice(0, 200)}` : '.'}`;
}

function classifyOne(error: unknown): Classified | null {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConnectionError) return { code: error.code, message, exit: error.exitCode };
  if (error instanceof HostStoreError) return { code: 'HOST_STORE', message, exit: EXIT.USAGE };
  if (error instanceof HostCliError) {
    if (error instanceof HostCliFailed && error.timedOut) {
      return { code: 'TIMEOUT', message: `${message} It may still complete on the host.`, exit: EXIT.TIMEOUT };
    }
    return { code: `HOST_CLI_${error.kind.toUpperCase()}`, message: hostCliMessage(error), exit: EXIT.HOST_CLI };
  }
  const code = codeOf(error);
  if (code === null) return null;
  const details = detailsOf(error);
  const fixed: Record<string, number> = {
    SESSION_NOT_FOUND: EXIT.NOT_FOUND,
    SESSION_AMBIGUOUS: EXIT.NOT_FOUND,
    NOT_LOGGED_IN: EXIT.NOT_LOGGED_IN,
    USAGE: EXIT.USAGE,
    TIMEOUT: EXIT.TIMEOUT,
  };
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  const exit = fixed[code] ?? (typeof exitCode === 'number' ? exitCode : EXIT.ERROR);
  return { code, message, exit, ...(details ? { details } : {}) };
}

/**
 * Map any thrown value to {code, message, exit}. Core wraps transport
 * failures in HostCliFailed (with the original as `cause`), so the cause
 * chain is searched first: a ConnectionError or another typed error (e.g.
 * NOT_LOGGED_IN from the gateway) underneath wins over the generic wrapper.
 */
export function classify(error: unknown): Classified {
  const chain = causeChain(error);
  for (const inner of chain.slice(1)) {
    if (inner instanceof ConnectionError || (codeOf(inner) !== null && !(inner instanceof HostCliError))) {
      const found = classifyOne(inner);
      if (found) return found;
    }
  }
  return (
    classifyOne(error) ?? { code: 'ERROR', message: error instanceof Error ? error.message : String(error), exit: EXIT.ERROR }
  );
}

/** Report a failure in the active output mode and return the exit status. */
export function fail(error: unknown): number {
  const { code, message, exit, details } = classify(error);
  if (jsonMode) {
    const { code: _c, message: _m, ...extra } = details ?? {};
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, ...extra } })}\n`);
  } else {
    process.stderr.write(`error: ${safeText(message).trimEnd()}\n`);
  }
  return exit;
}
