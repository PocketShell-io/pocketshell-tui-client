/** Installer-only bridge to the maintained Windows native authority. */
import { callNative } from '../dist/platform/windows.js';
try {
  const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  if (!['preflight', 'check-executable'].includes(request.op)) throw new Error('unsupported operation');
  callNative(request);
} catch {
  process.stderr.write('PSC native security preflight refused\n');
  process.exitCode = 1;
}
