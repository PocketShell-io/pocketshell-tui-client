import { AsyncLocalStorage } from 'node:async_hooks';
export interface RequestContext {
  json: boolean;
  transportPath?: 'resident' | 'legacy';
  presenceAgeMs?: number | null;
  freshness?: { generation: string; ageMs: number; processAgeMs?: number };
  stdin: string;
  tty: boolean;
  exitCode: number;
  signal: AbortSignal;
  write: (stream: 'stdout' | 'stderr', text: string) => void;
}
export const requests = new AsyncLocalStorage<RequestContext>();
export function writeOutput(stream: 'stdout' | 'stderr', text: string): void {
  const context = requests.getStore();
  if (context) context.write(stream, text);
  else process[stream].write(text);
}
export function setExitCode(code: number): void {
  const context = requests.getStore();
  if (context) context.exitCode = code;
  else process.exitCode = code;
}
