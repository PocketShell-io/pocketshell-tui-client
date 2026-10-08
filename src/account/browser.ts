/** Best-effort "open this URL in a browser" for `login`. */
import { spawn } from 'node:child_process';
import { httpsUrl } from './sanitize.js';

/**
 * Whether opening a browser makes sense here: stdout is a TTY, and this is
 * not a headless remote shell (SSH_CONNECTION without DISPLAY/WAYLAND_DISPLAY).
 */
export function canOpenBrowser(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  if (process.env.SSH_CONNECTION && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

/** Spawn `xdg-open`/`open` detached with stdio ignored. Never throws; https URLs only. */
export function openBrowser(url: string): void {
  if (httpsUrl(url) === null) return;
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // a browser is a convenience only
  }
}
