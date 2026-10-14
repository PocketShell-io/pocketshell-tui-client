/** Explicit stage names only: never argv, tokens, session text, or remote diagnostics. */
import { performance } from 'node:perf_hooks';
export type Stage = 'client_entry' | 'ipc' | 'auth_mint' | 'wss_ready' | 'ssh_authenticated' | 'helper_ready' | 'request_dispatch' | 'pty_write_complete' | 'output_exit' | 'offline_cache_hit';
const start = performance.now();
export function trace(stage: Stage): void {
  if (process.env.PSC_TRACE !== '1') return;
  process.stderr.write(JSON.stringify({ psc_trace: 1, stage, elapsedMs: +(performance.now()-start).toFixed(3) })+'\n');
}
