/**
 * The terminal side of the TUI: alternate screen, raw mode, cursor, and a
 * line-diffing frame writer. Restoring is idempotent and has a synchronous
 * variant for `exit`/crash handlers, so the user's shell is never left in
 * raw mode or on the alternate screen.
 */
import { writeSync } from 'node:fs';

export const CSI = '\x1b[';
const ENTER = `${CSI}?1049h${CSI}?25l${CSI}?7l${CSI}2J${CSI}H`;
const LEAVE = `${CSI}0m${CSI}?7h${CSI}?25h${CSI}?1049l`;

export class Terminal {
  private active = false;
  private previous: string[] = [];

  constructor(
    readonly input: NodeJS.ReadStream,
    readonly output: NodeJS.WriteStream,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  size(): { width: number; height: number } {
    return { width: this.output.columns || 80, height: this.output.rows || 24 };
  }

  /** Alternate screen, hidden cursor, no autowrap, raw input. */
  enter(): void {
    if (this.active) return;
    this.active = true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.output.write(ENTER);
    this.previous = [];
  }

  /** Back to the user's screen and cooked mode. Safe to call twice. */
  leave(): void {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.input.isTTY) this.input.setRawMode(false);
    } catch {
      /* the tty may already be gone (SIGHUP) */
    }
    try {
      this.output.write(LEAVE);
    } catch {
      /* ditto */
    }
    this.previous = [];
  }

  /** Last-resort restore from `exit` / crash handlers: synchronous, never throws. */
  leaveSync(): void {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.input.isTTY) this.input.setRawMode(false);
    } catch {
      /* ignore */
    }
    try {
      writeSync((this.output as unknown as { fd?: number }).fd ?? 1, LEAVE);
    } catch {
      /* ignore */
    }
  }

  /** Forget what is on screen so the next draw repaints everything. */
  invalidate(): void {
    this.previous = [];
  }

  /** Draw a frame, rewriting only the lines that changed. */
  draw(lines: string[]): void {
    if (!this.active) return;
    let out = '';
    const full = this.previous.length !== lines.length;
    if (full) out += `${CSI}0m${CSI}2J`;
    lines.forEach((line, row) => {
      if (!full && this.previous[row] === line) return;
      out += `${CSI}${row + 1};1H${CSI}0m${CSI}2K${line}`;
    });
    if (out) this.output.write(out);
    this.previous = lines;
  }
}

/** NO_COLOR (any non-empty value) drops colors; a dumb terminal gets no escapes in content. */
export function colorModeFromEnv(env: NodeJS.ProcessEnv = process.env): 'full' | 'mono' {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'mono';
  if (env.TERM === 'dumb') return 'mono';
  return 'full';
}
